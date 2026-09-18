/**
 * Acceptance contracts for Codex's real session graph and lifecycle evidence.
 *
 * Every fixture lives under a temporary CODEX_HOME. A regression here must never need, or write
 * to, the user's Codex database and transcripts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { withEnv } from './support/env.mjs'

const IDS = {
  parent: '11111111-1111-4111-8111-111111111111',
  child: '22222222-2222-4222-8222-222222222222',
  grandchild: '33333333-3333-4333-8333-333333333333',
  orphan: '44444444-4444-4444-8444-444444444444',
  missing: '55555555-5555-4555-8555-555555555555',
  cycleA: '66666666-6666-4666-8666-666666666666',
  cycleB: '77777777-7777-4777-8777-777777777777',
}

const line = (type, payload, timestamp = new Date().toISOString()) =>
  JSON.stringify({ timestamp, type, payload })

const codexId = (id) => `codex:${id}`

async function fixture() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-codex-graph-'))
  const day = path.join(home, 'sessions', '2026', '09', '18')
  await fsp.mkdir(day, { recursive: true })

  const rollout = async (id, records) => {
    const file = path.join(day, `rollout-2026-09-18T12-00-00-${id}.jsonl`)
    await fsp.writeFile(file, records.join('\n') + '\n')
    return file
  }

  const state = (rows, edges = []) => {
    const db = new DatabaseSync(path.join(home, 'state_5.sqlite'))
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        rollout_path TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        archived INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER,
        updated_at_ms INTEGER,
        thread_source TEXT,
        agent_nickname TEXT,
        agent_role TEXT
      );
      CREATE TABLE thread_spawn_edges (
        parent_thread_id TEXT NOT NULL,
        child_thread_id TEXT NOT NULL PRIMARY KEY,
        status TEXT NOT NULL
      );
    `)
    const addThread = db.prepare(
      'INSERT INTO threads (id, cwd, rollout_path, title, archived, created_at_ms, updated_at_ms, thread_source, agent_nickname, agent_role) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    for (const row of rows) {
      addThread.run(
        row.id,
        row.cwd || '/tmp/exact-checkout',
        row.rolloutPath || '',
        row.title || '',
        row.archived ? 1 : 0,
        row.createdAt || Date.now(),
        row.updatedAt || Date.now(),
        row.threadSource || null,
        row.agentNickname || null,
        row.agentRole || null
      )
    }
    const addEdge = db.prepare(
      'INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status) VALUES (?, ?, ?)'
    )
    for (const edge of edges) addEdge.run(edge.parent, edge.child, edge.status || 'open')
    db.close()
  }

  const scan = async (env = {}) =>
    withEnv({ CODEX_HOME: home, BOT_CROSSING_CODEX_CLI: '', ...env }, async () => {
      const adapter = (await import(`../server/harnesses/codex.mjs?fixture=${encodeURIComponent(home)}`)).default
      return adapter.scanThreads()
    })

  return {
    home,
    rollout,
    state,
    scan,
    cleanup: () => fsp.rm(home, { recursive: true, force: true }),
  }
}

test('P2-1: nested, orphaned, cyclic and archived-parent Codex sessions appear exactly once', async () => {
  // Regression caught: filtering DB children and then unioning every rollout makes each worker a
  // second top-level conversation; blindly retaining a cycle makes recursive consumers loop.
  const fx = await fixture()
  try {
    const rows = []
    for (const id of Object.values(IDS).filter((id) => id !== IDS.missing)) {
      const file = await fx.rollout(id, [
        line('session_meta', { id, cwd: '/tmp/exact-checkout' }),
        line('event_msg', { type: 'task_complete' }),
      ])
      rows.push({ id, rolloutPath: file, archived: id === IDS.parent })
    }
    fx.state(rows, [
      { parent: IDS.parent, child: IDS.child },
      { parent: IDS.child, child: IDS.grandchild },
      { parent: IDS.missing, child: IDS.orphan },
      { parent: IDS.cycleB, child: IDS.cycleA },
      { parent: IDS.cycleA, child: IDS.cycleB },
    ])

    const threads = await fx.scan()
    const byId = new Map(threads.map((thread) => [thread.id, thread]))

    assert.equal(threads.length, rows.length)
    assert.equal(new Set(threads.map((thread) => thread.id)).size, rows.length)
    assert.equal(byId.get(codexId(IDS.parent)).archived, true)
    assert.equal(byId.get(codexId(IDS.child)).parentId, codexId(IDS.parent))
    assert.equal(byId.get(codexId(IDS.grandchild)).parentId, codexId(IDS.child))
    assert.equal(byId.get(codexId(IDS.orphan)).parentId, codexId(IDS.missing))
    assert.equal(byId.get(codexId(IDS.orphan)).orphaned, true)

    const cycleRoots = [IDS.cycleA, IDS.cycleB]
      .map((id) => byId.get(codexId(id)))
      .filter((thread) => !thread.parentId)
    assert.equal(cycleRoots.length, 1, 'one deterministic edge is broken so recursive consumers terminate')
    assert.equal(cycleRoots[0].relationshipError, 'cycle')

    const roots = threads.filter((thread) => !thread.parentId || thread.orphaned)
    assert.equal(roots.some((thread) => thread.id === codexId(IDS.child)), false)
    assert.equal(roots.some((thread) => thread.id === codexId(IDS.grandchild)), false)
  } finally {
    await fx.cleanup()
  }
})

test('P2-1: rollout metadata preserves a worker whose parent is not indexed yet', async () => {
  // Regression caught: a rollout-only worker loses session_meta.parent_thread_id and masquerades
  // as an ordinary conversation while SQLite is absent or behind.
  const fx = await fixture()
  try {
    await fx.rollout(IDS.child, [
      line('session_meta', {
        id: IDS.child,
        cwd: '/tmp/exact-checkout/nested',
        parent_thread_id: IDS.parent,
        thread_source: 'subagent',
        agent_nickname: 'Scout',
        agent_role: 'explorer',
      }),
      line('event_msg', { type: 'task_complete' }),
    ])

    const [thread] = await fx.scan()
    assert.equal(thread.parentId, codexId(IDS.parent))
    assert.equal(thread.orphaned, true)
    assert.equal(thread.cwd, '/tmp/exact-checkout/nested')
    assert.equal(thread.agentNickname, 'Scout')
    assert.equal(thread.agentRole, 'explorer')
    assert.equal(thread.title, 'Scout · explorer')
    assert.deepEqual(thread.ref, { sessionId: IDS.child, cwd: '/tmp/exact-checkout/nested' })
  } finally {
    await fx.cleanup()
  }
})

test('P2-1: indexed workers use nickname and role only when an explicit title is absent', async () => {
  const fx = await fixture()
  try {
    const childFile = await fx.rollout(IDS.child, [
      line('session_meta', { id: IDS.child, cwd: '/tmp/exact-checkout' }),
      line('event_msg', { type: 'task_complete' }),
    ])
    const grandchildFile = await fx.rollout(IDS.grandchild, [
      line('session_meta', { id: IDS.grandchild, cwd: '/tmp/exact-checkout' }),
      line('event_msg', { type: 'task_complete' }),
    ])
    fx.state(
      [
        { id: IDS.child, rolloutPath: childFile, agentNickname: 'Mapper', agentRole: 'researcher' },
        {
          id: IDS.grandchild,
          rolloutPath: grandchildFile,
          title: 'Verify navigation behavior',
          agentNickname: 'Verifier',
          agentRole: 'reviewer',
        },
      ],
      [
        { parent: IDS.parent, child: IDS.child },
        { parent: IDS.child, child: IDS.grandchild },
      ]
    )

    const byId = new Map((await fx.scan()).map((thread) => [thread.id, thread]))
    assert.equal(byId.get(codexId(IDS.child)).title, 'Mapper · researcher')
    assert.equal(byId.get(codexId(IDS.child)).agentNickname, 'Mapper')
    assert.equal(byId.get(codexId(IDS.child)).agentRole, 'researcher')
    assert.equal(byId.get(codexId(IDS.grandchild)).title, 'Verify navigation behavior')
    assert.equal(byId.get(codexId(IDS.grandchild)).agentNickname, 'Verifier')
    assert.equal(byId.get(codexId(IDS.grandchild)).agentRole, 'reviewer')
  } finally {
    await fx.cleanup()
  }
})

test('P2-2: oversized records and incremental appends preserve the latest lifecycle marker', async () => {
  // Regression caught: a fixed 64 KiB tail contains no complete line after a large tool result,
  // so an active turn is reported quiet and an appended completion is missed.
  const fx = await fixture()
  try {
    const file = await fx.rollout(IDS.parent, [
      line('session_meta', { id: IDS.parent, cwd: '/tmp/exact-checkout' }),
      line('event_msg', { type: 'task_started' }),
      line('response_item', { type: 'function_call_output', output: 'x'.repeat(256 * 1024) }),
    ])

    let [thread] = await fx.scan()
    assert.equal(thread.activity, 'running')
    assert.equal(thread.running, true)
    assert.equal(thread.unread, null)

    await fsp.appendFile(file, `${line('event_msg', { type: 'task_complete' })}\n{"incomplete":`)
    ;[thread] = await fx.scan()
    assert.equal(thread.activity, 'quiet')
    assert.equal(thread.running, false)
  } finally {
    await fx.cleanup()
  }
})

test('P2-2: a large completion payload settles the turn without matching lifecycle text in messages', async () => {
  // `last_agent_message` is carried on task_complete itself and can exceed the old 64 KiB line
  // cap. Lifecycle-looking text in an ordinary message must not compensate for skipping it.
  const fx = await fixture()
  try {
    const file = await fx.rollout(IDS.parent, [
      line('session_meta', { id: IDS.parent, cwd: '/tmp/exact-checkout' }),
      line('event_msg', { type: 'task_started' }),
      line('response_item', {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'event_msg task_complete turn_aborted' }],
      }),
    ])

    let [thread] = await fx.scan()
    assert.equal(thread.activity, 'running', 'lifecycle-looking message text is ignored')

    await fsp.appendFile(
      file,
      `${line('event_msg', {
        type: 'task_complete',
        error: 'e'.repeat(128 * 1024),
        last_agent_message: 'x'.repeat(256 * 1024),
      })}\n`
    )
    ;[thread] = await fx.scan()
    assert.equal(thread.activity, 'quiet')
    assert.equal(thread.running, false)
    assert.equal(thread.hasError, true, 'a discarded non-empty error string stays truthy')
  } finally {
    await fx.cleanup()
  }
})

test('P2-2: a terminal record split across incremental polls becomes authoritative only when complete', async () => {
  const fx = await fixture()
  try {
    const file = await fx.rollout(IDS.parent, [
      line('session_meta', { id: IDS.parent, cwd: '/tmp/exact-checkout' }),
      line('event_msg', { type: 'task_started' }),
    ])
    let [thread] = await fx.scan()
    assert.equal(thread.activity, 'running')

    const complete = `${line('event_msg', {
      type: 'task_complete',
      last_agent_message: 'y'.repeat(128 * 1024),
    })}\n`
    const split = Math.floor(complete.length / 2)
    await fsp.appendFile(file, complete.slice(0, split))
    ;[thread] = await fx.scan()
    assert.equal(thread.activity, 'running', 'a partial JSON record is not terminal evidence')

    await fsp.appendFile(file, complete.slice(split))
    ;[thread] = await fx.scan()
    assert.equal(thread.activity, 'quiet')
    assert.equal(thread.running, false)
  } finally {
    await fx.cleanup()
  }
})

test('P2-2: stale or absent lifecycle evidence is unknown rather than quiet', async () => {
  // Regression caught: false previously conflated a completed turn with missing or stale evidence.
  const fx = await fixture()
  try {
    const stale = await fx.rollout(IDS.parent, [
      line('session_meta', { id: IDS.parent, cwd: '/tmp/exact-checkout' }),
      line('event_msg', { type: 'task_started' }),
    ])
    await fx.rollout(IDS.child, [line('session_meta', { id: IDS.child, cwd: '/tmp/exact-checkout' })])
    const old = new Date(Date.now() - 6 * 60 * 60 * 1000)
    await fsp.utimes(stale, old, old)

    const byId = new Map((await fx.scan()).map((thread) => [thread.id, thread]))
    for (const id of [IDS.parent, IDS.child]) {
      assert.equal(byId.get(codexId(id)).activity, 'unknown')
      assert.equal(byId.get(codexId(id)).running, null)
      assert.equal(byId.get(codexId(id)).unread, null)
    }
  } finally {
    await fx.cleanup()
  }
})

test('P2-3: opening capabilities distinguish exact CLI resume from an unverified desktop target', async () => {
  // Regression caught: a URL string alone was presented as proof that the desktop app would select
  // the requested UUID, while the installed CLI capability was not exposed on scanned threads.
  const fx = await fixture()
  const binDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-codex-bin-'))
  const bin = path.join(binDir, 'codex')
  try {
    await fsp.writeFile(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await fx.rollout(IDS.parent, [
      line('session_meta', { id: IDS.parent, cwd: '/tmp/exact-checkout' }),
      line('event_msg', { type: 'task_complete' }),
    ])

    const [withoutCli] = await fx.scan()
    assert.equal(withoutCli.canOpen, false)
    assert.equal(withoutCli.openCapabilities.app.available, false)
    assert.match(withoutCli.canOpenReason, /No verified opener/i)

    const [thread] = await fx.scan({ BOT_CROSSING_CODEX_CLI: bin })
    assert.equal(thread.canOpen, true)
    assert.equal(thread.openCapabilities.terminal.available, true)
    assert.equal(thread.openCapabilities.terminal.verified, true)
    assert.equal(thread.openCapabilities.app.available, false)
    assert.equal(thread.openCapabilities.app.verified, false)
    assert.match(thread.canOpenReason, /CLI.*resume/i)

    const opened = await withEnv({ BOT_CROSSING_CODEX_CLI: bin }, () =>
      import(`../server/harnesses/codex.mjs?open=${encodeURIComponent(bin)}`).then((adapter) =>
        adapter.default.openThread(thread.ref)
      )
    )
    assert.match(opened.appUnavailableReason, /not verified/i)
    const { present } = await import('../server/api.mjs')
    assert.deepEqual(await present(opened, 'app'), {
      ok: false,
      error: opened.appUnavailableReason,
    })
  } finally {
    await fx.cleanup()
    await fsp.rm(binDir, { recursive: true, force: true })
  }
})
