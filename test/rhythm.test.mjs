/**
 * P3 acceptance contracts for Rhythm's durable local/engine session graph.
 *
 * Every database here is synthetic and temporary. The adapter must open it read-only and must
 * remain useful without either of Rhythm's live services.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import opencode from '../server/harnesses/opencode.mjs'
import { reconcileHarnessDuplicates } from '../server/scan.mjs'
import { withEnv } from './support/env.mjs'

const NOW = Date.parse('2026-09-18T20:00:00.000Z')

function createRhythmStore(file) {
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL,
      vcs_root TEXT, vcs_branch TEXT
    );
    CREATE TABLE agent_configs (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, model_id TEXT,
      oc_agent TEXT, reasoning_effort TEXT
    );
    CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY,
      agent_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      cwd TEXT NOT NULL,
      name TEXT NOT NULL,
      last_preview TEXT,
      last_activity_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      task_title TEXT,
      model_id TEXT,
      project_id TEXT,
      archived_at TEXT,
      sdk_session_id TEXT,
      parent_session_id TEXT,
      is_system INTEGER NOT NULL DEFAULT 0,
      category TEXT NOT NULL DEFAULT 'chat',
      delegation_depth INTEGER NOT NULL DEFAULT 0,
      worktree_name TEXT,
      worktree_path TEXT,
      worktree_branch TEXT,
      profile_id TEXT
    );
  `)
  db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?)').run(
    'project-1', 'Bot Crossing', '/repo/bot-crossing', '/repo/bot-crossing', 'main'
  )
  db.prepare('INSERT INTO agent_configs VALUES (?, ?, ?, ?, ?)').run(
    'profile-1', 'Rhythm Builder', 'gpt-6-astra', 'build', 'high'
  )
  return db
}

function insertRhythm(db, row) {
  const iso = (ms) => new Date(ms).toISOString()
  db.prepare(`INSERT INTO agent_sessions (
    id, agent_kind, status, cwd, name, last_preview, last_activity_at,
    created_at, updated_at, task_title, model_id, project_id, archived_at,
    sdk_session_id, parent_session_id, is_system, category, delegation_depth,
    worktree_name, worktree_path, worktree_branch, profile_id
  ) VALUES (${Array(22).fill('?').join(', ')})`).run(
    row.id,
    row.agentKind || 'build',
    row.status || 'idle',
    row.cwd || '/repo/bot-crossing',
    row.name || row.id,
    row.preview ?? 'sanitized preview',
    row.lastActivityAt === null ? null : iso(row.lastActivityAt ?? NOW),
    iso(row.createdAt ?? NOW - 60_000),
    iso(row.updatedAt ?? row.lastActivityAt ?? NOW),
    row.taskTitle ?? null,
    row.modelId ?? null,
    row.projectId === undefined ? 'project-1' : row.projectId,
    row.archived ? iso(NOW) : null,
    row.sdkSessionId ?? null,
    row.parentId ?? null,
    row.isSystem ? 1 : 0,
    row.category || 'chat',
    row.depth || 0,
    row.worktreeName ?? null,
    row.worktreePath ?? null,
    row.worktreeBranch ?? null,
    row.profileId === undefined ? 'profile-1' : row.profileId
  )
}

async function loadRhythm(file) {
  const adapter = await withEnv({ RHYTHM_DB: file }, async () =>
    (await import(`../server/harnesses/rhythm.mjs?fixture=${Date.now()}-${Math.random()}`)).default
  )
  return {
    ...adapter,
    scanThreads: (options) => withEnv({ RHYTHM_DB: file, BOT_CROSSING_NATIVE_OPENERS: path.join(path.dirname(file), 'no-openers.json') }, () => adapter.scanThreads(options)),
    diagnostic: () => withEnv({ RHYTHM_DB: file }, () => adapter.diagnostic()),
  }
}

async function makeRhythmFixture() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-rhythm-'))
  const file = path.join(home, 'rhythm.db')
  const db = createRhythmStore(file)
  return { home, file, db, cleanup: () => fsp.rm(home, { recursive: true, force: true }) }
}

test('P3-1: Rhythm local rows form one flat nested graph and expose only proven engine dedupe ids', async () => {
  // Regression caught: scanning Rhythm roots plus the raw OpenCode database duplicates mapped
  // workers, while filtering every OpenCode row erases unrelated standalone sessions.
  const fx = await makeRhythmFixture()
  const ocHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-rhythm-opencode-'))
  const ocFile = path.join(ocHome, 'opencode.db')
  try {
    insertRhythm(fx.db, {
      id: 'local-root', sdkSessionId: 'engine-root', status: 'idle',
      cwd: '/repo/bot-crossing', worktreeName: 'main', worktreeBranch: 'main',
    })
    insertRhythm(fx.db, {
      id: 'local-child', sdkSessionId: 'engine-child', parentId: 'local-root', depth: 1,
      cwd: '/worktrees/child', worktreeName: 'child', worktreePath: '/worktrees/child',
      worktreeBranch: 'codex/child', taskTitle: 'Inspect engine mapping',
    })
    insertRhythm(fx.db, {
      id: 'local-grandchild', sdkSessionId: 'engine-grandchild', parentId: 'local-child', depth: 2,
      cwd: '/worktrees/child',
    })
    insertRhythm(fx.db, {
      id: 'local-only', sdkSessionId: null, parentId: 'missing-local-parent', profileId: null,
      agentKind: 'general', projectId: null, cwd: '/repo/unscoped',
    })
    fx.db.close()
    const before = await fsp.readFile(fx.file)

    const rhythm = await loadRhythm(fx.file)
    const threads = await rhythm.scanThreads({ now: NOW })
    const byId = new Map(threads.map((thread) => [thread.id, thread]))
    assert.equal(threads.length, 4)
    assert.equal(new Set(threads.map((thread) => thread.id)).size, 4)
    assert.equal(byId.get('rhythm:local-child').parentId, 'rhythm:local-root')
    assert.equal(byId.get('rhythm:local-grandchild').parentId, 'rhythm:local-child')
    assert.equal(byId.get('rhythm:local-only').orphaned, true)
    assert.deepEqual(byId.get('rhythm:local-root').dedupeIds, ['opencode:engine-root'])
    assert.deepEqual(byId.get('rhythm:local-child').dedupeIds, ['opencode:engine-child'])
    assert.deepEqual(byId.get('rhythm:local-only').dedupeIds, [])
    assert.equal(byId.get('rhythm:local-root').profile, 'Rhythm Builder')
    assert.equal(byId.get('rhythm:local-root').profileId, 'profile-1')
    assert.equal(byId.get('rhythm:local-root').agentName, 'build')
    assert.equal(byId.get('rhythm:local-child').cwd, '/worktrees/child')
    assert.equal(byId.get('rhythm:local-child').worktree, 'child')
    assert.equal(byId.get('rhythm:local-child').gitBranch, 'codex/child')
    assert.deepEqual(byId.get('rhythm:local-child').ref, {
      sessionId: 'local-child', sdkSessionId: 'engine-child', cwd: '/worktrees/child',
    })
    assert.deepEqual(await fsp.readFile(fx.file), before, 'read-only scan must not mutate Rhythm SQLite')

    const oc = new DatabaseSync(ocFile)
    oc.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
        directory TEXT NOT NULL, title TEXT NOT NULL, agent TEXT, model TEXT,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    `)
    const add = oc.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    add.run('engine-root', 'global', null, '/repo/bot-crossing', 'Mapped root', 'build', null, NOW, NOW, null)
    add.run('engine-child', 'global', 'engine-root', '/worktrees/child', 'Mapped child', 'build', null, NOW, NOW, null)
    add.run('standalone-root', 'global', null, '/repo/standalone', 'Standalone root', 'general', null, NOW, NOW, null)
    add.run('standalone-child', 'global', 'standalone-root', '/repo/standalone', 'Standalone child', 'general', null, NOW, NOW, null)
    oc.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
      'mapped-complete', 'engine-root', NOW, NOW,
      JSON.stringify({ role: 'assistant', time: { created: NOW, completed: NOW }, finish: 'stop' })
    )
    oc.close()
    const ocThreads = await withEnv({ OPENCODE_DB: ocFile }, () => opencode.scanThreads())
    assert.deepEqual(ocThreads.map((thread) => thread.id).sort(), [
      'opencode:engine-child', 'opencode:engine-root', 'opencode:standalone-child', 'opencode:standalone-root',
    ])
    assert.equal(
      ocThreads.find((thread) => thread.id === 'opencode:standalone-child').parentId,
      'opencode:standalone-root'
    )
    const combined = reconcileHarnessDuplicates([
      ...threads.map((thread) => ({ ...thread, harness: 'rhythm' })),
      ...ocThreads.map((thread) => ({ ...thread, harness: 'opencode' })),
    ])
    assert.equal(combined.some((thread) => thread.id === 'opencode:engine-root'), false)
    assert.equal(combined.some((thread) => thread.id === 'opencode:engine-child'), false)
    assert.equal(combined.some((thread) => thread.id === 'opencode:standalone-root'), true)
    assert.equal(combined.some((thread) => thread.id === 'opencode:standalone-child'), true)

    const staleCombined = reconcileHarnessDuplicates([
      ...threads.map((thread) => ({
        ...thread,
        harness: 'rhythm',
        stale: true,
        activity: 'unknown',
        running: null,
        activityEvidence: 'Scan failed; last successful observation retained',
      })),
      ...ocThreads.map((thread) => ({ ...thread, harness: 'opencode' })),
    ])
    const staleRootCopies = staleCombined.filter((thread) =>
      thread.id === 'rhythm:local-root' || thread.id === 'opencode:engine-root')
    assert.equal(staleRootCopies.length, 1, 'stale Rhythm plus current engine evidence remains one record')
    assert.equal(staleRootCopies[0].id, 'rhythm:local-root', 'stable local preferences keep their key')
    assert.equal(staleRootCopies[0].activity, 'quiet')
    assert.equal(staleRootCopies[0].running, false)
    assert.equal(staleRootCopies[0].staleMetadata, true)
    assert.match(staleRootCopies[0].activityEvidence, /Rhythm metadata stale.*OpenCode/i)
    assert.deepEqual(staleRootCopies[0].dedupeIds, ['opencode:engine-root'])
    assert.equal(staleCombined.some((thread) => thread.id === 'opencode:engine-child'), false)
    assert.equal(
      staleCombined.find((thread) => thread.id === 'rhythm:local-child').parentId,
      'rhythm:local-root',
      'the local parent graph survives while activity comes from the engine row'
    )
    assert.equal(staleCombined.some((thread) => thread.id === 'opencode:standalone-root'), true)
  } finally {
    try { fx.db.close() } catch {}
    await fx.cleanup()
    await fsp.rm(ocHome, { recursive: true, force: true })
  }
})

test('P3-2: persisted Rhythm identity and bounded activity remain honest while services are offline', async () => {
  // Regression caught: a stale `working` row was displayed as running forever after Rhythm quit,
  // and a missing profile erased the engine agent identity needed to explain the row.
  const fx = await makeRhythmFixture()
  try {
    insertRhythm(fx.db, { id: 'fresh', status: 'working', lastActivityAt: NOW - 60_000 })
    insertRhythm(fx.db, { id: 'stale', status: 'working', lastActivityAt: NOW - 6 * 60 * 60 * 1000 })
    insertRhythm(fx.db, { id: 'quiet', status: 'idle', lastActivityAt: NOW - 120_000 })
    insertRhythm(fx.db, { id: 'failed', status: 'error', profileId: null, agentKind: 'review' })
    fx.db.close()

    const rhythm = await loadRhythm(fx.file)
    const byId = new Map((await rhythm.scanThreads({ now: NOW })).map((thread) => [thread.id, thread]))
    assert.equal(byId.get('rhythm:fresh').activity, 'running')
    assert.equal(byId.get('rhythm:fresh').running, true)
    assert.equal(byId.get('rhythm:stale').activity, 'unknown')
    assert.equal(byId.get('rhythm:stale').running, null)
    assert.match(byId.get('rhythm:stale').activityEvidence, /stale.*persisted/i)
    assert.equal(byId.get('rhythm:quiet').activity, 'quiet')
    assert.equal(byId.get('rhythm:quiet').running, false)
    assert.equal(byId.get('rhythm:failed').hasError, true)
    assert.equal(byId.get('rhythm:failed').agentName, 'review')
    assert.match(byId.get('rhythm:fresh').activityEvidence, /persisted/i)
  } finally {
    try { fx.db.close() } catch {}
    await fx.cleanup()
  }
})

test('P3-3: unconfigured Rhythm keeps navigation unavailable instead of inventing a Flutter deep link', async () => {
  // Regression caught: treating the internal `agentSession:<id>` notification payload as an OS
  // URL produces an Open button that silently fails outside the already-running Flutter process.
  const fx = await makeRhythmFixture()
  try {
    insertRhythm(fx.db, { id: 'local-root', sdkSessionId: 'engine-root' })
    fx.db.close()
    const rhythm = await loadRhythm(fx.file)
    const [thread] = await rhythm.scanThreads({ now: NOW })
    assert.equal(thread.canOpen, false)
    assert.equal(thread.openCapabilities.app.available, false)
    assert.equal(thread.openCapabilities.app.verified, false)
    assert.match(thread.navigationReason, /not configured/i)
    assert.deepEqual(await withEnv({ BOT_CROSSING_NATIVE_OPENERS: path.join(fx.home, 'no-openers.json') }, () => rhythm.openThread(thread.ref)), {
      ok: false,
      error: 'Rhythm Electron opening is not configured. The installed Flutter app has no external session link.',
    })
    assert.equal(rhythm.newSession('/repo/bot-crossing').ok, false)
  } finally {
    try { fx.db.close() } catch {}
    await fx.cleanup()
  }
})
