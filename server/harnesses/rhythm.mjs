/**
 * Harness adapter: Rhythm — durable sessions in Rhythm's local SQLite store.
 *
 * Rhythm keeps its own stable session ids and maps them to the bundled OpenCode engine through
 * `sdk_session_id`. Both identities matter: the local id owns profile and parent relationships;
 * the engine id lets the scanner remove the raw OpenCode copy when, and only when, Rhythm proved
 * that mapping. The live API and engine are optional. This adapter is a read-only offline view.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { exists } from '../lib/fsutil.mjs'
import { rhythmDesktop, rhythmAppCommand, validRhythmSessionId } from '../lib/rhythm-desktop.mjs'

const HOME = os.homedir()
const ACTIVE_WINDOW_MS = 30 * 60 * 1000
const CLOCK_SKEW_MS = 5 * 60 * 1000
const ID = (raw) => `rhythm:${raw}`
const ENGINE_ID = (raw) => `opencode:${raw}`

let sqlitePromise
const sqliteApi = () => (sqlitePromise ??= import('node:sqlite').catch(() => null))

let cache = null
const diagnostics = new Map()

async function dbPath() {
  const override = process.env.RHYTHM_DB
  if (typeof override === 'string' && override) return (await exists(override)) ? override : ''
  if (process.platform !== 'darwin') return ''
  const file = path.join(HOME, 'Library', 'Application Support', 'Rhythm', 'rhythm.db')
  return (await exists(file)) ? file : ''
}

async function signature(file) {
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

const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim()

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || !value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function activityOf(status, lastActivityAt, now) {
  if (status === 'working' || status === 'starting') {
    const age = now - lastActivityAt
    if (lastActivityAt > 0 && age >= -CLOCK_SKEW_MS && age < ACTIVE_WINDOW_MS) {
      return { activity: 'running', running: true, activityEvidence: 'fresh persisted Rhythm status' }
    }
    return { activity: 'unknown', running: null, activityEvidence: 'stale persisted Rhythm status' }
  }
  if (['idle', 'resumable', 'closed', 'error'].includes(status)) {
    return { activity: 'quiet', running: false, activityEvidence: 'persisted Rhythm non-running status' }
  }
  return { activity: 'unknown', running: null, activityEvidence: 'unrecognized persisted Rhythm status' }
}

function projectOf(row) {
  const cwd = typeof row.cwd === 'string' ? row.cwd : ''
  const projectPath = typeof row.project_cwd === 'string' && row.project_cwd
    ? row.project_cwd
    : cwd
  const project = clean(row.project_name) || path.basename(projectPath.replace(/\\/g, '/')) || 'unknown'
  return { cwd, project, projectPath }
}

function normaliseGraph(threads) {
  const byId = new Map(threads.map((thread) => [thread.id, thread]))
  for (const thread of threads) {
    if (!thread.parentId) continue
    const parent = byId.get(thread.parentId)
    if (!parent) thread.orphaned = true
    else thread.parentTitle = parent.title
  }

  // Corrupt relationship data must not make the inspector's recursive tree disappear. Break one
  // stable edge per cycle and retain an explicit explanation on the promoted root.
  for (const start of [...threads].sort((a, b) => a.id.localeCompare(b.id))) {
    const chain = []
    const seen = new Map()
    let thread = start
    while (thread?.parentId && byId.has(thread.parentId)) {
      if (seen.has(thread.id)) {
        const cycle = chain.slice(seen.get(thread.id)).sort((a, b) => a.id.localeCompare(b.id))
        const root = cycle[0]
        root.parentId = null
        root.orphaned = true
        root.relationshipError = 'cycle'
        break
      }
      seen.set(thread.id, chain.length)
      chain.push(thread)
      thread = byId.get(thread.parentId)
    }
  }
  return threads
}

function cloneThreads(threads, desktop) {
  return threads.map((thread) => ({
    ...thread,
    canOpen: desktop.available && validRhythmSessionId(thread.ref.sessionId),
    navigationReason: desktop.reason,
    dedupeIds: [...thread.dedupeIds],
    openCapabilities: {
      app: { available: desktop.available && validRhythmSessionId(thread.ref.sessionId), verified: desktop.available && validRhythmSessionId(thread.ref.sessionId), reason: desktop.reason },
      terminal: { ...thread.openCapabilities.terminal },
    },
    ref: { ...thread.ref },
  }))
}

function columnExpr(columns, name, fallback = 'NULL') {
  return columns.has(name) ? `a.${name}` : fallback
}

async function scanThreads(options = {}) {
  const file = await dbPath()
  if (!file) return []
  const sqlite = await sqliteApi()
  if (!sqlite?.DatabaseSync) {
    diagnostics.set(file, `Rhythm threads need Node 22.13 or newer for SQLite (running ${process.versions.node})`)
    return []
  }

  const sig = await signature(file)
  const desktop = await rhythmDesktop()
  const customNow = Number.isFinite(options.now)
  if (!customNow && cache?.file === file && cache.signature === sig) return cloneThreads(cache.threads, desktop)

  let db
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true })
  } catch {
    diagnostics.set(file, 'Rhythm session database is present but cannot be opened read-only')
    return []
  }

  try {
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name)
    )
    if (!tables.has('agent_sessions')) {
      diagnostics.set(file, 'Rhythm session database has no agent_sessions table')
      return []
    }
    const columns = new Set(db.prepare('PRAGMA table_info(agent_sessions)').all().map((row) => row.name))
    const required = ['id', 'agent_kind', 'status', 'cwd', 'name', 'created_at', 'updated_at']
    const missing = required.filter((name) => !columns.has(name))
    if (missing.length) {
      diagnostics.set(file, `Rhythm session schema is missing: ${missing.join(', ')}`)
      return []
    }

    const projectColumns = tables.has('projects')
      ? new Set(db.prepare('PRAGMA table_info(projects)').all().map((row) => row.name))
      : new Set()
    const profileColumns = tables.has('agent_configs')
      ? new Set(db.prepare('PRAGMA table_info(agent_configs)').all().map((row) => row.name))
      : new Set()
    const canJoinProject = columns.has('project_id') && projectColumns.has('id')
    const canJoinProfile = columns.has('profile_id') && profileColumns.has('id')
    const p = (name, fallback = 'NULL') => canJoinProject && projectColumns.has(name) ? `p.${name}` : fallback
    const c = (name, fallback = 'NULL') => canJoinProfile && profileColumns.has(name) ? `c.${name}` : fallback
    const fields = [
      'a.id', 'a.agent_kind', 'a.status', 'a.cwd', 'a.name', 'a.created_at', 'a.updated_at',
      `${columnExpr(columns, 'last_preview')} AS last_preview`,
      `${columnExpr(columns, 'last_activity_at')} AS last_activity_at`,
      `${columnExpr(columns, 'task_title')} AS task_title`,
      `${columnExpr(columns, 'model_id')} AS session_model_id`,
      `${columnExpr(columns, 'archived_at')} AS archived_at`,
      `${columnExpr(columns, 'sdk_session_id')} AS sdk_session_id`,
      `${columnExpr(columns, 'parent_session_id')} AS parent_session_id`,
      `${columnExpr(columns, 'is_system', '0')} AS is_system`,
      `${columnExpr(columns, 'category', "'chat'")} AS category`,
      `${columnExpr(columns, 'delegation_depth', '0')} AS delegation_depth`,
      `${columnExpr(columns, 'worktree_name')} AS worktree_name`,
      `${columnExpr(columns, 'worktree_path')} AS worktree_path`,
      `${columnExpr(columns, 'worktree_branch')} AS worktree_branch`,
      `${columnExpr(columns, 'profile_id')} AS profile_id`,
      `${p('name')} AS project_name`, `${p('cwd')} AS project_cwd`, `${p('vcs_branch')} AS project_branch`,
      `${c('label')} AS profile_label`, `${c('model_id')} AS profile_model_id`,
      `${c('reasoning_effort')} AS profile_effort`, `${c('oc_agent')} AS profile_engine_agent`,
    ]
    const joins = [
      canJoinProject ? 'LEFT JOIN projects p ON p.id = a.project_id' : '',
      canJoinProfile ? 'LEFT JOIN agent_configs c ON c.id = a.profile_id' : '',
    ].filter(Boolean).join('\n')
    const rows = db.prepare(`SELECT ${fields.join(',\n')} FROM agent_sessions a ${joins}`).all()
    const now = customNow ? options.now : Date.now()
    const threads = []
    for (const row of rows) {
      if (typeof row.id !== 'string' || !row.id) continue
      const { cwd, project, projectPath } = projectOf(row)
      const lastActivityAt = timestamp(row.last_activity_at) || timestamp(row.updated_at) || timestamp(row.created_at)
      const activity = activityOf(row.status, lastActivityAt, now)
      const sdkSessionId = typeof row.sdk_session_id === 'string' && row.sdk_session_id
        ? row.sdk_session_id
        : ''
      const profileId = typeof row.profile_id === 'string' ? row.profile_id : ''
      const agentName = clean(row.agent_kind || row.profile_engine_agent)
      threads.push({
        id: ID(row.id),
        title: (clean(row.name) || clean(row.task_title) || 'Untitled thread').slice(0, 120),
        preview: clean(row.last_preview).slice(0, 240),
        project,
        projectPath,
        worktree: clean(row.worktree_name),
        cwd,
        gitBranch: clean(row.worktree_branch) || clean(row.project_branch),
        model: clean(row.session_model_id) || clean(row.profile_model_id),
        effort: clean(row.profile_effort),
        createdAt: timestamp(row.created_at),
        lastActivityAt,
        lastFocusedAt: 0,
        unread: null,
        ...activity,
        hasError: row.status === 'error',
        starred: false,
        routine: row.category === 'chat' ? '' : clean(row.category),
        prState: '',
        archived: row.archived_at !== null && row.archived_at !== undefined,
        sizeBytes: 0,
        source: 'rhythm',
        status: clean(row.status),
        category: clean(row.category) || 'chat',
        isSystem: Boolean(row.is_system),
        delegationDepth: Number(row.delegation_depth) || 0,
        parentId: typeof row.parent_session_id === 'string' && row.parent_session_id
          ? ID(row.parent_session_id)
          : null,
        agentName,
        engineAgentId: agentName,
        profile: clean(row.profile_label) || profileId || agentName || 'unknown',
        profileId,
        canOpen: false,
        navigationReason: 'Rhythm has no verified external link to an individual session.',
        openCapabilities: {
          app: { available: false, verified: false },
          terminal: { available: false, verified: false },
        },
        ref: { sessionId: row.id, sdkSessionId, cwd },
        dedupeIds: sdkSessionId ? [ENGINE_ID(sdkSessionId)] : [],
      })
    }
    diagnostics.set(file, '')
    const normalised = normaliseGraph(threads)
    if (!customNow) cache = { file, signature: sig, threads: normalised }
    return cloneThreads(normalised, desktop)
  } catch {
    diagnostics.set(file, 'Rhythm session database could not be read with the detected schema')
    return []
  } finally {
    try {
      db.close()
    } catch {
      /* already gone */
    }
  }
}

async function openThread(ref) {
  if (!validRhythmSessionId(ref?.sessionId)) {
    return { ok: false, error: 'No valid Rhythm session reference on that thread' }
  }
  const desktop = await rhythmDesktop()
  if (!desktop.available) return { ok: false, error: desktop.reason }
  return { ok: true, appCommand: rhythmAppCommand(desktop, ref.sessionId), note: 'Opened in Rhythm Electron' }
}

function newSession() {
  return { ok: false, error: 'Rhythm has no verified external link for creating a session.' }
}

async function detect() {
  return Boolean(await dbPath())
}

async function diagnostic() {
  const file = await dbPath()
  if (!file) return ''
  if (!(await sqliteApi())?.DatabaseSync) {
    return `Rhythm threads need Node 22.13 or newer for SQLite (running ${process.versions.node})`
  }
  if (!diagnostics.has(file)) await scanThreads()
  return diagnostics.get(file) || ''
}

export default {
  id: 'rhythm',
  name: 'Rhythm',
  detect,
  diagnostic,
  scanThreads,
  openThread,
  newSession,
  paths: {},
}
