/**
 * H-1 contract fixtures for Hermes profile compatibility.
 *
 * The real harness stores are never opened here. Each test gets a synthetic HERMES_HOME with
 * the schema capability it is exercising, so a regression cannot migrate or rewrite user data.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const columns = `
  id TEXT PRIMARY KEY,
  title TEXT,
  model TEXT,
  source TEXT,
  cwd TEXT,
  git_branch TEXT,
  git_repo_root TEXT,
  started_at REAL,
  ended_at REAL,
  message_count INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  archived INTEGER DEFAULT 0,
  last_activity_at REAL,
  last_read_at REAL
`

async function makeHome() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-hermes-'))
  await fsp.mkdir(path.join(home, 'profiles'), { recursive: true })
  return home
}

function createStore(file, { hidden = false, leases = false, malformed = false } = {}) {
  const db = new DatabaseSync(file)
  if (malformed) {
    db.exec('CREATE TABLE sessions (not_an_id TEXT)')
    return db
  }
  db.exec(`CREATE TABLE sessions (${columns}${hidden ? ', hidden INTEGER NOT NULL DEFAULT 0' : ''})`)
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      active INTEGER NOT NULL DEFAULT 1
    )
  `)
  if (leases) {
    db.exec(`
      CREATE TABLE session_turn_leases (
        conversation_id TEXT PRIMARY KEY,
        holder TEXT NOT NULL,
        acquired_at REAL NOT NULL,
        expires_at REAL NOT NULL
      )
    `)
  }
  return db
}

function insertSession(db, {
  id,
  source = 'cli',
  startedAt = 100,
  endedAt = null,
  lastActivityAt = 200,
  hidden,
}) {
  const hasHidden = db.prepare('PRAGMA table_info(sessions)').all().some((row) => row.name === 'hidden')
  const names = ['id', 'title', 'source', 'cwd', 'started_at', 'ended_at', 'last_activity_at']
  const values = [id, id, source, '/tmp/hermes-project', startedAt, endedAt, lastActivityAt]
  if (hasHidden) {
    names.push('hidden')
    values.push(hidden ? 1 : 0)
  }
  db.prepare(`INSERT INTO sessions (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...values)
  db.prepare("INSERT INTO messages (session_id, role, content, active) VALUES (?, 'user', ?, 1)").run(id, `prompt for ${id}`)
}

async function addProfile(home, name, options) {
  const dir = path.join(home, 'profiles', name)
  await fsp.mkdir(dir, { recursive: true })
  return createStore(path.join(dir, 'state.db'), options)
}

async function loadHermes(home) {
  const before = process.env.HERMES_HOME
  process.env.HERMES_HOME = home
  try {
    const mod = await import(`../server/harnesses/hermes.mjs?fixture=${encodeURIComponent(home)}-${Date.now()}-${Math.random()}`)
    return mod.default
  } finally {
    if (before == null) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = before
  }
}

async function removeHome(home) {
  await fsp.rm(home, { recursive: true, force: true })
}

test('H-1a: profiles without sessions.hidden remain scannable beside the current schema', async () => {
  // Regression caught: preparing one fixed `s.hidden` query against an older profile aborts the
  // whole Hermes scan. The named old-profile assertion fails if capability detection regresses.
  const home = await makeHome()
  try {
    const main = createStore(path.join(home, 'state.db'), { hidden: true })
    insertSession(main, { id: 'main-visible' })
    insertSession(main, { id: 'main-hidden', hidden: true })
    main.close()

    const old = await addProfile(home, 'old-profile')
    insertSession(old, { id: 'old-visible' })
    old.close()

    const hermes = await loadHermes(home)
    const threads = await hermes.scanThreads()
    assert.deepEqual(threads.map((thread) => thread.id).sort(), [
      'hermes:main:main-visible',
      'hermes:old-profile:old-visible',
    ])
  } finally {
    await removeHome(home)
  }
})

test('H-1b: one malformed profile is isolated and named in Hermes diagnostics', async () => {
  // Regression caught: a prepare/all failure after open escapes the profile loop and discards all
  // Hermes threads. The later-profile assertion proves scanning continued past the broken store.
  const home = await makeHome()
  const warnings = []
  const warn = console.warn
  try {
    const main = createStore(path.join(home, 'state.db'), { hidden: true })
    insertSession(main, { id: 'main-visible' })
    main.close()
    ;(await addProfile(home, 'a-broken', { malformed: true })).close()
    const later = await addProfile(home, 'z-later')
    insertSession(later, { id: 'later-visible' })
    later.close()

    console.warn = (...args) => warnings.push(args.map(String).join(' '))
    const hermes = await loadHermes(home)
    const threads = await hermes.scanThreads()
    assert.deepEqual(threads.map((thread) => thread.id).sort(), [
      'hermes:main:main-visible',
      'hermes:z-later:later-visible',
    ])
    assert.match(await hermes.diagnostic(), /a-broken/)
    assert.ok(warnings.some((line) => line.includes('a-broken')))
  } finally {
    console.warn = warn
    await removeHome(home)
  }
})

test('H-1c: only an unexpired durable turn lease is positive running evidence', async () => {
  // Regression caught: `ended_at IS NULL` means an open conversation, not work in progress. The
  // null assertion keeps open-ended sessions honest; the lease assertion preserves real activity.
  const home = await makeHome()
  try {
    const now = Math.floor(Date.now() / 1000)
    const main = createStore(path.join(home, 'state.db'), { hidden: true, leases: true })
    insertSession(main, { id: 'leased', lastActivityAt: now })
    insertSession(main, { id: 'open-unknown', lastActivityAt: now })
    insertSession(main, { id: 'expired', lastActivityAt: now })
    insertSession(main, { id: 'finished', endedAt: now - 10, lastActivityAt: now - 10 })
    const lease = main.prepare('INSERT INTO session_turn_leases VALUES (?, ?, ?, ?)')
    lease.run('leased', 'pid=1:turn=test', now - 5, now + 300)
    lease.run('expired', 'pid=1:turn=old', now - 600, now - 1)
    main.close()

    const hermes = await loadHermes(home)
    const byId = new Map((await hermes.scanThreads()).map((thread) => [thread.id, thread]))
    assert.equal(byId.get('hermes:main:leased').running, true)
    assert.equal(byId.get('hermes:main:leased').activity, 'active')
    assert.equal(byId.get('hermes:main:leased').activityEvidence, 'turn-lease')
    assert.equal(byId.get('hermes:main:open-unknown').running, null)
    assert.equal(byId.get('hermes:main:open-unknown').activity, 'unknown')
    assert.equal(byId.get('hermes:main:open-unknown').activityEvidence, 'unavailable')
    assert.equal(byId.get('hermes:main:expired').running, null)
    assert.equal(byId.get('hermes:main:finished').running, false)
    assert.equal(byId.get('hermes:main:finished').activity, 'quiet')
    assert.equal(byId.get('hermes:main:finished').activityEvidence, 'ended')
  } finally {
    await removeHome(home)
  }
})

test('H-1d: cron rows are excluded without erasing stable pilot and profile identity', async () => {
  // Regression caught: treating a profile as absent because one source is excluded, or renaming
  // the legacy `main` pilot in ids, breaks saved archive/layout references.
  const home = await makeHome()
  try {
    const main = createStore(path.join(home, 'state.db'), { hidden: true })
    insertSession(main, { id: 'talkable', source: 'desktop', endedAt: 300 })
    insertSession(main, { id: 'scheduled', source: 'cron', endedAt: 300 })
    main.close()
    const named = await addProfile(home, 'dev-builder')
    insertSession(named, { id: 'build', source: 'kanban', endedAt: 300 })
    named.close()

    const hermes = await loadHermes(home)
    const threads = await hermes.scanThreads()
    assert.equal(threads.some((thread) => thread.id.endsWith(':scheduled')), false)
    const root = threads.find((thread) => thread.id === 'hermes:main:talkable')
    assert.equal(root.pilot, 'main')
    assert.equal(root.profile, 'default')
    const profile = threads.find((thread) => thread.id === 'hermes:dev-builder:build')
    assert.equal(profile.pilot, 'dev-builder')
    assert.equal(profile.profile, 'dev-builder')
  } finally {
    await removeHome(home)
  }
})
