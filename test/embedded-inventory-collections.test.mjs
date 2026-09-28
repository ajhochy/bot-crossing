import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createEmbeddedService } from '../server/embedded-service.mjs'

async function fixture(scan, run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-collection-contract-'))
  const service = createEmbeddedService({ dataDir: dir, scan })
  try { await run(service) }
  finally { service.dispose(); await fs.rm(dir, { recursive: true, force: true }) }
}

test('all inventory collections share one frozen scan and exact timestamp', async () => {
  const source = { threads: [{ id: 't' }], projects: [{ id: 'p' }], warnings: ['offline source'], scannedAt: 45 }
  let scans = 0
  await fixture(() => { scans++; return source }, async service => {
    assert.equal(scans, 0)
    const first = await service.invoke('inventory.page', { collection: 'threads', limit: 250 })
    source.projects[0].id = 'mutated-after-scan'
    const projectPage = await service.invoke('inventory.page', { generation: first.generation, collection: 'projects', limit: 250 })
    const warningPage = await service.invoke('inventory.page', { generation: first.generation, collection: 'warnings', limit: 250 })
    assert.deepEqual(projectPage.records, [{ id: 'p' }])
    assert.deepEqual(warningPage.records, ['offline source'])
    assert.equal(projectPage.scannedAt, 45)
    assert.equal(warningPage.scannedAt, 45)
    assert.equal(scans, 1)
  })
})

test('inventory aggregate bound counts projects as well as threads', async () => {
  const record = { title: 'x'.repeat(450_000) }
  await fixture(() => ({ threads: Array.from({ length: 40 }, () => ({ ...record })),
    projects: Array.from({ length: 40 }, () => ({ ...record })), warnings: [], scannedAt: 1 }), async service => {
    await assert.rejects(service.invoke('inventory.page', { collection: 'threads' }), /32 MiB/)
  })
})

test('pending scans reserve generation capacity before reading another source snapshot', async () => {
  const releases = []
  await fixture(() => new Promise(resolve => releases.push(resolve)), async service => {
    const first = service.invoke('inventory.page', {})
    const second = service.invoke('inventory.page', {})
    const refusal = service.invoke('inventory.page', {})
    let settled = false
    refusal.then(() => { settled = true }, () => { settled = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(releases.length, 2, 'the third scan must be refused before source reads')
    assert.equal(settled, true)
    await assert.rejects(refusal, /generation|capacity|scan/i)
    service.dispose()
    for (const release of releases) release([])
    await Promise.allSettled([first, second])
  })
})
