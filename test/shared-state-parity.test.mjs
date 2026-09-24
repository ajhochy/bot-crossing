import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { createEmbeddedService } from '../server/embedded-service.mjs'
import { mergeState } from '../src/game/merge-state.js'

async function withAdapter(kind, run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-shared-state-'))
  let child
  let service
  try {
    let adapter
    if (kind === 'http') {
      child = fork(new URL('./support/shared-state-http-child.mjs', import.meta.url), [], {
        env: { ...process.env, HOME: dir, BOT_CROSSING_DATA: dir, BOT_CROSSING_FIXTURE: '' },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      })
      const [{ port }] = await once(child, 'message')
      const origin = `http://127.0.0.1:${port}`
      const call = async (method, body) => fetch(`${origin}/api/state`, {
        method, headers: { Origin: origin, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      adapter = {
        origin,
        read: async () => {
          const response = await call('GET')
          const body = await response.json()
          if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
          return body
        },
        write: async (state, baseUpdatedAt) => {
          const response = await call('PUT', { ...state, baseUpdatedAt })
          return { conflict: response.status === 409, status: response.status, state: await response.json() }
        },
      }
    } else {
      service = createEmbeddedService({ dataDir: dir, scan: () => assert.fail('State operations must never scan') })
      adapter = {
        read: () => service.invoke('state.read'),
        write: async (state, baseUpdatedAt) => {
          try { return { conflict: false, status: 200, state: await service.invoke('state.write', { state, baseUpdatedAt }) } }
          catch (error) {
            if (!/conflict/.test(error.message)) throw error
            // Embedded transport currently signals conflict as an error; reload supplies the merge base.
            return { conflict: true, status: 409, state: await service.invoke('state.read') }
          }
        },
      }
    }
    await run({ ...adapter, dir, file: path.join(dir, 'colony.json') })
  } finally {
    service?.dispose()
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit')
      child.send('close')
      const deadline = setTimeout(() => child.kill('SIGTERM'), 2000)
      await exited
      clearTimeout(deadline)
    }
    await fs.rm(dir, { recursive: true, force: true })
  }
}

for (const kind of ['http', 'embedded']) {
  test(`${kind}: unknown fields survive read and subsequent archive save`, async () => {
    // Regression: a known-field projection silently drops a future preference on a routine save.
    await withAdapter(kind, async ({ read, write, file }) => {
      const extension = { futureVersion: 7, nested: ['untouched', { retained: false }] }
      await fs.writeFile(file, JSON.stringify({ version: 3, archived: ['old'], updatedAt: 10, extension }))
      const base = await read()
      assert.deepEqual(base.extension, extension, 'read must retain unrecognized state')
      const saved = await write({ ...base, archived: ['old', 'new'] }, base.updatedAt)
      assert.equal(saved.status, 200)
      assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).extension, extension)
      assert.deepEqual((await read()).archived, ['old', 'new'])
    })
  })

  test(`${kind}: archive conflict preserves an unarchive, remote addition and future fields`, async () => {
    // Regression: union resurrects removed archives, or mergeState drops fields it does not yet know.
    await withAdapter(kind, async ({ read, write, file }) => {
      await fs.writeFile(file, JSON.stringify({ version: 3, archived: ['remove'], updatedAt: 10,
        extension: { retained: true } }))
      const base = await read()
      const local = { ...base, archived: [] }
      const remote = await write({ ...base, archived: ['remove', 'remote'] }, base.updatedAt)
      assert.equal(remote.status, 200)
      const before = await fs.readFile(file, 'utf8')
      const conflict = await write(local, base.updatedAt)
      assert.equal(conflict.conflict, true)
      assert.equal(await fs.readFile(file, 'utf8'), before, 'rejected save must not touch disk')
      assert.deepEqual(conflict.state.archived, ['remove', 'remote'])
      const merged = mergeState(base, local, conflict.state)
      const saved = await write(merged, conflict.state.updatedAt)
      assert.equal(saved.status, 200)
      const final = await read()
      assert.deepEqual(final.archived, ['remote'], 'unarchive survives concurrent archive addition')
      assert.deepEqual(final.extension, { retained: true }, 'conflict retry must retain future fields')
    })
  })

  test(`${kind}: legacy UUID migration is a read-only projection`, async () => {
    // Regression: extraction omits one keyed field or persists a migration during discovery.
    await withAdapter(kind, async ({ read, file }) => {
      const id = 'fe911daa-2393-4e29-8d36-6e37c328594c'
      const raw = JSON.stringify({ version: 1, archived: [id], opened: [id], archivedAt: { [id]: 3 },
        seen: { [id]: 4 }, viewedAt: { [id]: 5 }, updatedAt: 7 })
      await fs.writeFile(file, raw)
      const state = await read()
      assert.equal(state.version, 3)
      for (const key of ['archived', 'opened']) assert.deepEqual(state[key], [`claude-code:${id}`])
      for (const key of ['archivedAt', 'seen', 'viewedAt']) assert.deepEqual(Object.keys(state[key]), [`claude-code:${id}`])
      assert.equal(await fs.readFile(file, 'utf8'), raw)
    })
  })

  test(`${kind}: conflict merge preserves remote-only fields and local whole-value changes`, async () => {
    // Regression: a retry drops additions made by another version, or invents a nested schema merge.
    await withAdapter(kind, async ({ read, write, file }) => {
      await fs.writeFile(file, JSON.stringify({ version: 3, updatedAt: 10,
        localPreference: { old: true }, contested: { old: true }, unchanged: { retained: true } }))
      const base = await read()
      const local = { ...base, localPreference: { local: 1 }, contested: { local: 2 } }
      await write({ ...base, remoteOnly: { future: ['retained'] }, contested: { remote: 3 } }, base.updatedAt)
      const conflict = await write(local, base.updatedAt)
      assert.equal(conflict.conflict, true)
      const saved = await write(mergeState(base, local, conflict.state), conflict.state.updatedAt)
      assert.equal(saved.status, 200)
      const final = await read()
      assert.deepEqual(final.remoteOnly, { future: ['retained'] })
      assert.deepEqual(final.localPreference, { local: 1 })
      assert.deepEqual(final.contested, { local: 2 }, 'local changed opaque value wins whole; do not blend nested keys')
      assert.deepEqual(final.unchanged, { retained: true })
      assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(file, 'utf8')), 'baseUpdatedAt'), false)
    })
  })

  test(`${kind}: shared storage refuses symlink and oversized saved files without replacing them`, async () => {
    // Regression: the HTTP adapter bypasses the shared no-follow/size guards during extraction.
    await withAdapter(kind, async ({ read, write, file, dir }) => {
      const target = path.join(dir, 'foreign.json')
      const original = JSON.stringify({ version: 3, archived: ['foreign'], updatedAt: 12 })
      await fs.writeFile(target, original)
      await fs.symlink(target, file)
      await assert.rejects(read(), /unmanaged|unreadable/)
      const [attempt] = await Promise.allSettled([write({ archived: ['must-not-write'] }, 12)])
      if (attempt.status === 'fulfilled') assert.equal(attempt.value.status, 500)
      else assert.match(attempt.reason.message, /unmanaged|unreadable/)
      assert.equal((await fs.lstat(file)).isSymbolicLink(), true)
      assert.equal(await fs.readFile(target, 'utf8'), original)
      await fs.unlink(file)
      const handle = await fs.open(file, 'w')
      await handle.truncate(32 * 1024 * 1024 + 1)
      await handle.close()
      await assert.rejects(read(), /32 MiB/)
      assert.equal((await fs.stat(file)).size, 32 * 1024 * 1024 + 1)
    })
  })
}

test('standalone scene refuses save before a successful initial read without sending a request', async () => {
  // Regression: the initial empty scene overwrites a real archive while its read is pending or failed.
  const client = await import(`../src/game/api.js?unread-contract=${Date.now()}`)
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('synthetic read failure') }
  try {
    await assert.rejects(client.saveState({ archived: [] }), /never read/)
    assert.equal(calls, 0)
    await assert.rejects(client.fetchState(), /synthetic read failure/)
    await assert.rejects(client.saveState({ archived: [] }), /never read/)
    assert.equal(calls, 1, 'only the failed read was sent; neither save reached transport')
  } finally { globalThis.fetch = originalFetch }
})

test('embedded exact-base requirement remains stricter than standalone curl compatibility', async () => {
  await withAdapter('http', async ({ write }) => assert.equal((await write({ archived: ['first'] })).status, 200))
  await withAdapter('embedded', async ({ write, file }) => {
    await assert.rejects(write({ archived: ['first'] }), /valid baseUpdatedAt/)
    await assert.rejects(fs.stat(file), { code: 'ENOENT' })
  })
})

test('standalone tolerant fields do not weaken embedded shape validation', async () => {
  const legacy = { archived: null, plots: [], hiddenProjects: [0, null, ''], settings: ['legacy'] }
  await withAdapter('http', async ({ write }) => {
    const result = await write(legacy)
    assert.equal(result.status, 200)
    assert.deepEqual(result.state.archived, [])
    assert.deepEqual(result.state.plots, {})
    assert.deepEqual(result.state.hiddenProjects, ['0', 'null'])
    assert.deepEqual(result.state.settings, ['legacy'])
  })
  await withAdapter('embedded', async ({ write, file }) => {
    await assert.rejects(write(legacy, 0), /invalid archived/)
    await assert.rejects(fs.stat(file), { code: 'ENOENT' })
  })
})
