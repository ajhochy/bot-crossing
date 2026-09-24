import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { webcrypto } from 'node:crypto'
import { createEmbeddedTransport } from '../src/game/embedded-api.js'

const source = await fs.readFile(new URL('../server/embedded-preload.cjs', import.meta.url), 'utf8')

function preload() {
  const ipc = new EventEmitter()
  const lifecycle = new EventEmitter()
  const exposed = {}
  const sent = []
  const ready = []
  const timers = []
  const port = { closed: false, onmessage: null, onmessageerror: null,
    postMessage: message => sent.push(message), start() {}, close() { this.closed = true } }
  const context = { Buffer, TextEncoder, TextDecoder, crypto: webcrypto, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return setTimeout(fn, ms) }, clearTimeout,
    location: { href: 'rhythm-colony://app/index.html', origin: 'rhythm-colony://app', pathname: '/index.html' },
    process: { isMainFrame: true, versions: { electron: '40.10.2' } },
    window: { addEventListener: (name, handler) => lifecycle.on(name, handler) },
    require(name) {
      assert.equal(name, 'electron', 'sandboxed preload must not import privileged Node modules')
      return { contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value } }, ipcRenderer: ipc }
    },
  }
  ipc.send = (...args) => ready.push(args)
  vm.runInNewContext(source, context, { filename: 'embedded-preload.cjs' })
  const bridge = exposed.colonyEmbedded
  return { bridge, port, sent, ready, timers, attach: (config = { v: 1, documentId: 'owned-document' }, ports = [port]) => ipc.emit('colony:port', { ports }, config),
    close: () => lifecycle.emit('pagehide') }
}

test('preload exposes only metadata and a closed private request wrapper', async () => {
  const fixture = preload()
  assert.equal(typeof fixture.bridge?.request, 'function', 'preload request wrapper is absent')
  assert.equal(fixture.bridge.protocolVersion, 1)
  assert.deepEqual(Object.keys(fixture.bridge).filter(key => !['product', 'protocolVersion', 'electronMajor', 'request'].includes(key)), [])
  fixture.attach()
  const pending = fixture.bridge.request('state.read', {})
  await new Promise(resolve => setImmediate(resolve))
  const request = fixture.sent.find(message => message.method === 'state.read')
  assert.ok(request)
  assert.equal(request.documentId, 'owned-document')
  fixture.port.onmessage({ data: { v: 1, documentId: request.documentId, id: request.id, ok: true, result: { version: 3, archived: [], updatedAt: 0 } } })
  assert.deepEqual((await pending).archived, [])
  fixture.close()
})

test('preload refuses unallowlisted operations and oversized control envelopes before posting', async () => {
  const fixture = preload()
  assert.equal(typeof fixture.bridge?.request, 'function', 'preload request wrapper is absent')
  fixture.attach()
  const count = fixture.sent.length
  await assert.rejects(fixture.bridge.request('new-session', { folder: '/arbitrary' }), /unsupported|not allowed/i)
  await assert.rejects(fixture.bridge.request('state.read', { file: '/arbitrary' }), /invalid|field|unsupported/i)
  await assert.rejects(fixture.bridge.request('state.write', { state: { archived: ['x'.repeat(64 * 1024)] }, baseUpdatedAt: 0 }), /size|limit|large/i)
  assert.equal(fixture.sent.length, count)
  fixture.close()
})

test('preload revokes pending requests on pagehide and will not send stale requests', async () => {
  const fixture = preload()
  assert.equal(typeof fixture.bridge?.request, 'function', 'preload request wrapper is absent')
  fixture.attach()
  const pending = fixture.bridge.request('state.read', {})
  await new Promise(resolve => setImmediate(resolve))
  const request = fixture.sent.find(message => message.method === 'state.read')
  fixture.close()
  await assert.rejects(pending, /revoked|closed/i)
  assert.equal(fixture.port.closed, true)
  const count = fixture.sent.length
  await assert.rejects(fixture.bridge.request('state.read', {}), /revoked|closed/i)
  assert.equal(fixture.sent.length, count)
  fixture.port.onmessage?.({ data: { v: 1, documentId: request.documentId, id: request.id, ok: true, result: { forged: true } } })
})

test('preload rejects a foreign-document reply instead of delivering it to the current request', async () => {
  const fixture = preload()
  assert.equal(typeof fixture.bridge?.request, 'function', 'preload request wrapper is absent')
  fixture.attach()
  const pending = fixture.bridge.request('state.read', {})
  await new Promise(resolve => setImmediate(resolve))
  const request = fixture.sent.find(message => message.method === 'state.read')
  fixture.port.onmessage({ data: { v: 1, documentId: 'foreign-document', id: request.id, ok: true, result: { forged: true } } })
  await assert.rejects(pending, /invalid|revoked|document/i)
  assert.equal(fixture.port.closed, true)
})

test('preload refuses an oversized complete response envelope', async () => {
  const fixture = preload()
  assert.equal(typeof fixture.bridge?.request, 'function', 'preload request wrapper is absent')
  fixture.attach()
  const pending = fixture.bridge.request('state.read', {})
  await new Promise(resolve => setImmediate(resolve))
  const request = fixture.sent.find(message => message.method === 'state.read')
  fixture.port.onmessage({ data: { v: 1, documentId: request.documentId, id: request.id, ok: true,
    result: { version: 3, updatedAt: 1, archived: ['x'.repeat(1024 * 1024)] } } })
  await assert.rejects(pending, /size|limit|large|invalid/i)
  assert.equal(fixture.port.closed, true)
})

test('preload refuses malformed or multiple-port attachment handshakes', async () => {
  for (const multiple of [false, true]) {
    const fixture = preload()
    assert.equal(typeof fixture.bridge?.request, 'function', 'preload request wrapper is absent')
    const extra = { closed: false, close() { this.closed = true } }
    fixture.attach({ v: multiple ? 1 : 99, documentId: 'owned-document' }, multiple ? [fixture.port, extra] : [fixture.port])
    assert.equal(fixture.port.closed, true)
    if (multiple) assert.equal(extra.closed, true)
    await assert.rejects(fixture.bridge.request('state.read', {}), /invalid|unavailable|closed|revoked/i)
    assert.equal(fixture.sent.length, 0)
  }
})

test('preload refuses more than 32 pending requests and revokes the pending set together', async () => {
  const fixture = preload()
  assert.equal(typeof fixture.bridge?.request, 'function', 'preload request wrapper is absent')
  fixture.attach()
  const pending = Array.from({ length: 32 }, () => fixture.bridge.request('state.read', {}))
  await assert.rejects(fixture.bridge.request('state.read', {}), /limit|busy|many/i)
  fixture.close()
  for (const result of await Promise.allSettled(pending)) {
    assert.equal(result.status, 'rejected')
    assert.match(result.reason.message, /revoked|closed/i)
  }
})

test('preload refuses a repeated document attachment instead of replacing its pending channel', async () => {
  const fixture = preload()
  assert.equal(typeof fixture.bridge?.request, 'function', 'preload request wrapper is absent')
  fixture.attach()
  const pending = fixture.bridge.request('state.read', {})
  await new Promise(resolve => setImmediate(resolve))
  const repeated = { closed: false, close() { this.closed = true }, start() {}, postMessage() { assert.fail('Repeated attachment must not carry requests') } }
  fixture.attach({ v: 1, documentId: 'owned-document' }, [repeated])
  await assert.rejects(pending, /invalid|duplicate|revoked|closed/i)
  assert.equal(fixture.port.closed, true)
  assert.equal(repeated.closed, true)
})

test('revoked preload cannot revive through a different valid document attachment', async () => {
  const fixture = preload()
  fixture.attach()
  fixture.close()
  const next = { closed: false, close() { this.closed = true }, start() {}, postMessage() { assert.fail('Revoked document sent a request') } }
  fixture.attach({ v: 1, documentId: 'new-document' }, [next])
  assert.equal(next.closed, true)
  await assert.rejects(fixture.bridge.request('state.read', {}), /revoked|closed/i)
})

test('preload initial state request waits for the port and announces installed wrapper readiness', async () => {
  const fixture = preload()
  const pending = fixture.bridge.request('state.read', {})
  const settled = pending.then(() => 'resolved', () => 'rejected')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(structuredClone(fixture.ready[0]), ['colony:scene-ready', { v: 1, product: 'colony' }])
  assert.equal(fixture.sent.length, 0)
  fixture.attach()
  await new Promise(resolve => setImmediate(resolve))
  const request = fixture.sent[0]
  assert.equal(request.method, 'state.read')
  fixture.port.onmessage({ data: { v: 1, documentId: request.documentId, id: request.id, ok: true, result: { version: 3, archived: [] } } })
  assert.equal(await settled, 'resolved')
  fixture.close()
})

test('handshake wait uses the pending quota and expires or closes with stable revocation', async () => {
  for (const expire of [false, true]) {
    const fixture = preload()
    const pending = Array.from({ length: 32 }, () => fixture.bridge.request('state.read', {}))
    const settled = Promise.allSettled(pending)
    await assert.rejects(fixture.bridge.request('state.read', {}), /limit|busy|many/i)
    if (expire) fixture.timers.find(timer => timer.ms === 10000).fn()
    else fixture.close()
    for (const result of await settled) {
      assert.equal(result.status, 'rejected')
      assert.equal(result.reason.code, 'revoked')
    }
    assert.equal(fixture.sent.length, 0)
  }
})

test('actual preload and renderer transport reject a snapshot revoked during inventory cleanup', async () => {
  const fixture = preload()
  fixture.attach()
  const client = createEmbeddedTransport(fixture.bridge)
  fixture.port.postMessage = message => {
    if (message.method === 'inventory.cancel') { fixture.close(); return }
    fixture.port.onmessage({ data: { v: 1, documentId: message.documentId, id: message.id, ok: true,
      result: { generation: 'generation', scannedAt: 1, collection: message.payload.collection, records: [], nextCursor: null } } })
  }
  await assert.rejects(client.fetchThreads(), error => error.code === 'revoked')
})

test('contextBridge Error property loss still rejects revoked cleanup and merges state conflicts', async () => {
  const { createEmbeddedService } = await import('../server/embedded-service.mjs')
  const { createProtocolSession } = await import('../server/embedded-protocol.mjs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-preload-conflict-'))
  const fixture = preload()
  fixture.attach()
  const service = createEmbeddedService({ dataDir: dir, scan: () => ({ threads: [], projects: [], warnings: [], scannedAt: 1 }) })
  const protocol = createProtocolSession({ service, documentId: 'owned-document' })
  const bridge = { ...fixture.bridge, request: async (...args) => {
    try { return await fixture.bridge.request(...args) }
    catch (error) { throw new Error(error.message) } // Electron can discard custom Error fields.
  } }
  const prior = globalThis.colonyEmbedded
  globalThis.colonyEmbedded = bridge
  fixture.port.postMessage = message => {
    if (message.method === 'inventory.cancel') { fixture.close(); return }
    void protocol.handle(structuredClone(message)).then(data => fixture.port.onmessage?.({ data }))
  }
  try {
    const client = await import(`../src/game/api.js?preload-conflict=${Date.now()}`)
    const initial = await client.fetchState()
    await service.invoke('state.write', { state: { ...initial, archived: ['remote'] }, baseUpdatedAt: initial.updatedAt })
    const merged = await client.saveState({ ...initial, archived: ['local'] })
    assert.deepEqual(new Set(merged.archived), new Set(['remote', 'local']))
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'colony.json'), 'utf8'))
    assert.deepEqual(new Set(saved.archived), new Set(['remote', 'local']))
    await assert.rejects(client.fetchThreads(), error => error.code === 'revoked' && !error.message.includes('[colony:'))
  } finally {
    fixture.close(); protocol.dispose()
    if (prior === undefined) delete globalThis.colonyEmbedded
    else globalThis.colonyEmbedded = prior
    await fs.rm(dir, { recursive: true, force: true })
  }
})
