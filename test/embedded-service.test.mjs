import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import net from 'node:net'

let serviceModule
let serviceLoadError
let importListeners = 0
const originalListen = net.Server.prototype.listen
net.Server.prototype.listen = function (...args) {
  importListeners++
  throw new Error(`unexpected TCP listener during embedded-service import: ${String(args[0] ?? '')}`)
}
try { serviceModule = await import('../server/embedded-service.mjs') }
catch (error) { serviceLoadError = error }
finally { net.Server.prototype.listen = originalListen }

function requireService() {
  assert.ok(serviceModule?.createEmbeddedService,
    `RED: required public seam server/embedded-service.mjs# createEmbeddedService is missing or failed to load: ${serviceLoadError?.code || serviceLoadError?.message || 'missing export'}`)
  return serviceModule.createEmbeddedService
}

async function profiles(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-embedded-service-'))
  const alpha = path.join(root, 'alpha')
  const beta = path.join(root, 'beta')
  await Promise.all([fs.mkdir(alpha), fs.mkdir(beta)])
  try { await fn({ alpha, beta }) }
  finally { await fs.rm(root, { recursive: true, force: true }) }
}

const readState = (service) => service.invoke('state.read')

test('disposing during a scan prevents the old instance returning a new snapshot', async () => {
  await profiles(async ({ alpha }) => {
    let release
    const pendingScan = new Promise(resolve => { release = resolve })
    const service = requireService()({ dataDir: alpha, scan: () => pendingScan })
    const pending = service.invoke('inventory.page', { limit: 10 })
    service.dispose()
    release([{ id: 'stale-after-disposal' }])
    await assert.rejects(pending, /disposed|cancelled|revoked/i)
  })
})

test('disposing before a queued state write runs preserves the prior saved state', async () => {
  await profiles(async ({ alpha }) => {
    const service = requireService()({ dataDir: alpha, scan: async () => [] })
    const initial = await readState(service)
    const pending = service.invoke('state.write', {
      state: { archived: ['stale-after-disposal'] }, baseUpdatedAt: initial.updatedAt,
    })
    service.dispose()
    await assert.rejects(pending, /disposed|cancelled|revoked/i)
    const observer = requireService()({ dataDir: alpha, scan: async () => [] })
    assert.deepEqual((await readState(observer)).archived, [])
  })
})

test('service construction is inert and owns profile state without process-global data paths', async () => {
  const createEmbeddedService = requireService()
  await profiles(async ({ alpha, beta }) => {
    const priorData = process.env.BOT_CROSSING_DATA
    let scans = 0
    let constructorListeners = 0
    const listen = net.Server.prototype.listen
    net.Server.prototype.listen = function (...args) {
      constructorListeners++
      throw new Error(`unexpected TCP listener during service construction: ${String(args[0] ?? '')}`)
    }
    let one
    let two
    try {
      one = createEmbeddedService({ dataDir: alpha, scan: async () => { scans++; return [] } })
      two = createEmbeddedService({ dataDir: beta, scan: async () => { scans++; return [] } })
    } finally { net.Server.prototype.listen = listen }
    assert.equal(scans, 0, 'import and construction must not trigger a harness scan')
    assert.equal(importListeners + constructorListeners, 0, 'embedded service must not create or bind a TCP listener')
    assert.equal(process.env.BOT_CROSSING_DATA, priorData, 'profile selection must not mutate process.env')

    const initialOne = await readState(one)
    const initialTwo = await readState(two)
    const updated = await one.invoke('state.write', { state: { archived: ['alpha-only'] }, baseUpdatedAt: initialOne.updatedAt })
    assert.deepEqual(updated.archived, ['alpha-only'])
    assert.deepEqual((await readState(two)).archived, [], 'a second profile must keep independent state')
  })
})

test('only an explicit inventory request scans; unsupported privileged operations are refused', async () => {
  const createEmbeddedService = requireService()
  await profiles(async ({ alpha }) => {
    let scans = 0
    const service = createEmbeddedService({ dataDir: alpha, scan: async () => { scans++; return [{ id: 'fixture' }] } })
    assert.equal(scans, 0)
    await assert.rejects(service.invoke('new-session', {}), /unsupported|not allowed|unknown/i)
    await assert.rejects(service.invoke('terminal-resume', {}), /unsupported|not allowed|unknown/i)
    await assert.rejects(service.invoke('unknown-method', {}), /unsupported|not allowed|unknown/i)
    assert.equal(scans, 0, 'rejected operations must have no scan or native side effect')
    const page = await service.invoke('inventory.page', { limit: 10 })
    assert.equal(scans, 1, 'the first explicit inventory request triggers the synthetic scan')
    assert.equal(page.records[0].id, 'fixture')
    assert.ok(page.generation)
  })
})

test('15,000 records use bounded pages with stable generation and cursors; cancellation ends the snapshot', async () => {
  const createEmbeddedService = requireService()
  await profiles(async ({ alpha }) => {
    const records = Array.from({ length: 15_000 }, (_, index) => ({ id: `thread-${index}`, title: `Task ${index}` }))
    let scans = 0
    const service = createEmbeddedService({ dataDir: alpha, scan: async () => { scans++; return records } })
    const first = await service.invoke('inventory.page', { limit: 250 })
    assert.equal(scans, 1)
    assert.ok(first.generation)
    assert.equal(first.records.length, 250)
    assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 1024 * 1024)
    const second = await service.invoke('inventory.page', { generation: first.generation, cursor: first.nextCursor, limit: 250 })
    assert.equal(second.generation, first.generation)
    assert.equal(second.records[0].id, 'thread-250')
    await service.invoke('inventory.cancel', { generation: first.generation })
    await assert.rejects(service.invoke('inventory.page', { generation: first.generation, cursor: second.nextCursor, limit: 250 }), /cancel|expired|unknown generation/i)
  })
})

test('inventory pages include the actual cursor in the one MiB frame budget', async () => {
  const createEmbeddedService = requireService()
  await profiles(async ({ alpha }) => {
    const prefix = Array.from({ length: 10_000 }, (_, index) => ({ id: `small-${index}` }))
    const suffix = Array.from({ length: 5_000 }, (_, index) => ({ id: `tail-${index}` }))
    const shape = { generation: 'x'.repeat(36), records: [{ id: 'large', title: '' }], nextCursor: '10001' }
    const padding = 1024 * 1024 - Buffer.byteLength(JSON.stringify(shape)) + 1
    const records = [...prefix, { id: 'large', title: 'x'.repeat(padding) }, ...suffix]
    const service = createEmbeddedService({ dataDir: alpha, scan: async () => records })
    const first = await service.invoke('inventory.page', { limit: 1 })
    await assert.rejects(
      service.invoke('inventory.page', { generation: first.generation, cursor: '10000', limit: 1 }),
      /record exceeds 1 MiB page limit/,
    )
    records[10_000] = { id: 'large', title: 'x'.repeat(padding - 1) }
    const exactFit = createEmbeddedService({ dataDir: alpha, scan: async () => records })
    const exactFirst = await exactFit.invoke('inventory.page', { limit: 1 })
    const boundary = await exactFit.invoke('inventory.page', { generation: exactFirst.generation, cursor: '10000', limit: 1 })
    assert.equal(boundary.records[0].id, 'large')
    assert.equal(Buffer.byteLength(JSON.stringify(boundary)), 1024 * 1024)
  })
})

test('chunked state transfer round-trips archives over 64 KiB and interrupted transfer commits nothing', async () => {
  const createEmbeddedService = requireService()
  await profiles(async ({ alpha }) => {
    const service = createEmbeddedService({ dataDir: alpha, scan: async () => [] })
    const initial = await readState(service)
    const state = { archived: Array.from({ length: 1800 }, (_, index) => `archive-${index}-${'x'.repeat(40)}`), settings: { theme: 'night' } }
    const bytes = Buffer.from(JSON.stringify(state))
    assert.ok(bytes.length > 64 * 1024)
    const digest = createHash('sha256').update(bytes).digest('hex')
    await assert.rejects(service.invoke('state.write', { state, baseUpdatedAt: initial.updatedAt }), /64 KiB|control.*limit|too large/i)
    await assert.rejects(service.invoke('state.begin', {
      baseUpdatedAt: initial.updatedAt,
      totalBytes: 32 * 1024 * 1024 + 1,
      sha256: '0'.repeat(64),
    }), /32 MiB|size limit|too large/i)
    const transfer = await service.invoke('state.begin', { baseUpdatedAt: initial.updatedAt, totalBytes: bytes.length, sha256: digest })
    const chunkSize = 512 * 1024
    for (let offset = 0, index = 0; offset < bytes.length; offset += chunkSize, index++) {
      const chunk = { transferId: transfer.transferId, index, data: bytes.subarray(offset, offset + chunkSize).toString('base64') }
      assert.ok(Buffer.byteLength(JSON.stringify(chunk)) <= 1024 * 1024)
      await service.invoke('state.chunk', chunk)
    }
    const committed = await service.invoke('state.commit', { transferId: transfer.transferId })
    assert.deepEqual(committed.archived, state.archived)
    assert.deepEqual(committed.settings, state.settings)

    const beforeInterrupted = await readState(service)
    const replacement = Buffer.from(JSON.stringify({ archived: ['must-not-commit'] }))
    const interrupted = await service.invoke('state.begin', {
      baseUpdatedAt: beforeInterrupted.updatedAt,
      totalBytes: replacement.length,
      sha256: createHash('sha256').update(replacement).digest('hex'),
    })
    await service.invoke('state.chunk', { transferId: interrupted.transferId, index: 0, data: replacement.subarray(0, 5).toString('base64') })
    await assert.rejects(service.invoke('state.commit', { transferId: interrupted.transferId }), /incomplete|missing chunk|length/i)
    assert.deepEqual((await readState(service)).archived, state.archived, 'an incomplete transfer must leave committed bytes unchanged')
  })
})

test('stale simultaneous writes have one winner across instances and malformed owned state is preserved', async () => {
  const createEmbeddedService = requireService()
  await profiles(async ({ alpha }) => {
    const first = createEmbeddedService({ dataDir: alpha, scan: async () => [] })
    const second = createEmbeddedService({ dataDir: alpha, scan: async () => [] })
    const base = (await readState(first)).updatedAt
    const outcomes = await Promise.allSettled([
      first.invoke('state.write', { state: { archived: ['first'] }, baseUpdatedAt: base }),
      second.invoke('state.write', { state: { archived: ['second'] }, baseUpdatedAt: base }),
    ])
    assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1)
    assert.match(outcomes.find(item => item.status === 'rejected').reason.message, /conflict/i)
    const saved = await fs.readFile(path.join(alpha, 'colony.json'), 'utf8')
    assert.deepEqual(JSON.parse(saved).archived, (await readState(first)).archived)

    const malformed = '{"not":"a managed state"}'
    await fs.writeFile(path.join(alpha, 'colony.json'), malformed)
    await assert.rejects(readState(first), /unmanaged/i)
    await assert.rejects(first.invoke('state.write', { state: { archived: [] }, baseUpdatedAt: base }), /unmanaged/i)
    assert.equal(await fs.readFile(path.join(alpha, 'colony.json'), 'utf8'), malformed)
  })
})

test('invalid digest, out of order chunks and oversized inventory records are refused', async () => {
  const createEmbeddedService = requireService()
  await profiles(async ({ alpha }) => {
    const service = createEmbeddedService({ dataDir: alpha, scan: async () => [{ id: 'huge', title: 'x'.repeat(1024 * 1024) }] })
    await assert.rejects(service.invoke('inventory.page', {}), /record exceeds 1 MiB/i)
    const bytes = Buffer.from('{"archived":["uncommitted"]}')
    const transfer = await service.invoke('state.begin', {
      baseUpdatedAt: 0, totalBytes: bytes.length, sha256: '0'.repeat(64),
    })
    await assert.rejects(service.invoke('state.chunk', { transferId: transfer.transferId, index: 1, data: bytes.toString('base64') }), /out of order/i)
    await service.invoke('state.chunk', { transferId: transfer.transferId, index: 0, data: bytes.toString('base64') })
    await assert.rejects(service.invoke('state.commit', { transferId: transfer.transferId }), /digest mismatch/i)
    assert.deepEqual((await readState(service)).archived, [])
  })
})

test('pending transfer count and aggregate memory are bounded and cancellation releases capacity', async () => {
  const createEmbeddedService = requireService()
  await profiles(async ({ alpha }) => {
    const service = createEmbeddedService({ dataDir: alpha, scan: async () => [] })
    const metadata = { baseUpdatedAt: 0, sha256: '0'.repeat(64) }
    const first = await service.invoke('state.begin', { ...metadata, totalBytes: 16 * 1024 * 1024 })
    await assert.rejects(service.invoke('state.begin', { ...metadata, totalBytes: 16 * 1024 * 1024 + 1 }), /aggregate limit/i)
    const second = await service.invoke('state.begin', { ...metadata, totalBytes: 1 })
    await assert.rejects(service.invoke('state.begin', { ...metadata, totalBytes: 1 }), /too many state transfers/i)
    await service.invoke('state.cancel', { transferId: first.transferId })
    await service.invoke('state.cancel', { transferId: second.transferId })
    const resumed = await service.invoke('state.begin', { ...metadata, totalBytes: 1 })
    assert.ok(resumed.transferId)
  })
})

test('large state reads use bounded download chunks with a stable digest', async () => {
  const createEmbeddedService = requireService()
  await profiles(async ({ alpha }) => {
    const state = { version: 3, archived: ['x'.repeat(2 * 1024 * 1024)], updatedAt: 7 }
    await fs.writeFile(path.join(alpha, 'colony.json'), JSON.stringify(state))
    const service = createEmbeddedService({ dataDir: alpha, scan: async () => [] })
    const meta = await readState(service)
    assert.ok(meta.transferId)
    assert.ok(meta.totalBytes > 1024 * 1024)
    const chunks = []
    let offset = 0
    do {
      const page = await service.invoke('state.readChunk', { transferId: meta.transferId, offset })
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 1024 * 1024)
      chunks.push(Buffer.from(page.data, 'base64'))
      offset = page.nextOffset
    } while (offset !== null)
    const data = Buffer.concat(chunks)
    assert.equal(data.length, meta.totalBytes)
    assert.equal(createHash('sha256').update(data).digest('hex'), meta.sha256)
    assert.deepEqual(JSON.parse(data).archived, state.archived)
    await service.invoke('state.readCancel', { transferId: meta.transferId })
    await assert.rejects(service.invoke('state.readChunk', { transferId: meta.transferId, offset: 0 }), /unknown/i)
  })
})
