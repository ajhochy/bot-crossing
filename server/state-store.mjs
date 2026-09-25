import fs from 'node:fs/promises'
import path from 'node:path'
import { constants, renameSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { emptyState, normalizeState, MAX_STATE_BYTES } from './state-model.mjs'

const locks = new Map()
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const reject = message => { throw new Error(message) }

export async function readImportState(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) reject('Colony import path must be absolute')
  let handle
  try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch { reject('Colony import is unreadable; source left untouched') }
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size < 1 || before.size > MAX_STATE_BYTES) reject('Colony import exceeds 32 MiB or is not a file')
    const blocks = []
    let count = 0
    while (count <= MAX_STATE_BYTES) {
      const block = Buffer.alloc(Math.min(64 * 1024, MAX_STATE_BYTES + 1 - count))
      const { bytesRead } = await handle.read(block, 0, block.length, count)
      if (!bytesRead) break
      blocks.push(block.subarray(0, bytesRead))
      count += bytesRead
    }
    if (count > MAX_STATE_BYTES) reject('Colony import exceeds 32 MiB; source left untouched')
    const raw = Buffer.concat(blocks)
    const after = await handle.stat()
    if (count !== before.size || after.size !== before.size || after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs) reject('Colony import changed while reading; source left untouched')
    let parsed
    try { parsed = JSON.parse(raw.toString('utf8')) } catch { reject('Colony import is malformed; source left untouched') }
    if (![1, 2, 3].includes(parsed?.version)) reject('Unsupported Colony import version; source left untouched')
    return normalizeState(parsed, { mode: 'strict', saved: true })
  } finally { await handle.close() }
}

async function ownedDir(dataDir) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(dataDir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) reject('Colony profile data directory must be a real directory')
}

async function readSaved(file, mode) {
  let handle
  try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error) {
    if (error.code === 'ENOENT') return { state: emptyState(), fingerprint: null }
    throw new Error('Colony state is unmanaged or unreadable; saved file left untouched')
  }
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > MAX_STATE_BYTES || before.size < 0) {
      reject('Colony state is unmanaged or exceeds 32 MiB; saved file left untouched')
    }
    const blocks = []
    let count = 0
    while (count <= MAX_STATE_BYTES) {
      const block = Buffer.alloc(Math.min(64 * 1024, MAX_STATE_BYTES + 1 - count))
      const { bytesRead } = await handle.read(block, 0, block.length, count)
      if (!bytesRead) break
      blocks.push(block.subarray(0, bytesRead))
      count += bytesRead
    }
    if (count > MAX_STATE_BYTES) reject('Colony state exceeds 32 MiB; saved file left untouched')
    const after = await handle.stat()
    if (after.size !== count || after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs) {
      reject('Colony state changed while reading; saved file left untouched')
    }
    const raw = Buffer.concat(blocks)
    const parsed = JSON.parse(raw.toString('utf8'))
    const state = normalizeState(parsed, { mode, saved: true })
    return { state, fingerprint: digest(raw) }
  } catch (error) {
    if (error.message?.startsWith('Colony state')) throw error
    throw new Error('Colony state is unmanaged or malformed; saved file left untouched')
  } finally { await handle.close() }
}

async function locked(file, action) {
  const previous = locks.get(file) || Promise.resolve()
  const next = previous.catch(() => {}).then(action)
  locks.set(file, next)
  try { return await next }
  finally { if (locks.get(file) === next) locks.delete(file) }
}

/** Explicit adapters share the same filesystem protections and per-file serialization. */
export function createStateStore({ dataDir, mode = 'strict', ensureActive = () => {} }) {
  if (!path.isAbsolute(dataDir) || !['strict', 'http'].includes(mode)) {
    reject('Colony state store requires an absolute directory and supported validation mode')
  }
  const file = path.join(path.resolve(dataDir), 'colony.json')
  const backups = path.join(path.resolve(dataDir), 'backups')

  async function replace(nextInput, beforeRename = () => {}) {
    return locked(file, async () => {
      ensureActive()
      await ownedDir(path.dirname(file))
      const before = await readSaved(file, mode)
      const next = normalizeState(nextInput, { mode, previous: before.state })
      if (JSON.stringify({ ...before.state, updatedAt: 0 }) === JSON.stringify({ ...next, updatedAt: 0 })) return before.state
      await ownedDir(backups)
      const backup = path.join(backups, `state-${before.state.updatedAt}.json`)
      await fs.writeFile(backup, JSON.stringify(before.state), { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error })
      const current = await readSaved(file, mode)
      if (current.fingerprint !== before.fingerprint) reject('Colony state conflict: reload before importing')
      const temp = `${file}.${randomUUID()}.tmp`
      let committed = false
      try {
        const handle = await fs.open(temp, 'wx', 0o600)
        try { await handle.writeFile(JSON.stringify(next)); await handle.sync() } finally { await handle.close() }
        ensureActive()
        await beforeRename()
        const last = await readSaved(file, mode)
        if (last.fingerprint !== before.fingerprint) reject('Colony state conflict: reload before importing')
        renameSync(temp, file)
        committed = true
      } finally { if (!committed) await fs.rm(temp, { force: true }).catch(() => {}) }
      return next
    })
  }
  async function save(input, baseUpdatedAt) {
    ensureActive()
    if (mode === 'strict' && (!Number.isSafeInteger(baseUpdatedAt) || baseUpdatedAt < 0)) reject('A valid baseUpdatedAt is required')
    const base = mode === 'http' ? Number(baseUpdatedAt) || 0 : baseUpdatedAt
    return locked(file, async () => {
      ensureActive()
      await ownedDir(path.dirname(file))
      ensureActive()
      const before = await readSaved(file, mode)
      ensureActive()
      if (!(mode === 'http' && base === 0) && before.state.updatedAt !== base) {
        return { conflict: true, state: before.state }
      }
      const next = normalizeState(input, { mode, previous: before.state })
      const current = await readSaved(file, mode)
      ensureActive()
      if (current.fingerprint !== before.fingerprint) return { conflict: true, state: current.state }
      const temp = `${file}.${randomUUID()}.tmp`
      let committed = false
      try {
        ensureActive()
        const handle = await fs.open(temp, 'wx', 0o600)
        try {
          ensureActive()
          await handle.writeFile(JSON.stringify(next))
          ensureActive()
          await handle.sync()
          ensureActive()
        }
        finally { await handle.close() }
        const last = await readSaved(file, mode)
        if (last.fingerprint !== before.fingerprint) return { conflict: true, state: last.state }
        // Keep the disposal check and atomic commit in one JS turn.
        ensureActive()
        renameSync(temp, file)
        committed = true
      } finally { if (!committed) await fs.rm(temp, { force: true }).catch(() => {}) }
      return { conflict: false, state: next }
    })
  }

  return {
    async read() {
      ensureActive()
      // Preserve standalone GET's read-only missing-directory behavior.
      if (mode === 'strict') await ownedDir(path.dirname(file))
      ensureActive()
      const saved = await readSaved(file, mode)
      ensureActive()
      return saved.state
    },
    mark(threadId, { archived, viewedAt } = {}) {
      ensureActive()
      return locked(file, async () => {
        ensureActive()
        await ownedDir(path.dirname(file))
        const before = await readSaved(file, mode)
        ensureActive()
        const input = structuredClone(before.state)
        if (archived === true) {
          input.archived = [...new Set([...input.archived, threadId])]
          input.archivedAt = { ...input.archivedAt, [threadId]: Date.now() }
        } else if (archived === false) {
          input.archived = input.archived.filter(id => id !== threadId)
          input.archivedAt = { ...input.archivedAt }
          delete input.archivedAt[threadId]
        }
        if (viewedAt !== undefined) input.viewedAt = { ...input.viewedAt, [threadId]: viewedAt }
        const next = normalizeState(input, { mode, previous: before.state })
        const current = await readSaved(file, mode)
        ensureActive()
        if (current.fingerprint !== before.fingerprint) reject('Colony state conflict: reload before saving')
        const temp = `${file}.${randomUUID()}.tmp`
        let committed = false
        try {
          const handle = await fs.open(temp, 'wx', 0o600)
          try { await handle.writeFile(JSON.stringify(next)); await handle.sync(); ensureActive() }
          finally { await handle.close() }
          const last = await readSaved(file, mode)
          if (last.fingerprint !== before.fingerprint) reject('Colony state conflict: reload before saving')
          ensureActive()
          renameSync(temp, file)
          committed = true
        } finally { if (!committed) await fs.rm(temp, { force: true }).catch(() => {}) }
        return next
      })
    },
    replace,
    async restoreBackup(name, beforeRename) {
      if (typeof name !== 'string' || !/^state-[0-9]+\.json$/.test(name)) reject('Invalid Colony backup identity')
      const restored = await readImportState(path.join(backups, name))
      return replace(restored, beforeRename)
    },
    save,
  }
}
