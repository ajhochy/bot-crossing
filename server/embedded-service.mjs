import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createStateStore } from './state-store.mjs'
import { MAX_STATE_BYTES } from './state-model.mjs'

const CONTROL_BYTES = 64 * 1024
const FRAME_BYTES = 1024 * 1024
const MAX_INVENTORY_BYTES = 32 * 1024 * 1024
const MAX_RECORDS = 20_000
const PAGE_SIZE = 250
const LIFETIME_MS = 60_000
const MAX_GENERATIONS = 2
const MAX_TRANSFERS = 2
const artifactRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const bytesOf = value => Buffer.byteLength(JSON.stringify(value))
const reject = message => { throw new Error(message) }

/** The embedded instance owns every snapshot and transfer. Import and construction do no I/O. */
export function createEmbeddedService({ dataDir, scan } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) ||
    path.resolve(dataDir) === artifactRoot || path.resolve(dataDir).startsWith(artifactRoot + path.sep) ||
    typeof scan !== 'function') {
    reject('Embedded Colony requires an absolute profile dataDir and an injected scan adapter')
  }
  const store = createStateStore({ dataDir, ensureActive })
  const generations = new Map()
  const transfers = new Map()
  const downloads = new Map()
  let disposed = false

  function ensureActive() {
    if (disposed) reject('Embedded Colony service has been disposed')
  }

  function cleanup() {
    const now = Date.now()
    for (const [id, value] of generations) if (value.expires <= now) generations.delete(id)
    for (const [id, value] of transfers) if (value.expires <= now) transfers.delete(id)
    for (const [id, value] of downloads) if (value.expires <= now) downloads.delete(id)
  }

  function stateResponse(state) {
    const data = Buffer.from(JSON.stringify(state))
    if (data.length <= FRAME_BYTES) return state
    // New reads and successful writes revoke the prior snapshot, keeping memory bounded.
    downloads.clear()
    const transferId = randomUUID()
    downloads.set(transferId, { data, expires: Date.now() + LIFETIME_MS })
    return { transferId, totalBytes: data.length, sha256: digest(data), updatedAt: state.updatedAt }
  }

  async function save(input, baseUpdatedAt) {
    const result = await store.save(input, baseUpdatedAt)
    ensureActive()
    if (result.conflict) reject('Colony state conflict: reload before saving')
    return stateResponse(result.state)
  }

  return {
    dispose() { disposed = true; generations.clear(); transfers.clear(); downloads.clear() },
    async invoke(method, payload = {}) {
      ensureActive()
      if (!object(payload)) reject('Invalid Colony request')
      cleanup()
      if (method !== 'state.chunk' && bytesOf({ method, payload }) > CONTROL_BYTES) {
        reject('Colony control request exceeds 64 KiB limit')
      }
      if (method === 'state.read') {
        const state = await store.read()
        ensureActive()
        return stateResponse(state)
      }
      if (method === 'state.readChunk') {
        const download = downloads.get(payload.transferId)
        if (!download) reject('Unknown or expired state download')
        if (!Number.isSafeInteger(payload.offset) || payload.offset < 0 || payload.offset >= download.data.length || payload.offset % (512 * 1024) !== 0) {
          reject('Invalid state download offset')
        }
        const end = Math.min(payload.offset + 512 * 1024, download.data.length)
        return { transferId: payload.transferId, offset: payload.offset,
          data: download.data.subarray(payload.offset, end).toString('base64'),
          nextOffset: end < download.data.length ? end : null }
      }
      if (method === 'state.readCancel') {
        if (typeof payload.transferId !== 'string' || !downloads.delete(payload.transferId)) reject('Unknown state download')
        return { cancelled: true }
      }
      if (method === 'state.write') return save(payload.state, payload.baseUpdatedAt)
      if (method === 'inventory.page') {
        const limit = payload.limit === undefined ? PAGE_SIZE : payload.limit
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_SIZE) reject('Inventory page limit must be 1–250')
        let generation = payload.generation
        if (!generation) {
          if (payload.cursor !== undefined) reject('Inventory cursor requires a generation')
          const records = await scan()
          ensureActive()
          if (!Array.isArray(records) || records.length > MAX_RECORDS) reject('Inventory record count exceeds limit')
          let size = 0
          for (const record of records) {
            if (!object(record)) reject('Invalid inventory record')
            const recordSize = bytesOf(record)
            if (recordSize > FRAME_BYTES) reject('Inventory record exceeds 1 MiB page limit')
            size += recordSize
            if (size > MAX_INVENTORY_BYTES) reject('Inventory snapshot exceeds 32 MiB limit')
          }
          if (generations.size >= MAX_GENERATIONS) reject('Too many active inventory generations')
          generation = randomUUID()
          generations.set(generation, { records: structuredClone(records), expires: Date.now() + LIFETIME_MS })
        }
        ensureActive()
        const snapshot = generations.get(generation)
        if (!snapshot) reject('Unknown, cancelled or expired inventory generation')
        const start = payload.cursor === undefined ? 0 : Number(payload.cursor)
        if (!Number.isSafeInteger(start) || start < 0 || start > snapshot.records.length || String(start) !== String(payload.cursor ?? 0)) {
          reject('Invalid inventory cursor')
        }
        let end = start
        let recordBytes = 0
        while (end < snapshot.records.length && end - start < limit) {
          const nextEnd = end + 1
          const nextCursor = nextEnd < snapshot.records.length ? String(nextEnd) : null
          const nextRecordBytes = recordBytes + bytesOf(snapshot.records[end])
          const frameSize = bytesOf({ generation, records: [], nextCursor }) +
            nextRecordBytes + (nextEnd - start - 1)
          if (frameSize > FRAME_BYTES) break
          recordBytes = nextRecordBytes
          end = nextEnd
        }
        if (end === start && start < snapshot.records.length) reject('Inventory record exceeds 1 MiB page limit')
        return { generation, records: snapshot.records.slice(start, end), nextCursor: end < snapshot.records.length ? String(end) : null }
      }
      if (method === 'inventory.cancel') {
        if (typeof payload.generation !== 'string' || !generations.delete(payload.generation)) reject('Unknown inventory generation')
        return { cancelled: true }
      }
      if (method === 'state.begin') {
        if (!Number.isSafeInteger(payload.totalBytes) || payload.totalBytes < 1 || payload.totalBytes > MAX_STATE_BYTES) reject('State transfer exceeds 32 MiB size limit')
        if (!Number.isSafeInteger(payload.baseUpdatedAt) || payload.baseUpdatedAt < 0 || !/^[0-9a-f]{64}$/i.test(payload.sha256 || '')) reject('Invalid state transfer metadata')
        if (transfers.size >= MAX_TRANSFERS || [...transfers.values()].reduce((sum, item) => sum + item.totalBytes, payload.totalBytes) > MAX_STATE_BYTES) {
          reject('Too many state transfers or 32 MiB aggregate limit')
        }
        const transferId = randomUUID()
        transfers.set(transferId, { totalBytes: payload.totalBytes, baseUpdatedAt: payload.baseUpdatedAt,
          sha256: payload.sha256.toLowerCase(), chunks: [], received: 0, expires: Date.now() + LIFETIME_MS })
        return { transferId }
      }
      if (method === 'state.chunk') {
        if (bytesOf({ method, payload }) > FRAME_BYTES) reject('State chunk exceeds 1 MiB frame limit')
        const transfer = transfers.get(payload.transferId)
        if (!transfer) reject('Unknown or expired state transfer')
        if (!Number.isSafeInteger(payload.index) || payload.index !== transfer.chunks.length) reject('State chunk out of order')
        if (typeof payload.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload.data)) reject('Invalid base64 state chunk')
        const chunk = Buffer.from(payload.data, 'base64')
        if (!chunk.length || chunk.length > FRAME_BYTES || transfer.received + chunk.length > transfer.totalBytes) reject('State chunk exceeds size limit')
        transfer.chunks.push(chunk)
        transfer.received += chunk.length
        return { received: transfer.received }
      }
      if (method === 'state.cancel') {
        if (typeof payload.transferId !== 'string' || !transfers.delete(payload.transferId)) reject('Unknown state transfer')
        return { cancelled: true }
      }
      if (method === 'state.commit') {
        const transfer = transfers.get(payload.transferId)
        if (!transfer) reject('Unknown or expired state transfer')
        if (transfer.received !== transfer.totalBytes) reject('Incomplete state transfer: missing chunk bytes')
        transfers.delete(payload.transferId)
        const data = Buffer.concat(transfer.chunks, transfer.received)
        if (digest(data) !== transfer.sha256) reject('State transfer digest mismatch')
        let state
        try { state = JSON.parse(data.toString('utf8')) }
        catch { reject('Malformed state transfer JSON') }
        return save(state, transfer.baseUpdatedAt)
      }
      reject(`Unsupported embedded Colony method: ${String(method)}`)
    },
  }
}
