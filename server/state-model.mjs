export const MAX_STATE_BYTES = 32 * 1024 * 1024

const arrayFields = ['archived', 'opened', 'hiddenProjects']
const mapFields = ['archivedAt', 'plots', 'seen', 'viewedAt', 'projectOverrides', 'projectAliases', 'projectMigrations', 'sessionMigrations']
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const asObject = value => object(value) ? value : {}
const asArray = value => Array.isArray(value) ? value : []
const reject = message => { throw new Error(message) }

export function emptyState() {
  return {
    version: 3, archived: [], archivedAt: {}, opened: [], plots: {}, seen: {},
    hiddenProjects: [], viewedAt: {}, projectOverrides: {}, projectAliases: {},
    projectMigrations: {}, sessionMigrations: {}, settings: null, updatedAt: 0,
  }
}

function migrate(state) {
  const bareUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const id = value => bareUuid.test(value) ? `claude-code:${value}` : value
  const keys = value => Object.fromEntries(Object.entries(asObject(value)).map(([key, item]) => [id(key), item]))
  for (const key of ['archived', 'opened']) state[key] = asArray(state[key]).map(id)
  for (const key of ['archivedAt', 'seen', 'viewedAt']) state[key] = keys(state[key])
}

/** Unknown JSON fields are opaque state. Only adapter metadata is discarded. */
export function normalizeState(input, { mode = 'strict', saved = false, previous } = {}) {
  if (mode === 'strict') {
    if (!object(input)) reject('Colony state must be an object')
    if (saved && (![1, 2, 3].includes(input.version) || !Number.isSafeInteger(input.updatedAt) || input.updatedAt < 0)) {
      reject('Colony state is unmanaged; saved file left untouched')
    }
  } else if (input === null || input === undefined) {
    reject('Colony state could not be read; saved file left untouched')
  }
  const next = { ...emptyState(), ...input, version: 3 }
  delete next.baseUpdatedAt
  for (const key of arrayFields) {
    if (mode === 'http') next[key] = asArray(next[key])
    else if (!Array.isArray(next[key])) reject(`Colony state is unmanaged: invalid ${key}`)
  }
  for (const key of mapFields) {
    if (mode === 'http') next[key] = asObject(next[key])
    else if (!object(next[key])) reject(`Colony state is unmanaged: invalid ${key}`)
  }
  if (mode === 'http') {
    next.hiddenProjects = next.hiddenProjects.map(String).filter(Boolean)
    // Standalone historically permits an object or array settings blob.
    next.settings = next.settings && typeof next.settings === 'object' ? next.settings : null
    next.updatedAt = Number(input.updatedAt) || 0
  } else if (next.settings !== null && !object(next.settings)) {
    reject('Colony state is unmanaged: invalid settings')
  }
  if (saved && (mode === 'http' ? !(Number(input.version) >= 2) : input.version === 1)) migrate(next)
  if (previous) next.updatedAt = Math.max(Date.now(), previous.updatedAt + 1)
  if (Buffer.byteLength(JSON.stringify(next)) > MAX_STATE_BYTES) reject('Colony state exceeds 32 MiB size limit')
  return next
}
