import fs from 'node:fs/promises'
import path from 'node:path'
import { constants, renameSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { emptyState, normalizeState, MAX_STATE_BYTES } from './state-model.mjs'

const locks = new Map()
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const reject = message => { throw new Error(message) }

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
    save,
  }
}
