/**
 * Harness adapter: OpenCode — sessions in a local SQLite database.
 *
 * Primary store is `opencode.db` (WAL mode, so concurrent readers are safe while
 * the app runs): `~/.local/share/opencode/opencode.db`, overridable with
 * `$OPENCODE_DB`. Parent ids are retained so standalone OpenCode delegations remain visible;
 * a dedicated wrapper such as Rhythm may claim a row through the scanner's evidence-based
 * deduplication without hiding unrelated OpenCode sessions.
 *
 * Read-only, without exception, and no subprocess anywhere. There is no
 * per-session deep link upstream, so opening a thread is honestly refused and
 * starting one goes through the registered `opencode://new-session` handler.
 */
import path from 'node:path'
import os from 'node:os'
import fsp from 'node:fs/promises'
import { exists, findExecutable, num } from '../lib/fsutil.mjs'

const HOME = os.homedir()

/**
 * Where `opencode.db` lives. `$OPENCODE_DB` wins when it names a file that is
 * actually there — otherwise the XDG path, then the macOS Application Support
 * fallback on darwin only. Resolved per call so pointing the var at a fixture
 * (or installing the app) is picked up on the next poll.
 */
async function dbPath() {
  const override = process.env.OPENCODE_DB
  // When set, the override is the whole answer: a missing file means "absent",
  // not "fall back to the default and read a database the user did not name".
  // That is also what makes fixture tests isolate from the real store.
  if (typeof override === 'string' && override) return (await exists(override)) ? override : ''
  const xdg = process.env.XDG_DATA_HOME
  if (typeof xdg === 'string' && xdg) {
    const p = path.join(xdg, 'opencode', 'opencode.db')
    if (await exists(p)) return p
  }
  const shared = path.join(HOME, '.local', 'share', 'opencode', 'opencode.db')
  if (await exists(shared)) return shared
  if (process.platform === 'darwin') {
    const mac = path.join(HOME, 'Library', 'Application Support', 'opencode', 'opencode.db')
    if (await exists(mac)) return mac
  }
  return ''
}

/**
 * `node:sqlite` is imported lazily and its absence is survivable.
 *
 * It needs Node 22.13, which `package.json` asks for — but asking is not
 * enforcing, and a top level import would take the whole server down on an
 * older Node rather than costing one harness. This way every other harness
 * keeps working and `diagnostic()` explains the gap.
 */
let sqlitePromise
const sqliteApi = () => (sqlitePromise ??= import('node:sqlite').catch(() => null))

/** Prefixed, per the contract in `server/harnesses/README.md`. */
const ID = (raw) => `opencode:${raw}`

/** OpenCode writes nothing when it is killed, so an open turn needs a time bound too. */
const ACTIVE_WINDOW_MS = 30 * 60 * 1000

const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim()

function parseModel(raw) {
  if (!raw) return { model: '', effort: '' }
  try {
    const m = typeof raw === 'string' ? JSON.parse(raw) : raw
    return {
      model: typeof m?.id === 'string' ? m.id : '',
      effort: typeof m?.variant === 'string' ? m.variant : ''
    }
  } catch {
    return { model: '', effort: '' }
  }
}

function projectOf(directory) {
  const dir = typeof directory === 'string' ? directory : ''
  if (!dir) return { projectPath: '', project: 'unknown', cwd: '' }
  // Both separators: a Windows directory arrives with either, and `basename`
  // on one OS must still read a path written on another (tests use posix).
  const base = path.basename(dir.replace(/\\/g, '/'))
  return { projectPath: dir, project: base || 'unknown', cwd: dir }
}

let scanCache = null

async function dbSignature(file) {
  const one = async (candidate) => {
    try {
      const stat = await fsp.stat(candidate)
      return `${stat.size}:${stat.mtimeMs}`
    } catch {
      return '-'
    }
  }
  return `${await one(file)}|${await one(`${file}-wal`)}`
}

/**
 * Whether an error-status tool part means the run failed.
 *
 * Seen in the wild: `The user rejected permission to use this specific tool
 * call.` and `Tool execution aborted` — both are the user stopping the turn,
 * not the turn failing. Only a genuine failure reddens an astronaut.
 */
function isRealError(raw) {
  let text = ''
  try {
    const d = typeof raw === 'string' ? JSON.parse(raw) : raw
    const state = d?.state || {}
    text = `${state.error || ''}\n${state.output || ''}`
  } catch {
    return true
  }
  return !/user rejected permission|permission.{0,20}denied|denied.{0,20}permission|execution aborted|aborted|cancelled/i.test(text)
}

const blankFacts = () => ({
  preview: '',
  activity: 'unknown',
  running: null,
  activityEvidence: 'OpenCode turn state unavailable',
  hasError: false,
  // A full SUM(LENGTH(data)) over a multi-gigabyte store blocks the server for seconds. Older
  // sessions remain zero; a bounded recent set is measured below.
  sizeBytes: 0,
})

async function rowsInBatches(db, ids, select) {
  const rows = []
  const batchSize = 400
  for (let at = 0; at < ids.length; at += batchSize) {
    const batch = ids.slice(at, at + batchSize)
    const placeholders = batch.map(() => '?').join(', ')
    rows.push(...db.prepare(select(placeholders)).all(...batch))
    // DatabaseSync is synchronous. Yield between bounded indexed queries so an HTTP response is
    // not starved throughout a cold scan on a large store.
    await new Promise((resolve) => setImmediate(resolve))
  }
  return rows
}

/** One indexed metadata pass replaces four transcript queries per session. */
async function bulkSessionFacts(db, sessions) {
  const facts = new Map(sessions.map((row) => [row.id, blankFacts()]))
  const sessionById = new Map(sessions.map((row) => [row.id, row]))
  const last = new Map()
  try {
    const lastRows = db.prepare(`
      SELECT m.session_id, m.id, m.data
      FROM message m
      JOIN (SELECT session_id, MAX(time_created) AS edge FROM message GROUP BY session_id) x
        ON x.session_id = m.session_id AND x.edge = m.time_created
      ORDER BY m.time_created, m.rowid
    `).all()
    for (const row of lastRows) last.set(row.session_id, row)
  } catch {
    return facts
  }

  // The session title is already the engine's compact first-turn label. Reading the original
  // prompt for every historical row transfers tens of megabytes on a cold scan; leave preview
  // empty here and reserve transcript text for an eventual on-demand detail endpoint.

  // Building progress only needs a useful current scale. Exact transcript bytes for every old
  // row requires scanning gigabytes; measure the 200 most recently updated sessions in two
  // indexed grouped queries and leave older rows at zero until they become recent.
  const recentIds = [...sessions]
    .sort((a, b) => num(b.time_updated) - num(a.time_updated))
    .slice(0, 200)
    .map((row) => row.id)
  if (recentIds.length) {
    try {
      const placeholders = recentIds.map(() => '?').join(', ')
      for (const table of ['message', 'part']) {
        const sizes = db.prepare(`
          SELECT session_id, COALESCE(SUM(LENGTH(data)), 0) AS bytes
          FROM ${table}
          WHERE session_id IN (${placeholders})
          GROUP BY session_id
        `).all(...recentIds)
        for (const row of sizes) {
          const target = facts.get(row.session_id)
          if (target) target.sizeBytes += num(row.bytes)
        }
      }
    } catch {
      /* size is decoration; never lose a session over it */
    }
  }

  const terminalMessageIds = []
  for (const [sessionId, row] of last) {
    const target = facts.get(sessionId)
    const session = sessionById.get(sessionId)
    if (!target || !session) continue
    try {
      const data = JSON.parse(row.data)
      const completed = data?.time?.completed
      const finished = typeof data?.finish === 'string' && data.finish
      const msgError = typeof data?.error?.name === 'string' ? data.error.name : ''
      const aborted = /abort/i.test(msgError)
      const open = data?.role === 'user' || (data?.role === 'assistant' && !completed && !finished && !msgError)
      if (open && Date.now() - num(session.time_updated) < ACTIVE_WINDOW_MS) {
        target.activity = 'running'
        target.running = true
        target.activityEvidence = 'fresh OpenCode turn'
      } else if (!open) {
        target.activity = 'quiet'
        target.running = false
        target.activityEvidence = 'completed OpenCode turn'
      } else {
        target.activityEvidence = 'stale OpenCode turn'
      }
      if (data?.role === 'assistant' && (completed || finished || msgError)) {
        if (!aborted && msgError) target.hasError = true
        else if (!aborted && !msgError) terminalMessageIds.push(row.id)
      }
    } catch {
      /* malformed message */
    }
  }

  try {
    const errors = await rowsInBatches(db, terminalMessageIds, (slots) => `
      SELECT session_id,
             SUBSTR(json_extract(data, '$.state.error'), 1, 2048) AS state_error,
             SUBSTR(json_extract(data, '$.state.output'), 1, 2048) AS state_output
      FROM part
      WHERE message_id IN (${slots}) AND json_extract(data, '$.state.status') = 'error'
    `)
    for (const row of errors) {
      const target = facts.get(row.session_id)
      const bounded = { state: { error: row.state_error, output: row.state_output } }
      if (target && isRealError(bounded)) target.hasError = true
    }
  } catch {
    /* error adornment is optional */
  }
  return facts
}

async function scanThreads() {
  const file = await dbPath()
  if (!file) return []
  const sqlite = await sqliteApi()
  if (!sqlite?.DatabaseSync) return []
  const signature = await dbSignature(file)
  if (scanCache?.file === file && scanCache.signature === signature) {
    return scanCache.threads.map((thread) => ({ ...thread, ref: { ...thread.ref } }))
  }

  let db
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true })
  } catch {
    // A WAL database whose shared-memory file cannot be used refuses a
    // read-only open. Losing one harness beats losing the scan.
    return []
  }
  try {
    const tables = new Set(
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((r) => r.name)
    )
    if (!tables.has('session') || !tables.has('message') || !tables.has('part')) return []
    // Undocumented private state that drifts between versions — probe every
    // column before naming it, or one renamed column costs the whole harness.
    const cols = new Set(db.prepare(`PRAGMA table_info(session)`).all().map((r) => r.name))
    for (const need of ['id', 'directory', 'title', 'time_created', 'time_updated']) {
      if (!cols.has(need)) return []
    }
    const rows = db
      .prepare(
        `SELECT id, directory, title, agent, model, time_created, time_updated, time_archived, ${cols.has('parent_id') ? 'parent_id' : 'NULL AS parent_id'} FROM session ORDER BY time_updated DESC`
      )
      .all()
    const factsBySession = await bulkSessionFacts(db, rows)
    const out = []
    for (const r of rows) {
      if (typeof r.id !== 'string' || !r.id) continue
      const { projectPath, project, cwd } = projectOf(r.directory)
      const { model, effort } = parseModel(r.model)
      const facts = factsBySession.get(r.id) || blankFacts()
      const prompt = ''
      const title = clean(r.title) || prompt || 'Untitled thread'
      out.push({
        id: ID(r.id),
        title: title.slice(0, 120),
        preview: prompt.slice(0, 240),
        project,
        projectPath,
        // OpenCode has no worktree concept of its own, and guessing one from
        // the path would put a branch name on a thread that never had one.
        worktree: '',
        cwd,
        gitBranch: '',
        model,
        effort,
        createdAt: num(r.time_created),
        lastActivityAt: num(r.time_updated),
        // No focus history, so "have you looked at this" is unknowable — not false.
        lastFocusedAt: 0,
        unread: false,
        activity: facts.activity,
        running: facts.running,
        activityEvidence: facts.activityEvidence,
        hasError: facts.hasError,
        starred: false,
        routine: '',
        prState: '',
        archived: r.time_archived !== null && r.time_archived !== undefined,
        // Bytes, like every other harness: the field is a shared log scale
        // across the whole map, and a token count would make OpenCode
        // buildings taller than Claude ones for the same work.
        sizeBytes: facts.sizeBytes,
        source: typeof r.agent === 'string' ? r.agent : '',
        agentName: typeof r.agent === 'string' ? r.agent : '',
        profile: typeof r.agent === 'string' ? r.agent : '',
        parentId: typeof r.parent_id === 'string' && r.parent_id ? ID(r.parent_id) : null,
        canOpen: false,
        ref: { sessionId: r.id, cwd }
      })
    }
    scanCache = { file, signature, threads: out }
    return out.map((thread) => ({ ...thread, ref: { ...thread.ref } }))
  } catch {
    return []
  } finally {
    try {
      db.close()
    } catch {
      /* already gone */
    }
  }
}

/**
 * OpenCode registers `opencode://open-project` and `opencode://new-session`
 * and nothing that addresses a single session — inventing a route would be a
 * link that silently does nothing. Revealing the session list is the honest
 * offer, and the UI greys the button and shows this instead.
 */
function openThread(ref) {
  const id = ref?.sessionId
  // The type check matters wherever an id came back from the page:
  // `String([validId])` is that id, and it must not travel on as an array.
  if (typeof id !== 'string' || !id) {
    return { ok: false, error: 'No openable OpenCode session id on that thread' }
  }
  return {
    ok: false,
    error: 'OpenCode has no link to a single session — open the repo and pick it from the session list.'
  }
}

/**
 * Where the `opencode` CLI is, for a machine that needs the terminal fallback.
 * PATH first, then the places its installers put it — never inside an
 * application bundle. Only Linux asks: on macOS and Windows the deep link is
 * always answered, so the walk is wasted.
 */
const CLI_DIRS = [path.join(HOME, '.local', 'bin'), path.join(HOME, '.opencode', 'bin'), '/usr/local/bin', '/usr/bin']
const cliBinary = () => findExecutable('opencode', CLI_DIRS)

async function newSession(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) {
    return { ok: false, error: 'That folder is not somewhere OpenCode can open' }
  }
  const url = `opencode://new-session?${new URLSearchParams({ directory: dir })}`
  let command
  if (process.platform === 'linux') {
    const bin = await cliBinary()
    if (bin) command = { argv: [bin], cwd: dir }
  }
  return { ok: true, url, command }
}

async function detect() {
  return Boolean(await dbPath())
}

/**
 * Why a present OpenCode might still look thin. Without this the old-Node case
 * is invisible: the database is simply skipped, every thread is missing, and
 * nothing says why.
 */
async function diagnostic() {
  if (!(await dbPath())) return ''
  if (!(await sqliteApi())?.DatabaseSync) {
    return `OpenCode threads need Node 22.13 or newer for their sessions (running ${process.versions.node})`
  }
  return ''
}

export default {
  id: 'opencode',
  name: 'OpenCode',
  detect,
  diagnostic,
  scanThreads,
  openThread,
  newSession,
  paths: {}
}
