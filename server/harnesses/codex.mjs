/**
 * Harness adapter: Codex (OpenAI) — the desktop app, the VS Code extension and the CLI together.
 *
 * Two stores, deliberately merged rather than picked between, the same shape `claude-code.mjs`
 * ended up in:
 *
 *   - `~/.codex/state_<n>.sqlite` holds one row per thread — title, cwd, branch, model, effort,
 *     archived — which is everything the colony wants and none of it inferred.
 *   - `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` holds the transcript, which is the only
 *     source for how big a thread is and whether it is mid-turn, and the only source at all for
 *     a session the database has not caught up with.
 *
 * They join on the session id, which appears in the row, in the rollout's filename and in its
 * `session_meta` record. Reading only the database loses transcript size and any CLI session it
 * has not indexed; reading only the transcripts means reconstructing metadata the database
 * already has correct.
 *
 * Read-only, without exception, and the scan starts no subprocess. The only executable this
 * module ever names is the `codex` binary on the user's own PATH, handed to the server as an argv
 * for a terminal — nothing here runs anything. Codex has an archive of its own that only its CLI
 * can set, so archiving here is recorded in the colony alone — see the note on archiving in
 * `server/harnesses/README.md`.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { exists, findExecutable, jsonLines, listDirs, listFiles, num, readHead } from '../lib/fsutil.mjs'
import { codexDesktop } from '../lib/codex-desktop.mjs'

const HOME = os.homedir()
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, '.codex')
const SESSIONS_DIR = path.join(CODEX_HOME, 'sessions')
const SESSION_INDEX = path.join(CODEX_HOME, 'session_index.jsonl')

const HEAD_BYTES = 128 * 1024
const READ_BYTES = 64 * 1024
const MAX_DIRECT_LIFECYCLE_BYTES = 64 * 1024
/** Retain JSON structure and short keys while discarding potentially large private string bodies. */
const MAX_LIFECYCLE_SKELETON_CHARS = 64 * 1024
const MAX_JSON_STRING_CHARS = 2 * 1024
/** Codex writes nothing when it is killed, so a stale `task_started` needs a time bound too. */
const ACTIVE_WINDOW_MS = 30 * 60 * 1000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STATE_DB = /^state_(\d+)\.sqlite$/

/** Prefixed, per the contract in `server/harnesses/README.md`. */
const ID = (raw) => `codex:${raw}`

/**
 * `node:sqlite` is imported lazily and its absence is survivable.
 *
 * It needs Node 22.13, which `package.json` asks for — but asking is not enforcing, and a top
 * level import would take the whole server down on an older Node rather than costing one
 * harness. This way the transcript half still works and `diagnostic()` explains the rest.
 */
let sqlitePromise
const sqliteApi = () => (sqlitePromise ??= import('node:sqlite').catch(() => null))

/** The newest schema version, not the most recently touched WAL sibling. */
async function latestStateDatabase() {
  let entries
  try {
    entries = await fsp.readdir(CODEX_HOME, { withFileTypes: true })
  } catch {
    return ''
  }
  return (
    entries
      .filter((e) => e.isFile() && STATE_DB.test(e.name))
      .map((e) => ({ file: path.join(CODEX_HOME, e.name), version: Number(e.name.match(STATE_DB)[1]) }))
      .sort((a, b) => b.version - a.version)[0]?.file || ''
  )
}

/**
 * Every column is probed before it is named.
 *
 * This is undocumented private state that changes shape between Codex versions — the filename is
 * versioned precisely because it does. A `SELECT` naming a column that has gone throws and costs
 * the whole harness its threads, so anything not load-bearing is asked for only if it is there.
 */
const column = (columns, name, fallback = "''") => (columns.has(name) ? `t.${name}` : fallback)

function timeExpr(columns, ms, secs) {
  if (columns.has(ms) && columns.has(secs)) return `COALESCE(t.${ms}, t.${secs} * 1000)`
  if (columns.has(ms)) return `t.${ms}`
  if (columns.has(secs)) return `t.${secs} * 1000`
  return '0'
}

/** The thread index, keyed by session id. Empty when there is no readable database. */
async function databaseRows() {
  const [file, sqlite] = await Promise.all([latestStateDatabase(), sqliteApi()])
  if (!file || !sqlite?.DatabaseSync) return new Map()

  let db
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true })
  } catch {
    // A WAL database whose shared-memory file cannot be used refuses a read-only open. The
    // transcripts still answer everything the colony needs to draw something.
    return new Map()
  }
  try {
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)
    )
    if (!tables.has('threads')) return new Map()
    const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map((r) => r.name))
    if (!['id', 'cwd'].every((n) => columns.has(n))) return new Map()

    let edgeJoin = ''
    let edgeParent = "''"
    if (tables.has('thread_spawn_edges')) {
      const edge = new Set(db.prepare('PRAGMA table_info(thread_spawn_edges)').all().map((r) => r.name))
      if (edge.has('child_thread_id') && edge.has('parent_thread_id')) {
        edgeJoin = 'LEFT JOIN thread_spawn_edges e ON e.child_thread_id = t.id'
        edgeParent = 'e.parent_thread_id'
      }
    }

    const rows = db
      .prepare(`
        SELECT
          t.id,
          t.cwd,
          ${column(columns, 'title')} AS title,
          ${column(columns, 'preview')} AS preview,
          ${column(columns, 'first_user_message')} AS first_user_message,
          ${column(columns, 'source')} AS source,
          ${column(columns, 'thread_source')} AS thread_source,
          ${column(columns, 'agent_nickname')} AS agent_nickname,
          ${column(columns, 'agent_role')} AS agent_role,
          ${column(columns, 'git_branch')} AS git_branch,
          ${column(columns, 'model')} AS model,
          ${column(columns, 'reasoning_effort')} AS reasoning_effort,
          ${column(columns, 'rollout_path')} AS rollout_path,
          ${column(columns, 'archived', '0')} AS archived,
          ${edgeParent} AS parent_thread_id,
          ${timeExpr(columns, 'created_at_ms', 'created_at')} AS created_at_ms,
          ${timeExpr(columns, 'updated_at_ms', 'updated_at')} AS updated_at_ms
        FROM threads t
        ${edgeJoin}
      `)
      .all()
      .filter((r) => UUID.test(r.id || ''))

    return new Map(rows.map((r) => [r.id, r]))
  } catch {
    return new Map()
  } finally {
    try {
      db.close()
    } catch {
      /* already gone */
    }
  }
}

/** Every rollout transcript on disk, keyed by the session id in its filename. */
async function scanRollouts() {
  const byId = new Map()
  for (const year of await listDirs(SESSIONS_DIR)) {
    for (const month of await listDirs(year)) {
      for (const day of await listDirs(month)) {
        for (const file of await listFiles(day, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'))) {
          const id = /([0-9a-f-]{36})\.jsonl$/i.exec(file)?.[1]
          if (!id || !UUID.test(id)) continue
          try {
            const st = await fsp.stat(file)
            byId.set(id, { id, file, size: st.size, mtime: st.mtimeMs })
          } catch {
            /* vanished between listing and stat */
          }
        }
      }
    }
  }
  return byId
}

/** `thread_name` per session, when Codex has written one. Optional; transcripts are the truth. */
async function readIndex() {
  const out = new Map()
  try {
    for (const row of jsonLines(await fsp.readFile(SESSION_INDEX, 'utf8'))) {
      if (row?.id && UUID.test(row.id)) out.set(row.id, row)
    }
  } catch {
    /* no index — every field it carries has another source */
  }
  return out
}

const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim()

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((p) => (typeof p === 'string' ? p : p?.text || p?.input_text || '')).filter(Boolean).join('\n')
}

/** What the head of a transcript knows about itself, for a session the database has not indexed. */
function readHeadMeta(records) {
  const meta = {
    cwd: '',
    gitBranch: '',
    model: '',
    effort: '',
    createdAt: 0,
    prompt: '',
    parentId: '',
    threadSource: '',
    agentNickname: '',
    agentRole: '',
  }
  for (const r of records) {
    const p = r?.payload
    if (!p || typeof p !== 'object') continue
    if (r.type === 'session_meta') {
      const spawn = p.source?.subagent?.thread_spawn
      meta.cwd ||= p.cwd || ''
      meta.gitBranch ||= p.git?.branch || ''
      meta.createdAt ||= Date.parse(p.timestamp || r.timestamp || '') || 0
      meta.parentId ||=
        p.parent_thread_id || spawn?.parent_thread_id || ''
      meta.threadSource ||= p.thread_source || ''
      meta.agentNickname ||= p.agent_nickname || spawn?.agent_nickname || ''
      meta.agentRole ||= p.agent_role || spawn?.agent_role || ''
    } else if (r.type === 'turn_context') {
      meta.cwd = p.cwd || meta.cwd
      meta.model = p.model || meta.model
      meta.effort = p.effort || meta.effort
    } else if (r.type === 'response_item' && p.type === 'message' && p.role === 'user') {
      meta.prompt ||= clean(contentText(p.content))
    }
  }
  return meta
}

const LIFECYCLE_TYPES = new Set(['task_started', 'task_complete', 'turn_aborted'])

/**
 * Build a bounded, valid JSON skeleton for one record.
 *
 * Lifecycle records can be large because `task_complete.last_agent_message` is on the same line
 * as the marker. Keeping the complete line defeats the memory bound; skipping it leaves the
 * preceding `task_started` authoritative forever. This scanner retains JSON punctuation and
 * short strings (including keys and lifecycle values), replaces a long string with a one-character
 * placeholder, and validates string escapes as it goes. JSON.parse then provides the structural
 * check: marker-like words inside message text cannot become lifecycle evidence.
 */
class JsonSkeleton {
  constructor() {
    this.parts = []
    this.chars = 0
    this.string = null
    this.stringChars = 0
    this.stringOverflow = false
    this.escape = false
    this.unicode = 0
    this.invalid = false
  }

  add(value) {
    if (this.invalid) return
    this.chars += value.length
    if (this.chars > MAX_LIFECYCLE_SKELETON_CHARS) this.invalid = true
    else this.parts.push(value)
  }

  addString(value) {
    if (this.stringOverflow) return
    this.stringChars += value.length
    if (this.stringChars > MAX_JSON_STRING_CHARS) {
      this.stringOverflow = true
      this.string = null
    } else {
      this.string.push(value)
    }
  }

  push(text) {
    for (const char of text) {
      if (this.invalid) return
      if (this.string === null && !this.stringOverflow) {
        if (char === '"') {
          this.string = ['"']
          this.stringChars = 1
        } else {
          this.add(char)
        }
        continue
      }

      if (this.unicode) {
        if (!/[0-9a-f]/i.test(char)) {
          this.invalid = true
          return
        }
        this.addString(char)
        this.unicode -= 1
        continue
      }
      if (this.escape) {
        if (!['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u'].includes(char)) {
          this.invalid = true
          return
        }
        this.addString(char)
        this.escape = false
        if (char === 'u') this.unicode = 4
        continue
      }
      if (char === '\\') {
        this.addString(char)
        this.escape = true
      } else if (char === '"') {
        this.add(this.stringOverflow ? '"_"' : `${this.string.join('')}"`)
        this.string = null
        this.stringChars = 0
        this.stringOverflow = false
      } else if (char.charCodeAt(0) < 0x20) {
        this.invalid = true
        return
      } else {
        this.addString(char)
      }
    }
  }

  finish() {
    if (this.invalid || this.string !== null || this.stringOverflow || this.escape || this.unicode) return ''
    return this.parts.join('')
  }
}

function lifecycleJson(text) {
  try {
    const record = JSON.parse(text)
    const payload = record?.payload
    return record?.type === 'event_msg' && LIFECYCLE_TYPES.has(payload?.type)
      ? { type: payload.type, error: Boolean(payload.error) }
      : null
  } catch {
    return null
  }
}

/** Parse one complete JSONL record range without ever retaining its full string bodies. */
async function lifecycleRange(fh, start, end) {
  if (end <= start) return null
  if (end - start <= MAX_DIRECT_LIFECYCLE_BYTES) {
    const buf = Buffer.allocUnsafe(end - start)
    const { bytesRead } = await fh.read(buf, 0, buf.length, start)
    return bytesRead === buf.length ? lifecycleJson(buf.toString('utf8').trim()) : null
  }
  const skeleton = new JsonSkeleton()
  const decoder = new StringDecoder('utf8')
  let offset = start
  while (offset < end && !skeleton.invalid) {
    const want = Math.min(READ_BYTES, end - offset)
    const buf = Buffer.allocUnsafe(want)
    const { bytesRead } = await fh.read(buf, 0, want, offset)
    if (!bytesRead) return null
    skeleton.push(decoder.write(buf.subarray(0, bytesRead)))
    offset += bytesRead
  }
  skeleton.push(decoder.end())
  const json = skeleton.finish()
  return json ? lifecycleJson(json) : null
}

/**
 * Find the newest lifecycle record by walking backwards over complete lines.
 *
 * Newline positions, rather than line contents, are retained during the reverse walk. Candidate
 * ranges are then fed through the bounded skeleton parser. A trailing partial record is skipped,
 * and its starting offset is returned so an incremental poll can retry it once it is complete.
 */
async function latestLifecycle(file, size) {
  if (!size) return { lifecycle: null, appendOffset: 0 }
  const fh = await fsp.open(file, 'r')
  let end = size
  let rightBoundary = null
  let appendOffset = 0
  try {
    while (end > 0) {
      const start = Math.max(0, end - READ_BYTES)
      const buf = Buffer.allocUnsafe(end - start)
      const { bytesRead } = await fh.read(buf, 0, buf.length, start)
      let cursor = bytesRead
      while (cursor > 0) {
        const found = buf.lastIndexOf(10, cursor - 1)
        if (found < 0) break
        cursor = found
        const newline = start + cursor
        if (rightBoundary === null) {
          rightBoundary = newline
          appendOffset = newline === size - 1 ? size : newline + 1
          continue
        }
        const lifecycle = await lifecycleRange(fh, newline + 1, rightBoundary)
        if (lifecycle) return { lifecycle, appendOffset }
        rightBoundary = newline
      }
      end = start
    }
    if (rightBoundary !== null) {
      const lifecycle = await lifecycleRange(fh, 0, rightBoundary)
      if (lifecycle) return { lifecycle, appendOffset }
    }
    return { lifecycle: null, appendOffset }
  } finally {
    await fh.close()
  }
}

/** Inspect complete records appended since the previous scan, retrying its trailing partial line. */
async function appendedLifecycle(file, start, size) {
  if (size <= start) return { lifecycle: null, appendOffset: start }
  const fh = await fsp.open(file, 'r')
  let offset = start
  let lineStart = start
  let last = null
  try {
    while (offset < size) {
      const want = Math.min(READ_BYTES, size - offset)
      const buf = Buffer.allocUnsafe(want)
      const { bytesRead } = await fh.read(buf, 0, want, offset)
      if (!bytesRead) break
      let cursor = -1
      while ((cursor = buf.indexOf(10, cursor + 1)) >= 0) {
        const newline = offset + cursor
        last = (await lifecycleRange(fh, lineStart, newline)) || last
        lineStart = newline + 1
      }
      offset += bytesRead
    }
    return { lifecycle: last, appendOffset: lineStart }
  } finally {
    await fh.close()
  }
}

/** Parsing is kept against mtime and size, so an unchanged transcript is read once. */
const parseCache = new Map()
async function transcriptFacts(entry, needHead) {
  const cached = parseCache.get(entry.id)
  if (cached && cached.mtime === entry.mtime && cached.size === entry.size && (cached.head || !needHead)) {
    return cached.facts
  }
  const canAppend = cached && cached.file === entry.file && entry.size > cached.size
  const facts = {
    lifecycle: canAppend ? cached.facts.lifecycle : null,
    meta: cached?.facts.meta || null,
  }
  let appendOffset = canAppend ? cached.appendOffset : 0
  try {
    if (canAppend) {
      const appended = await appendedLifecycle(entry.file, cached.appendOffset, entry.size)
      facts.lifecycle = appended.lifecycle || facts.lifecycle
      appendOffset = appended.appendOffset
    } else {
      const latest = await latestLifecycle(entry.file, entry.size)
      facts.lifecycle = latest.lifecycle
      appendOffset = latest.appendOffset
    }
    if (needHead && !facts.meta) facts.meta = readHeadMeta(jsonLines(await readHead(entry.file, HEAD_BYTES)))
  } catch {
    /* mid-write, or gone */
  }
  parseCache.set(entry.id, {
    file: entry.file,
    mtime: entry.mtime,
    size: entry.size,
    head: needHead || cached?.head,
    appendOffset,
    facts,
  })
  return facts
}

function projectOf(cwd) {
  const dir = typeof cwd === 'string' && path.isAbsolute(cwd) ? cwd : ''
  return { projectPath: dir, project: dir ? path.basename(dir) : 'unknown' }
}

function parentFromSource(source) {
  if (typeof source !== 'string' || !source.startsWith('{')) return ''
  try {
    return JSON.parse(source)?.subagent?.thread_spawn?.parent_thread_id || ''
  } catch {
    return ''
  }
}

/** Break one deterministic edge per cycle and mark parents that have not reached either store. */
function normaliseGraph(threads) {
  const byId = new Map(threads.map((thread) => [thread.id, thread]))
  for (const thread of threads) {
    if (thread.parentId && !byId.has(thread.parentId)) thread.orphaned = true
  }

  for (const start of [...threads].sort((a, b) => a.id.localeCompare(b.id))) {
    const path = []
    const at = new Map()
    let thread = start
    while (thread?.parentId && byId.has(thread.parentId)) {
      if (at.has(thread.id)) {
        const cycle = path.slice(at.get(thread.id)).sort((a, b) => a.id.localeCompare(b.id))
        const root = cycle[0]
        root.parentId = null
        root.orphaned = true
        root.relationshipError = 'cycle'
        break
      }
      at.set(thread.id, path.length)
      path.push(thread)
      thread = byId.get(thread.parentId)
    }
  }
  return threads
}

function activityOf(lifecycle, lastActivityAt, now) {
  if (lifecycle?.type === 'task_complete' || lifecycle?.type === 'turn_aborted') {
    return { activity: 'quiet', running: false }
  }
  if (lifecycle?.type === 'task_started' && now - lastActivityAt < ACTIVE_WINDOW_MS) {
    return { activity: 'running', running: true }
  }
  return { activity: 'unknown', running: null }
}

async function scanThreads() {
  const desktop = await codexDesktop()
  const [rows, rollouts, index, cli] = await Promise.all([
    databaseRows(),
    scanRollouts(),
    readIndex(),
    cliBinary(),
  ])
  const ids = new Set([...rows.keys(), ...rollouts.keys()])
  const now = Date.now()
  const out = []

  for (const id of ids) {
    const row = rows.get(id)
    const entry = rollouts.get(id)
    // The head is only worth reading for a session the database cannot describe.
    const facts = entry ? await transcriptFacts(entry, !row) : { lifecycle: null, meta: null }
    const meta = facts.meta || {}

    const cwd = row?.cwd || meta.cwd || ''
    const { projectPath, project } = projectOf(cwd)
    const prompt = clean(row?.preview || row?.first_user_message || meta.prompt || '')
    const lastActivityAt = Math.max(num(row?.updated_at_ms), entry?.mtime || 0)
    const parent = row?.parent_thread_id || parentFromSource(row?.source) || meta.parentId || ''
    const agentNickname = clean(row?.agent_nickname || meta.agentNickname || '').slice(0, 120)
    const agentRole = clean(row?.agent_role || meta.agentRole || '').slice(0, 120)
    const workerLabel = [agentNickname, agentRole]
      .filter((value, index, values) => value && !values.slice(0, index).some((prior) => prior.toLowerCase() === value.toLowerCase()))
      .join(' · ')
    const isWorker = UUID.test(parent) || row?.thread_source === 'subagent' || meta.threadSource === 'subagent'
    const title =
      clean(row?.title) || clean(index.get(id)?.thread_name) || prompt || (isWorker && workerLabel) || 'Untitled thread'
    const activity = activityOf(facts.lifecycle, lastActivityAt, now)
    const cliAvailable = Boolean(cli)

    out.push({
      id: ID(id),
      title: title.slice(0, 120),
      preview: prompt.slice(0, 240),
      project,
      projectPath,
      // Codex has no worktree concept of its own, and guessing one from the path would put a
      // branch name on a thread that never had one.
      worktree: '',
      cwd,
      gitBranch: row?.git_branch || meta.gitBranch || '',
      model: row?.model || meta.model || '',
      effort: row?.reasoning_effort || meta.effort || '',
      createdAt: num(row?.created_at_ms) || meta.createdAt || entry?.mtime || 0,
      lastActivityAt,
      parentId: UUID.test(parent) ? ID(parent) : null,
      orphaned: false,
      // Codex records no focus history, so "have you looked at this" is unknowable — not false.
      lastFocusedAt: 0,
      unread: null,
      activity: activity.activity,
      running: activity.running,
      hasError: facts.lifecycle?.type === 'task_complete' && facts.lifecycle.error,
      starred: false,
      routine: '',
      prState: '',
      archived: row?.archived === 1 || row?.archived === true,
      // Bytes, like every other harness: the field is a shared log scale across the whole map,
      // and a token count would make Codex buildings taller than Claude ones for the same work.
      sizeBytes: entry?.size || 0,
      source: row?.source === 'vscode' ? 'vscode' : 'cli',
      threadSource: row?.thread_source || meta.threadSource || '',
      agentNickname,
      agentRole,
      canOpen: desktop.available || cliAvailable,
      canOpenReason: desktop.available ? 'Open this task in Codex' : cliAvailable
        ? 'Installed Codex CLI can resume the exact session UUID in its recorded cwd'
        : 'No verified opener is available: Codex desktop and CLI were not found',
      openCapabilities: {
        app: {
          available: desktop.available,
          verified: desktop.available,
          reason: desktop.available ? 'Open this task in Codex' : 'Codex desktop is not installed or not available on this platform; use Resume in terminal',
        },
        terminal: {
          available: cliAvailable,
          verified: cliAvailable,
          reason: cliAvailable
            ? 'Codex CLI help verifies resume accepts an exact session UUID; terminal launch was not exercised end to end'
            : 'Codex CLI was not found',
        },
      },
      ref: { sessionId: id, cwd },
    })
  }
  return normaliseGraph(out)
}

/**
 * Where the `codex` CLI is, for a page that would rather have a terminal than the app. PATH
 * first, then the places `npm i -g` and Homebrew put a binary that a server started from a
 * launcher would not see — never inside an application bundle.
 */
const CLI_DIRS = [
  path.join(HOME, '.local', 'bin'),
  path.join(HOME, '.npm-global', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
]
const cliBinary = () =>
  Object.hasOwn(process.env, 'BOT_CROSSING_CODEX_CLI')
    ? findExecutable(process.env.BOT_CROSSING_CODEX_CLI)
    : findExecutable('codex', CLI_DIRS)

/**
 * `codex://threads/<id>` is registered by the Codex desktop app; the OS opener does the rest.
 * `codex resume <id>` is the CLI's own way back into the same session, offered alongside for a
 * page that prefers a terminal. Nothing is run here — the server decides whether it is.
 */
async function openThread(ref) {
  const { sessionId: id, cwd } = ref || {}
  if (typeof id !== 'string' || !UUID.test(id)) {
    return { ok: false, error: 'No openable Codex session id on that thread' }
  }
  const bin = await cliBinary()
  const desktop = await codexDesktop()
  const command = bin ? { argv: [bin, 'resume', id], cwd: typeof cwd === 'string' ? cwd : '' } : undefined
  return {
    ok: true,
    url: `codex://threads/${id}`,
    command,
    appBundleId: desktop.bundleId,
    appUnavailableReason: desktop.available ? undefined : 'Codex desktop is not installed or not available on this platform; use Resume in terminal',
  }
}

async function newSession(dir) {
  const bin = await cliBinary()
  return {
    ok: true,
    url: `codex://threads/new?${new URLSearchParams({ path: dir })}`,
    command: bin ? { argv: [bin], cwd: dir } : undefined,
  }
}

/** Claim the machine if either store is there — a CLI-only install has no database. */
async function detect() {
  return (await exists(SESSIONS_DIR)) || Boolean(await latestStateDatabase())
}

/**
 * Why a present Codex might still look thin. Without this the Node case is invisible: the
 * database is simply skipped, every thread loses its title and model, and nothing says why.
 */
async function diagnostic() {
  if (!(await latestStateDatabase())) return ''
  if (!(await sqliteApi())?.DatabaseSync) {
    return `Codex threads need Node 22.13 or newer for their titles and models (running ${process.versions.node})`
  }
  return ''
}

export default {
  id: 'codex',
  name: 'Codex',
  detect,
  diagnostic,
  scanThreads,
  openThread,
  newSession,
  paths: { CODEX_HOME, SESSIONS_DIR },
}
