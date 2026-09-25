import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createEmbeddedService } from '../server/embedded-service.mjs'

let protocol
let loadError
try { protocol = await import('../server/embedded-protocol.mjs') }
catch (error) { loadError = error }

async function withProtocol(run, scan = () => []) {
  assert.equal(typeof protocol?.createProtocolSession, 'function',
    `Required private protocol seam unavailable: ${loadError?.code || 'missing export'}`)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-protocol-contract-'))
  const service = createEmbeddedService({ dataDir: dir, scan })
  const session = protocol.createProtocolSession({ service, documentId: 'owned-document' })
  const message = (method, payload = {}, extra = {}) => ({ v: 1, documentId: 'owned-document', id: 'request-1', method, payload, ...extra })
  try { await run({ session, message, dir }) }
  finally { session.dispose(); await fs.rm(dir, { recursive: true, force: true }) }
}

test('private protocol wraps a real state read without starting inventory', async () => {
  await withProtocol(async ({ session, message }) => {
    const result = await session.handle(message('state.read'))
    assert.deepEqual({ v: result.v, documentId: result.documentId, id: result.id, ok: result.ok },
      { v: 1, documentId: 'owned-document', id: 'request-1', ok: true })
    assert.deepEqual(result.result.archived, [])
  }, () => assert.fail('State handshake/read must not trigger scan'))
})

test('private protocol refuses unknown version, document, method and oversized full envelope before state writes', async () => {
  await withProtocol(async ({ session, message, dir }) => {
    const state = { archived: ['forbidden'] }
    const oversized = message('state.write', { state: { archived: [''] }, baseUpdatedAt: 0 })
    oversized.payload.state.archived[0] = 'x'.repeat(64 * 1024 - Buffer.byteLength(JSON.stringify(oversized)) + 1)
    assert.equal(Buffer.byteLength(JSON.stringify(oversized)), 64 * 1024 + 1)
    for (const invalid of [
      message('state.write', { state, baseUpdatedAt: 0 }, { v: 2 }),
      message('state.write', { state, baseUpdatedAt: 0 }, { documentId: 'foreign-document' }),
      message('new-session', { folder: '/arbitrary' }),
      message('state.write', { state, baseUpdatedAt: 0, arbitrary: true }),
      oversized,
    ]) {
      const response = await session.handle(invalid)
      assert.equal(response.ok, false)
      assert.match(response.error.code, /invalid|unsupported|revoked|oversize/)
      if (invalid === oversized) assert.match(response.error.code, /oversize/)
      assert.ok(Buffer.byteLength(JSON.stringify(response)) <= 1024 * 1024)
      await assert.rejects(fs.stat(path.join(dir, 'colony.json')), { code: 'ENOENT' })
    }
  }, () => assert.fail('Rejected request must not scan'))
})

test('private protocol refuses an oversized response including its correlation envelope', async () => {
  // Existing service budgets only its result. Protocol must reject this full-envelope overflow.
  let generation
  await withProtocol(async ({ session, message }) => {
    const response = await session.handle(message('inventory.page', { limit: 1 }))
    assert.equal(response.ok, false)
    assert.match(response.error.code, /oversize/)
    assert.ok(Buffer.byteLength(JSON.stringify(response)) < 1024)
  }, () => {
    generation = 'x'.repeat(36)
    const result = { generation, records: [{ id: 'large', title: '' }], nextCursor: null }
    const title = 'x'.repeat(1024 * 1024 - Buffer.byteLength(JSON.stringify(result)))
    return [{ id: 'large', title }]
  })
})

test('private protocol revokes pending work and rejects new writes after disposal', async () => {
  let release
  let scanning
  const started = new Promise(resolve => { scanning = resolve })
  await withProtocol(async ({ session, message, dir }) => {
    const pending = session.handle(message('inventory.page', { limit: 1 }))
    await started
    session.dispose()
    release([{ id: 'stale' }])
    const result = await pending
    assert.equal(result.ok, false)
    assert.match(result.error.code, /revoked/)
    const write = await session.handle(message('state.write', { state: { archived: ['late'] }, baseUpdatedAt: 0 }))
    assert.equal(write.ok, false)
    await assert.rejects(fs.stat(path.join(dir, 'colony.json')), { code: 'ENOENT' })
  }, () => new Promise(resolve => { release = resolve; scanning() }))
})

test('private protocol bounds in-flight requests and rejects duplicate outstanding IDs', async () => {
  const releases = []
  assert.equal(typeof protocol?.createProtocolSession, 'function')
  // Deferred service boundary isolates the protocol's own 32-request admission limit.
  const session = protocol.createProtocolSession({ documentId: 'owned-document', service: {
    invoke: () => new Promise(resolve => releases.push(resolve)), dispose() {},
  } })
  const message = (method, payload = {}, extra = {}) => ({ v: 1, documentId: 'owned-document', id: 'request-1', method, payload, ...extra })
  try {
    const pending = Array.from({ length: 32 }, (_, i) => session.handle(message('inventory.page', { limit: 1 }, { id: `p${i}` })))
    const duplicate = await session.handle(message('state.write', { state: { archived: ['wrong'] }, baseUpdatedAt: 0 }, { id: 'p0' }))
    assert.equal(duplicate.ok, false)
    assert.match(duplicate.error.code, /duplicate|invalid/)
    const overflow = await session.handle(message('state.read', {}, { id: 'overflow' }))
    assert.equal(overflow.ok, false)
    assert.match(overflow.error.code, /busy|limit/)
    session.dispose()
    for (const release of releases) release({})
    for (const result of await Promise.all(pending)) assert.equal(result.ok, false)
  } finally { session.dispose() }
})

test('private protocol allows ordinary repeated metadata references in valid JSON results', async () => {
  const checkout = { id: 'shared', path: '/synthetic' }
  await withProtocol(async ({ session, message }) => {
    const result = await session.handle(message('inventory.page', { limit: 2 }))
    assert.equal(result.ok, true)
    assert.deepEqual(result.result.records.map(record => record.checkout), [checkout, checkout])
  }, () => [{ id: 'a', checkout }, { id: 'b', checkout }])
})

test('private protocol projects optional undefined scanner fields as ordinary JSON omission', async () => {
  await withProtocol(async ({ session, message }) => {
    const result = await session.handle(message('inventory.page', { limit: 1 }))
    assert.equal(result.ok, true)
    assert.deepEqual(result.result.records, [{ id: 'a' }])
  }, () => [{ id: 'a', parentId: undefined }])
})

test('private protocol disposal settles pending calls even if the scanner never returns', async () => {
  await withProtocol(async ({ session, message }) => {
    const pending = session.handle(message('inventory.page', { limit: 1 }))
    session.dispose()
    const timeout = new Promise(resolve => setTimeout(() => resolve('timeout'), 200))
    const response = await Promise.race([pending, timeout])
    assert.notEqual(response, 'timeout', 'disposal must settle callers without waiting for the scanner')
    assert.equal(response.error.code, 'revoked')
  }, () => new Promise(() => {}))
})

test('scene intents validate at the wire boundary and remain parent-intercept-only', async () => {
  await withProtocol(async ({ session, message }) => {
    const valid = await session.handle(message('scene.select', { threadId: 'codex:thread-1' }))
    assert.equal(valid.ok, false)
    assert.equal(valid.error.code, 'unsupported_method')
    for (const payload of [{ threadId: '' }, { threadId: 'x'.repeat(129) }, { threadId: 'ok', extra: true }]) {
      const invalid = await session.handle(message('scene.select', payload))
      assert.equal(invalid.ok, false)
      assert.equal(invalid.error.code, 'invalid_request')
    }
  }, () => assert.fail('Scene intents must not scan'))
})

test('state.mark rejects malformed identities and extra fields before writing', async () => {
  await withProtocol(async ({ session, message, dir }) => {
    for (const payload of [
      { threadId: '', archived: true },
      { threadId: 'x'.repeat(129), archived: true },
      { threadId: 'codex:ok', archived: true, extra: true },
      { threadId: 'codex:ok' },
    ]) {
      const result = await session.handle(message('state.mark', payload))
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'invalid_request')
    }
    await assert.rejects(fs.stat(path.join(dir, 'colony.json')), { code: 'ENOENT' })
  }, () => assert.fail('State mark must not scan'))
})
