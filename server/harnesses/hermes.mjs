/**
 * Harness adapter: Hermes Agent — the terminal and chat apps' session store.
 *
 * Reads the agent's own session store — the `sessions` table in
 * `~/.hermes/state.db`, opened read-only — plus a first-user-message preview
 * per session. One SQL pass per scan; a 500-session store answers in
 * milliseconds, so no mtime cache is needed.
 *
 * Hermes sessions live in the terminal and chat apps, which have no deep
 * link to hand back: `openThread` / `newSession` say so per the interface
 * and the UI greys those buttons out. Archiving flips the harness's own
 * `archived` flag with a single atomic UPDATE, so the thread lands in
 * Hermes's archived list rather than only disappearing here.
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = os.homedir()

/**
 * Where Hermes keeps its session store. HERMES_HOME wins everywhere; otherwise
 * a platform default — `~/.hermes` on POSIX (macOS matches Linux, no Darwin
 * special-case upstream) vs `%LOCALAPPDATA%\hermes` on native Windows. On
 * Windows an older `%USERPROFILE%\.hermes` layout still counts when it holds
 * the store; WSL2 follows the Linux layout.
 *
 * Pure and injectable so the matrix can be unit-tested without a Mac or
 * Windows box: platform/env/home/exists default to the live process values,
 * so the no-arg call IS the production probe.
 */
export function resolveHermesHome({ platform = process.platform, env = process.env, home = HOME, exists = fs.existsSync } = {}) {
  if (env.HERMES_HOME) return env.HERMES_HOME
  if (platform !== 'win32') return path.join(home, '.hermes')
  const modern = path.join(
    env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
    'hermes'
  )
  const legacy = path.join(home, '.hermes')
  if (!exists(path.join(modern, 'state.db')) && exists(path.join(legacy, 'state.db'))) {
    return legacy
  }
  return modern
}
const HERMES_HOME = resolveHermesHome()
const MAIN_DB = path.join(HERMES_HOME, 'state.db')
const PROFILES_DIR = path.join(HERMES_HOME, 'profiles')

/** Every bot that owns sessions: the default profile plus each named profile
 *  with its own session store. Pilot name doubles as the astronaut's identity. */
function pilotDBs() {
  const dbs = [{ pilot: 'main', file: MAIN_DB }]
  let dirs = []
  try {
    dirs = fs.readdirSync(PROFILES_DIR, { withFileTypes: true })
  } catch {
    return dbs
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name))
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const file = path.join(PROFILES_DIR, d.name, 'state.db')
    try {
      fs.accessSync(file, fs.constants.R_OK)
      dbs.push({ pilot: d.name, file })
    } catch {
      /* profile never ran — no astronaut until it has sessions */
    }
  }
  return dbs
}

const openRead = (file) => new DatabaseSync(file, { readOnly: true })

/** Failures are scoped to one profile, but still visible through `/api/harnesses`. */
let lastDiagnostics = []

const columnsOf = (db, table) =>
  new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name))

const selected = (columns, name, fallback = 'NULL') =>
  `${columns.has(name) ? `s.${name}` : fallback} AS ${name}`

/**
 * Hermes upgrades every profile independently. A profile that has not run since a new column or
 * table shipped therefore remains a valid store, not a reason to pin the query to the oldest
 * schema. Build the small differences from SQLite's own table metadata instead.
 */
function threadQuery(db) {
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name)
  )
  if (!tables.has('sessions')) throw new Error('missing sessions table')
  const sessions = columnsOf(db, 'sessions')
  if (!sessions.has('id')) throw new Error('sessions table is missing required id column')

  const fields = [
    ['id'],
    ['title'],
    ['model'],
    ['source', "''"],
    ['cwd', "''"],
    ['git_branch', "''"],
    ['git_repo_root', "''"],
    ['started_at', '0'],
    ['ended_at'],
    ['message_count', '0'],
    ['input_tokens', '0'],
    ['output_tokens', '0'],
    ['archived', '0'],
    ['last_activity_at'],
    ['last_read_at'],
  ].map(([name, fallback]) => selected(sessions, name, fallback))

  let firstUser = 'NULL AS first_user'
  if (tables.has('messages')) {
    const messages = columnsOf(db, 'messages')
    if (['session_id', 'role', 'content'].every((name) => messages.has(name))) {
      const active = messages.has('active') ? ' AND m.active = 1' : ''
      const order = messages.has('id') ? 'm.id' : messages.has('timestamp') ? 'm.timestamp' : 'm.rowid'
      firstUser = `(SELECT substr(m.content, 1, 280) FROM messages m
        WHERE m.session_id = s.id AND m.role = 'user'${active}
        ORDER BY ${order} ASC LIMIT 1) AS first_user`
    }
  }

  const leases = tables.has('session_turn_leases') ? columnsOf(db, 'session_turn_leases') : new Set()
  const hasTurnLeases = ['conversation_id', 'expires_at'].every((name) => leases.has(name))
  const turnActive = hasTurnLeases
    ? `EXISTS (SELECT 1 FROM session_turn_leases l
         WHERE l.conversation_id = s.id AND l.expires_at > unixepoch()) AS turn_active`
    : '0 AS turn_active'

  const where = []
  if (sessions.has('hidden')) where.push('COALESCE(s.hidden, 0) = 0')
  if (sessions.has('source')) where.push("COALESCE(s.source, '') != 'cron'")
  const recency = ['last_activity_at', 'ended_at', 'started_at']
    .filter((name) => sessions.has(name))
    .map((name) => `s.${name}`)
  const order = recency.length ? `COALESCE(${recency.join(', ')}, 0)` : 's.id'

  return `
    SELECT ${fields.join(',\n           ')},
           ${firstUser},
           ${turnActive}
      FROM sessions s
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${order} DESC
  `
}

function toThread(row, pilot) {
  const root = row.git_repo_root || row.cwd || ''
  // Sessions run from the agent home (or with no cwd) are all the same
  // project — don't let basename case/dirname split one bot into many.
  const home = HOME
  const isHome = !root || root === home || root === home + '/.hermes'
  const project = isHome ? 'Hermes' : path.basename(root)
  // Keep projectPath canonical too: the colony keys plots on (name, path),
  // so three spellings of home would be re-split into three plots downstream.
  const projectPath = isHome ? home : root
  const createdAt = Math.round((row.started_at || 0) * 1000)
  const lastActivityAt = Math.round(((row.last_activity_at || row.ended_at || row.started_at) || 0) * 1000)
  const tokens = (row.input_tokens || 0) + (row.output_tokens || 0)
  const running = row.turn_active === 1 ? true : row.ended_at != null ? false : null
  const activity = running === true ? 'active' : running === false ? 'quiet' : 'unknown'
  return {
    id: `hermes:${pilot}:${row.id}`,
    pilot,
    // Keep the legacy `main` pilot in ids/refs for saved layout compatibility while exposing
    // Hermes's canonical profile id to newer profile-aware views.
    profile: pilot === 'main' ? 'default' : pilot,
    title: row.title || 'Untitled thread',
    preview: (row.first_user || '').trim().slice(0, 280),
    project,
    projectPath,
    worktree: '',
    cwd: row.cwd || '',
    gitBranch: row.git_branch || '',
    model: row.model || '',
    effort: '',
    createdAt,
    lastActivityAt,
    lastFocusedAt: 0,
    running,
    activity,
    activityEvidence: activity === 'active' ? 'turn-lease' : activity === 'quiet' ? 'ended' : 'unavailable',
    unread: Boolean(
      row.last_activity_at && row.last_read_at && row.last_activity_at > row.last_read_at
    ),
    hasError: false,
    archived: row.archived === 1,
    sizeBytes: tokens > 0 ? tokens * 4 : (row.message_count || 0) * 500,
    source: row.source || '',
    canOpen: false,
    ref: { sessionId: row.id, pilot },
  }
}

async function detect() {
  try {
    openRead(MAIN_DB).close()
    return true
  } catch {
    return false
  }
}

async function scanThreads() {
  const out = []
  lastDiagnostics = []
  for (const { pilot, file } of pilotDBs()) {
    let db
    try {
      db = openRead(file)
    } catch (error) {
      const detail = `profile "${pilot}": ${error?.message || error}`
      lastDiagnostics.push(detail)
      console.warn(`bot-crossing: Hermes ${detail}`)
      continue
    }
    try {
      for (const row of db.prepare(threadQuery(db)).all()) out.push(toThread(row, pilot))
    } catch (error) {
      // Profiles are independent Hermes installations and upgrade independently. One unreadable
      // store costs only that pilot's threads; naming it here keeps partial success diagnosable.
      const detail = `profile "${pilot}": ${error?.message || error}`
      lastDiagnostics.push(detail)
      console.warn(`bot-crossing: Hermes ${detail}`)
    } finally {
      db.close()
    }
  }
  return out
}

function diagnostic() {
  return lastDiagnostics.length ? `Some Hermes profiles could not be read: ${lastDiagnostics.join('; ')}` : ''
}

function openThread() {
  return { ok: false, error: 'Hermes sessions live in the terminal and chat apps — there is no link to open.' }
}

function newSession() {
  return { ok: false, error: 'Hermes sessions start in the terminal, not from the colony.' }
}

export default {
  id: 'hermes',
  name: 'Hermes',
  detect,
  diagnostic,
  scanThreads,
  openThread,
  newSession,
}
