import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createStateStore, readImportState } from './state-store.mjs'
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
export function createEmbeddedService({ dataDir, scan, importBeforeRename = () => {} } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) ||
    path.resolve(dataDir) === artifactRoot || path.resolve(dataDir).startsWith(artifactRoot + path.sep) ||
    typeof scan !== 'function') {
    reject('Embedded Colony requires an absolute profile dataDir and an injected scan adapter')
  }
  const store = createStateStore({ dataDir, ensureActive })
  const generations = new Map()
  const pendingGenerations = new Map()
  const transfers = new Map()
  const downloads = new Map()
  let disposed = false
  let cachedGeneration = null

  function ensureActive() {
    if (disposed) reject('Embedded Colony service has been disposed')
  }

  function cleanup() {
    const now = Date.now()
    for (const [id, value] of generations) if (value.expires <= now) generations.delete(id)
    for (const [id, value] of transfers) if (value.expires <= now) transfers.delete(id)
    for (const [id, value] of downloads) if (value.expires <= now) downloads.delete(id)
  }

  function stateResponse(state, maxResultBytes = FRAME_BYTES) {
    const data = Buffer.from(JSON.stringify(state))
    if (data.length <= maxResultBytes) return state
    // New reads and successful writes revoke the prior snapshot, keeping memory bounded.
    downloads.clear()
    const transferId = randomUUID()
    downloads.set(transferId, { data, expires: Date.now() + LIFETIME_MS })
    return { transferId, totalBytes: data.length, sha256: digest(data), updatedAt: state.updatedAt }
  }

  async function save(input, baseUpdatedAt, maxResultBytes) {
    const result = await store.save(input, baseUpdatedAt)
    ensureActive()
    if (result.conflict) reject('Colony state conflict: reload before saving')
    return stateResponse(result.state, maxResultBytes)
  }

  const importPreview = async file => {
    ensureActive()
    const state = await readImportState(file)
    ensureActive()
    return { archived: state.archived.length, viewed: Object.keys(state.viewedAt).length,
      groups: Object.keys(state.projectOverrides).length, version: state.version }
  }
  const importCommit = async file => {
    ensureActive()
    const imported = await readImportState(file)
    const current = await store.read()
    ensureActive()
    const newest = (left = {}, right = {}) => {
      const result = { ...left }
      for (const [key, value] of Object.entries(right)) if (!Number.isFinite(result[key]) || value > result[key]) result[key] = value
      return result
    }
    const merged = {
      ...imported,
      ...current,
      archived: [...new Set([...current.archived, ...imported.archived])],
      archivedAt: newest(current.archivedAt, imported.archivedAt),
      opened: [...new Set([...current.opened, ...imported.opened])],
      hiddenProjects: [...new Set([...current.hiddenProjects, ...imported.hiddenProjects])],
      viewedAt: newest(current.viewedAt, imported.viewedAt),
      projectOverrides: { ...imported.projectOverrides, ...current.projectOverrides },
      projectAliases: { ...imported.projectAliases, ...current.projectAliases },
      projectMigrations: { ...imported.projectMigrations, ...current.projectMigrations },
      sessionMigrations: { ...imported.sessionMigrations, ...current.sessionMigrations },
      plots: { ...imported.plots, ...current.plots },
      seen: newest(imported.seen, current.seen),
      settings: current.settings ?? imported.settings,
    }
    return store.replace(merged, importBeforeRename)
  }
  return {
    dispose() { disposed = true; generations.clear(); pendingGenerations.clear(); transfers.clear(); downloads.clear() },
    importPreview,
    importCommit,
    backupRestore: name => store.restoreBackup(name, importBeforeRename),
    async invoke(method, payload = {}, { maxResultBytes = FRAME_BYTES } = {}) {
      ensureActive()
      if (!object(payload)) reject('Invalid Colony request')
      if (!Number.isSafeInteger(maxResultBytes) || maxResultBytes < 1024 || maxResultBytes > FRAME_BYTES) reject('Invalid Colony response budget')
      cleanup()
      if (method !== 'state.chunk' && bytesOf({ method, payload }) > CONTROL_BYTES) {
        reject('Colony control request exceeds 64 KiB limit')
      }
      if (method === 'state.read') {
        const state = await store.read()
        ensureActive()
        return stateResponse(state, maxResultBytes)
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
      if (method === 'state.write') return save(payload.state, payload.baseUpdatedAt, maxResultBytes)
      if (method === 'state.mark') {
        if (typeof payload.threadId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(payload.threadId) ||
          (!Object.hasOwn(payload, 'archived') && !Object.hasOwn(payload, 'viewedAt')) ||
          (Object.hasOwn(payload, 'archived') && typeof payload.archived !== 'boolean') ||
          (Object.hasOwn(payload, 'viewedAt') && (!Number.isSafeInteger(payload.viewedAt) || payload.viewedAt < 0)) ||
          Object.keys(payload).some(key => !['threadId', 'archived', 'viewedAt'].includes(key))) reject('Invalid state mark request')
        return stateResponse(await store.mark(payload.threadId, payload), maxResultBytes)
      }
      if (method === 'inventory.page') {
        const limit = payload.limit === undefined ? PAGE_SIZE : payload.limit
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_SIZE) reject('Inventory page limit must be 1–250')
        const collection = payload.collection ?? 'threads'
        if (!['threads', 'projects', 'warnings'].includes(collection)) reject('Invalid inventory collection')
        let generation = payload.generation
        if (!generation && cachedGeneration && generations.has(cachedGeneration)) generation = cachedGeneration
        if (!generation) {
          if (payload.cursor !== undefined) reject('Inventory cursor requires a generation')
          generation = randomUUID()
        }
        if (!generations.has(generation)) {
          if (payload.cursor !== undefined) reject('Unknown, cancelled or expired inventory generation')
          let pending = pendingGenerations.get(generation)
          if (!pending) {
            if (generations.size + pendingGenerations.size >= MAX_GENERATIONS) reject('Too many active inventory generations')
            const token = { cancelled: false, promise: null }
            token.promise = (async () => {
            const observed = await scan()
            if (token.cancelled) reject('Cancelled inventory generation')
            ensureActive()
            const legacy = Array.isArray(observed)
            const collections = legacy ? { threads: observed, projects: [], warnings: [] } : observed
            if (!object(collections)) reject('Invalid inventory snapshot')
            let count = 0
            let size = 0
            for (const collection of ['threads', 'projects', 'warnings']) {
              const records = collections[collection]
              if (!Array.isArray(records)) reject('Invalid inventory collection')
              count += records.length
              if (count > MAX_RECORDS) reject('Inventory record count exceeds limit')
              for (const record of records) {
                if (collection === 'warnings' ? typeof record !== 'string' : !object(record)) reject('Invalid inventory record')
                const recordBytes = bytesOf(record)
                if (recordBytes > FRAME_BYTES) reject('Inventory record exceeds 1 MiB page limit')
                size += recordBytes
                if (size > MAX_INVENTORY_BYTES) reject('Inventory snapshot exceeds 32 MiB limit')
              }
            }
            const scannedAt = legacy ? Date.now() : collections.scannedAt
            if (!Number.isSafeInteger(scannedAt) || scannedAt < 0) reject('Invalid scan timestamp')
            const snapshot = { threads: collections.threads, projects: collections.projects, warnings: collections.warnings, scannedAt }
            if (bytesOf(snapshot) > MAX_INVENTORY_BYTES) reject('Inventory snapshot exceeds 32 MiB limit')
            if (generations.size >= MAX_GENERATIONS) reject('Too many active inventory generations')
            // Match the standalone JSON DTO: absent optional adapter fields are
            // omitted, rather than forwarding JavaScript undefined over IPC.
            generations.set(generation, { ...JSON.parse(JSON.stringify(snapshot)), legacy, expires: Date.now() + LIFETIME_MS })
            cachedGeneration = generation
            })().finally(() => { pendingGenerations.delete(generation) })
            pendingGenerations.set(generation, token)
            pending = token
          }
          await pending.promise
          if (pending.cancelled) reject('Cancelled inventory generation')
        }
        ensureActive()
        const snapshot = generations.get(generation)
        if (!snapshot) reject('Unknown, cancelled or expired inventory generation')
        const records = snapshot[collection]
        const metadata = snapshot.legacy && payload.collection === undefined ? {} : { collection, scannedAt: snapshot.scannedAt }
        const start = payload.cursor === undefined ? 0 : Number(payload.cursor)
        if (!Number.isSafeInteger(start) || start < 0 || start > records.length || String(start) !== String(payload.cursor ?? 0)) {
          reject('Invalid inventory cursor')
        }
        let end = start
        let recordBytes = 0
        while (end < records.length && end - start < limit) {
          const nextEnd = end + 1
          const nextCursor = nextEnd < records.length ? String(nextEnd) : null
          const nextRecordBytes = recordBytes + bytesOf(records[end])
          const frameSize = bytesOf({ generation, ...metadata, records: [], nextCursor }) + nextRecordBytes + (nextEnd - start - 1)
          if (frameSize > maxResultBytes) break
          recordBytes = nextRecordBytes
          end = nextEnd
        }
        if (end === start && start < records.length) reject('Inventory record exceeds 1 MiB page limit')
        return { generation, ...metadata, records: records.slice(start, end), nextCursor: end < records.length ? String(end) : null }
      }

      if (method === 'inventory.cancel') {
        const pending = pendingGenerations.get(payload.generation)
        if (pending) {
          pending.cancelled = true
          pendingGenerations.delete(payload.generation)
        } else if (typeof payload.generation !== 'string' || !generations.delete(payload.generation)) reject('Unknown inventory generation')
        if (cachedGeneration === payload.generation) cachedGeneration = null
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
        return save(state, transfer.baseUpdatedAt, maxResultBytes)
      }
      reject(`Unsupported embedded Colony method: ${String(method)}`)
    },
  }
}
