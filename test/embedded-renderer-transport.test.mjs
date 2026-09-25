import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createEmbeddedService } from '../server/embedded-service.mjs'
import { createProtocolSession } from '../server/embedded-protocol.mjs'

let serial = 0
async function withClient(run, inventory, intercept) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-renderer-contract-'))
  const service = createEmbeddedService({ dataDir: dir, scan: () => assert.fail('state fixture must not scan') })
  const protocol = createProtocolSession({ service, documentId: 'renderer-fixture' })
  let requestNumber = 0
  const savedBridge = globalThis.colonyEmbedded
  const savedFetch = globalThis.fetch
  const calls = []
  let network = 0
  globalThis.fetch = async () => { network++; throw new Error('Embedded scene must not use HTTP') }
  // This is the preload transport boundary, not a replacement for renderer state logic.
  globalThis.colonyEmbedded = Object.freeze({ product: 'colony', protocolVersion: 1,
    request: async (method, payload = {}) => {
      calls.push({ method, payload })
      if (intercept) {
        const value = await intercept(method, payload)
        if (value !== undefined) return value
      }
      if (inventory && method.startsWith('inventory.')) return inventory(method, payload)
      try {
        const response = await protocol.handle({ v: 1, documentId: 'renderer-fixture', id: `request-${++requestNumber}`, method, payload })
        if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code })
        return response.result
      }
      catch (error) {
        if (/conflict/.test(error.message)) error.code = 'state_conflict'
        throw error
      }
    },
  })
  try {
    const client = await import(`../src/game/api.js?embedded-contract=${++serial}`)
    await run({ client, service, dir, calls, network: () => network })
  } finally {
    protocol.dispose()
    if (savedBridge === undefined) delete globalThis.colonyEmbedded
    else globalThis.colonyEmbedded = savedBridge
    globalThis.fetch = savedFetch
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test('embedded scene reads state privately and refuses a save before initial read', async () => {
  await withClient(async ({ client, calls, network }) => {
    await assert.rejects(client.saveState({ archived: [] }), /never read/)
    assert.equal(calls.length, 0)
    const state = await client.fetchState()
    assert.deepEqual(state.archived, [])
    assert.equal(calls[0].method, 'state.read')
    assert.equal(network(), 0)
  })
})

test('embedded scene round-trips large saved state through bounded transfer methods', async () => {
  await withClient(async ({ client, service, dir, calls, network }) => {
    const state = { version: 3, updatedAt: 20,
      archived: Array.from({ length: 25_000 }, (_, i) => `task-${i}-${'x'.repeat(50)}`),
      future: { preserved: ['opaque'] } }
    await fs.writeFile(path.join(dir, 'colony.json'), JSON.stringify(state))
    const loaded = await client.fetchState()
    assert.deepEqual(loaded.archived, state.archived)
    assert.deepEqual(loaded.future, state.future)
    loaded.archived = loaded.archived.slice(1)
    await client.saveState(loaded)
    const disk = JSON.parse(await fs.readFile(path.join(dir, 'colony.json'), 'utf8'))
    assert.deepEqual(disk.archived, state.archived.slice(1))
    assert.deepEqual(disk.future, state.future)
    assert.ok(calls.some(c => c.method === 'state.readChunk'))
    assert.ok(calls.some(c => c.method === 'state.begin'))
    assert.ok(calls.some(c => c.method === 'state.commit'))
    assert.equal(calls.some(c => c.method === 'state.write'), false, 'large state cannot use the control frame')
    for (const call of calls) {
      const envelope = { v: 1, documentId: 'd'.repeat(64), id: 'i'.repeat(64), ...call }
      assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= (call.method === 'state.chunk' ? 1024 * 1024 : 64 * 1024))
    }
    assert.equal(network(), 0)
    service.dispose()
    await assert.rejects(client.saveState(loaded), /disposed|revoked|closed/)
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'colony.json'), 'utf8')), disk)
  })
})

test('embedded scene merges a real stale archive save without resurrecting an unarchive', async () => {
  await withClient(async ({ client, service, dir }) => {
    await fs.writeFile(path.join(dir, 'colony.json'), JSON.stringify({ version: 3, updatedAt: 30,
      archived: ['remove'], future: { preserved: true } }))
    const local = await client.fetchState()
    await service.invoke('state.write', { state: { ...local, archived: ['remove', 'remote'] }, baseUpdatedAt: local.updatedAt })
    local.archived = []
    const merged = await client.saveState(local)
    assert.deepEqual(merged.archived, ['remote'])
    const disk = JSON.parse(await fs.readFile(path.join(dir, 'colony.json'), 'utf8'))
    assert.deepEqual(disk.archived, ['remote'])
    assert.deepEqual(disk.future, { preserved: true })
  })
})

test('embedded scene assembles threads, project inventory and warnings from one generation', async () => {
  const generation = 'synthetic-generation'
  const threads = Array.from({ length: 251 }, (_, i) => ({ id: `t${i}`, projectId: 'p' }))
  const projects = [{ id: 'p', name: 'Project', checkouts: [{ id: 'checkout', path: '/synthetic' }] }]
  const warnings = ['Synthetic source unavailable']
  let firstReads = 0
  let cancelled = false
  await withClient(async ({ client, network }) => {
    const result = await client.fetchThreads()
    assert.deepEqual(result.threads, threads)
    assert.deepEqual(result.projects, projects)
    assert.deepEqual(result.warnings, warnings)
    assert.equal(result.scannedAt, 42)
    assert.equal(firstReads, 1, 'only the first page may start a scan')
    assert.equal(cancelled, true, 'release generation after complete assembly')
    assert.equal(network(), 0)
    assert.deepEqual(await client.fetchCheckout('checkout'), { checkout: projects[0].checkouts[0] })
    await assert.rejects(client.fetchCheckout('/arbitrary/path'), /no longer in the scan/)
  }, async (method, payload) => {
    if (method === 'inventory.cancel') { assert.equal(payload.generation, generation); cancelled = true; return { cancelled: true } }
    assert.equal(method, 'inventory.page')
    if (!payload.generation) firstReads++
    else assert.equal(payload.generation, generation)
    assert.ok(payload.limit >= 1 && payload.limit <= 250)
    const collection = payload.collection || 'threads'
    const records = { threads, projects, warnings }[collection]
    assert.ok(records, 'collection must be allowlisted')
    const start = Number(payload.cursor || 0)
    const end = Math.min(start + payload.limit, records.length)
    return { generation, collection, records: records.slice(start, end), nextCursor: end < records.length ? String(end) : null, scannedAt: 42 }
  })
})

test('embedded scene refuses privileged standalone actions without any transport or network call', async () => {
  await withClient(async ({ client, calls, network }) => {
    for (const action of [
      () => client.newSession('/synthetic', 'codex', 'terminal'),
      () => client.openThread({ harness: 'codex', ref: 'synthetic' }, 'terminal'),
      () => client.revealFolder('/synthetic'),
    ]) await assert.rejects(action(), /unavailable|unsupported|not allowed/i)
    assert.equal(calls.length, 0)
    assert.equal(network(), 0)
  })
})

test('embedded scene never falls back to HTTP for an invalid bridge version', async () => {
  await withClient(async ({ network, calls }) => {
    globalThis.colonyEmbedded = { product: 'colony', protocolVersion: 99, request() { assert.fail('bad bridge must not be invoked') } }
    const client = await import(`../src/game/api.js?bad-bridge=${++serial}`)
    await assert.rejects(client.fetchState(), /unsupported|invalid|version/)
    assert.equal(network(), 0)
    assert.equal(calls.length, 0)
  })
})

test('embedded scene rejects a corrupt state download before adopting a writable base', async () => {
  let cancelled = false
  await withClient(async ({ client, calls }) => {
    await assert.rejects(client.fetchState(), /digest/)
    await assert.rejects(client.saveState({ archived: [] }), /never read/)
    assert.equal(cancelled, true)
    assert.equal(calls.some(c => ['state.write', 'state.begin', 'state.commit'].includes(c.method)), false)
  }, undefined, async method => {
    const bytes = Buffer.from('{"version":3,"updatedAt":9,"archived":["forged"]}')
    if (method === 'state.read') return { transferId: 'corrupt-transfer', totalBytes: bytes.length, sha256: '0'.repeat(64), updatedAt: 9 }
    if (method === 'state.readChunk') return { transferId: 'corrupt-transfer', offset: 0, data: bytes.toString('base64'), nextOffset: null }
    if (method === 'state.readCancel') { cancelled = true; return { cancelled: true } }
  })
})

test('embedded scene returns no partial inventory and releases its failed generation', async () => {
  let cancelled = false
  await withClient(async ({ client }) => {
    await assert.rejects(client.fetchThreads(), /synthetic second page failure/)
    assert.equal(cancelled, true)
  }, async (method, payload) => {
    if (method === 'inventory.cancel') { cancelled = true; assert.equal(payload.generation, 'partial'); return { cancelled: true } }
    if (payload.cursor) throw new Error('synthetic second page failure')
    return { generation: 'partial', collection: 'threads', records: [{ id: 'never-publish' }], nextCursor: '1', scannedAt: 4 }
  })
})

test('embedded scene cancels an interrupted upload and keeps the previous saved bytes', async () => {
  await withClient(async ({ client, dir, calls }) => {
    const state = await client.fetchState()
    state.archived = ['keep']
    await client.saveState(state)
    const before = await fs.readFile(path.join(dir, 'colony.json'), 'utf8')
    await assert.rejects(client.saveState({ ...state, archived: ['x'.repeat(1024 * 1024)] }), /interrupted upload/)
    assert.equal(await fs.readFile(path.join(dir, 'colony.json'), 'utf8'), before)
    assert.ok(calls.some(call => call.method === 'state.cancel'))
  }, undefined, async (method, payload) => {
    if (method === 'state.chunk' && payload.index === 1) throw new Error('interrupted upload')
  })
})

test('embedded scene does not publish a finished snapshot when its channel is revoked during cleanup', async () => {
  await withClient(async ({ client }) => {
    await assert.rejects(client.fetchThreads(), /revoked/)
  }, async (method, payload) => {
    if (method === 'inventory.cancel') throw Object.assign(new Error('document revoked'), { code: 'revoked' })
    return { generation: 'ending', collection: payload.collection, records: [], nextCursor: null, scannedAt: 4 }
  })
})
