import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createEmbeddedTransport } from '../src/game/embedded-api.js'
import { createEmbeddedService } from '../server/embedded-service.mjs'
import { createProtocolSession } from '../server/embedded-protocol.mjs'

async function fixture(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-state-metadata-'))
  const service = createEmbeddedService({ dataDir: dir, scan: () => [] })
  const protocol = createProtocolSession({ service, documentId: 'metadata-document' })
  let id = 0
  const transport = createEmbeddedTransport({ product: 'colony', protocolVersion: 1, request: async (method, payload = {}) => {
    const response = await protocol.handle({ v: 1, documentId: 'metadata-document', id: `request-${++id}`, method, payload })
    if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code })
    return response.result
  } })
  try { await run({ transport, file: path.join(dir, 'colony.json') }) }
  finally { protocol.dispose(); await fs.rm(dir, { recursive: true, force: true }) }
}

test('valid v3 state may retain opaque transferId metadata without becoming a download descriptor', async () => {
  await fixture(async ({ transport, file }) => {
    const source = { version: 3, updatedAt: 4, archived: ['retained'], transferId: 'user-owned-metadata',
      totalBytes: { opaque: true }, sha256: 'not-a-transport-digest' }
    await fs.writeFile(file, JSON.stringify(source))
    const state = await transport.readState()
    assert.deepEqual(state.archived, source.archived)
    assert.equal(state.transferId, source.transferId)
    assert.deepEqual(state.totalBytes, source.totalBytes)
    assert.equal(state.sha256, source.sha256)
  })
})

test('saving opaque transfer metadata returns success as well as retaining saved bytes', async () => {
  await fixture(async ({ transport, file }) => {
    const base = await transport.readState()
    const saved = await transport.writeState({ ...base, transferId: 'opaque-preference', archived: ['saved'] }, base.updatedAt)
    assert.equal(saved.transferId, 'opaque-preference')
    assert.deepEqual(saved.archived, ['saved'])
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).transferId, 'opaque-preference')
  })
})
