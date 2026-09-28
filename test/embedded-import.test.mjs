import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createEmbeddedService } from '../server/embedded-service.mjs'
import { createProtocolSession } from '../server/embedded-protocol.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')

async function fixture(run, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-import-'))
  const dataDir = path.join(root, 'owned')
  const source = path.join(root, 'standalone.json')
  await fs.mkdir(dataDir)
  const service = createEmbeddedService({ dataDir, scan: async () => [], ...options })
  try { await run({ root, dataDir, source, service }) }
  finally { service.dispose(); await fs.rm(root, { recursive: true, force: true }) }
}

test('parent import previews and idempotently merges 7,000 archives without changing source bytes', async () => {
  await fixture(async ({ source, service, dataDir }) => {
    const imported = { version: 3, archived: Array.from({ length: 7000 }, (_, i) => `codex:archive-${i}`),
      archivedAt: Object.fromEntries(Array.from({ length: 7000 }, (_, i) => [`codex:archive-${i}`, i + 1])),
      viewedAt: { 'codex:viewed': 50 }, projectOverrides: { imported: 'group' }, updatedAt: 77 }
    const bytes = Buffer.from(JSON.stringify(imported))
    await fs.writeFile(source, bytes)
    const before = hash(bytes)
    const preview = await service.importPreview(source)
    assert.deepEqual(preview, { archived: 7000, viewed: 1, groups: 1, version: 3 })
    const initial = await service.invoke('state.read')
    await service.invoke('state.write', { state: { ...initial, hiddenProjects: ['current'], projectOverrides: { current: 'kept' } }, baseUpdatedAt: initial.updatedAt })
    const first = await service.importCommit(source)
    assert.equal(first.archived.length, 7000)
    assert.deepEqual(first.hiddenProjects, ['current'])
    assert.deepEqual(first.projectOverrides, { imported: 'group', current: 'kept' })
    const backupFiles = await fs.readdir(path.join(dataDir, 'backups'))
    assert.equal(backupFiles.length, 1)
    const second = await service.importCommit(source)
    assert.equal(second.updatedAt, first.updatedAt)
    assert.deepEqual(await fs.readdir(path.join(dataDir, 'backups')), backupFiles)
    assert.equal(hash(await fs.readFile(source)), before)
  })
})

test('corrupt, oversized, unsupported and interrupted imports preserve the last valid state', async () => {
  await fixture(async ({ source, service, dataDir }) => {
    const initial = await service.invoke('state.read')
    const valid = await service.invoke('state.write', { state: { ...initial, archived: ['current'] }, baseUpdatedAt: initial.updatedAt })
    for (const value of ['{broken', JSON.stringify({ version: 99, archived: [], updatedAt: 1 })]) {
      await fs.writeFile(source, value)
      await assert.rejects(service.importCommit(source), /malformed|version|unsupported|unmanaged/i)
      assert.deepEqual((await service.invoke('state.read')).archived, ['current'])
    }
    await fs.writeFile(source, Buffer.alloc(32 * 1024 * 1024 + 1))
    await assert.rejects(service.importPreview(source), /32 MiB|oversized|exceeds/i)
    assert.equal((await service.invoke('state.read')).updatedAt, valid.updatedAt)
    assert.equal(await fs.stat(path.join(dataDir, 'colony.json')).then(stat => stat.isFile()), true)
  }, { importBeforeRename: () => {} })

  let crash = false
  await fixture(async ({ source, service }) => {
    const initial = await service.invoke('state.read')
    await service.invoke('state.write', { state: { ...initial, archived: ['current'] }, baseUpdatedAt: initial.updatedAt })
    await fs.writeFile(source, JSON.stringify({ version: 3, archived: ['imported'], updatedAt: 4 }))
    crash = true
    await assert.rejects(service.importCommit(source), /injected/i)
    assert.deepEqual((await service.invoke('state.read')).archived, ['current'])
  }, { importBeforeRename: () => { if (crash) throw new Error('injected import crash') } })
})

test('backup restore returns the prior compatible state and scene requests cannot import', async () => {
  await fixture(async ({ source, service, dataDir }) => {
    const initial = await service.invoke('state.read')
    const prior = await service.invoke('state.write', { state: { ...initial, archived: ['prior'] }, baseUpdatedAt: initial.updatedAt })
    await fs.writeFile(source, JSON.stringify({ version: 3, archived: ['next'], updatedAt: 9 }))
    await service.importCommit(source)
    const [backup] = await fs.readdir(path.join(dataDir, 'backups'))
    const restored = await service.backupRestore(backup)
    assert.deepEqual(restored.archived, prior.archived)

    const protocol = createProtocolSession({ service, documentId: 'owned-document' })
    const response = await protocol.handle({ v: 1, documentId: 'owned-document', id: 'import-1', method: 'colony:import-preview', payload: { path: source } })
    assert.equal(response.ok, false)
    assert.equal(response.error.code, 'unsupported_method')
    protocol.dispose()
  })
})
