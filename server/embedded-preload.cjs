// Self-contained sandbox validator; keep schemas aligned with embedded-protocol.mjs.
const { contextBridge, ipcRenderer } = require('electron')
const CONTROL_BYTES = 64 * 1024
const FRAME_BYTES = 1024 * 1024
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = value => Number.isSafeInteger(value) && value >= 0
const bytes = value => Buffer.byteLength(JSON.stringify(value))
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
const schemas = {
  'state.read': [[], []],
  'state.write': [['state', 'baseUpdatedAt'], []],
  'state.begin': [['baseUpdatedAt', 'totalBytes', 'sha256'], []],
  'state.chunk': [['transferId', 'index', 'data'], []],
  'state.commit': [['transferId'], []],
  'state.cancel': [['transferId'], []],
  'state.readChunk': [['transferId', 'offset'], []],
  'state.readCancel': [['transferId'], []],
  'inventory.page': [[], ['generation', 'cursor', 'collection', 'limit']],
  'inventory.cancel': [['generation'], []],
}

function jsonOnly(value) {
  const pending = [{ value, depth: 0 }]
  const ancestors = new Set()
  while (pending.length) {
    const { value: item, depth, exit } = pending.pop()
    if (exit) { ancestors.delete(item); continue }
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) continue
    if (!item || typeof item !== 'object' || depth > 64 || ancestors.has(item)) fail('invalid_request', 'Expected bounded JSON data')
    ancestors.add(item)
    pending.push({ value: item, exit: true })
    if (Object.prototype.toString.call(item) !== (Array.isArray(item) ? '[object Array]' : '[object Object]')) fail('invalid_request', 'Expected plain JSON data')
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === 'length') continue
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (typeof key !== 'string' || !descriptor || !Object.hasOwn(descriptor, 'value')) fail('invalid_request', 'Expected plain JSON fields')
      pending.push({ value: descriptor.value, depth: depth + 1 })
    }
  }
}

function validate(message, documentId) {
  jsonOnly(message)
  if (!object(message) || Object.keys(message).length !== 5 || !['v', 'documentId', 'id', 'method', 'payload'].every(key => Object.hasOwn(message, key))) fail('invalid_request', 'Invalid request envelope')
  if (message.v !== 1) fail('unsupported_version', 'Unsupported Colony protocol version')
  if (!id(message.id) || !id(message.documentId)) fail('invalid_request', 'Invalid request identity')
  if (message.documentId !== documentId) fail('revoked', 'Colony document was revoked')
  if (typeof message.method !== 'string' || !Object.hasOwn(schemas, message.method)) fail('unsupported_method', 'Unsupported Colony method')
  if (bytes(message) > (message.method === 'state.chunk' ? FRAME_BYTES : CONTROL_BYTES)) fail('oversize', 'Colony request exceeds its frame limit')
  const payload = message.payload
  const [required, optional] = schemas[message.method]
  if (!object(payload) || required.some(key => !Object.hasOwn(payload, key)) || Object.keys(payload).some(key => !required.includes(key) && !optional.includes(key))) fail('invalid_request', 'Invalid Colony method fields')
  for (const key of ['transferId', 'generation']) if (Object.hasOwn(payload, key) && !id(payload[key])) fail('invalid_request', 'Invalid transfer identity')
  for (const key of ['baseUpdatedAt', 'index', 'offset']) if (Object.hasOwn(payload, key) && !integer(payload[key])) fail('invalid_request', 'Invalid state position')
  if (Object.hasOwn(payload, 'state') && !object(payload.state)) fail('invalid_request', 'State must be an object')
  if (Object.hasOwn(payload, 'totalBytes') && (!integer(payload.totalBytes) || payload.totalBytes < 1 || payload.totalBytes > 32 * 1024 * 1024)) fail('oversize', 'State transfer exceeds 32 MiB')
  if (Object.hasOwn(payload, 'sha256') && (typeof payload.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(payload.sha256))) fail('invalid_request', 'Invalid transfer digest')
  if (Object.hasOwn(payload, 'data') && typeof payload.data !== 'string') fail('invalid_request', 'Invalid transfer data')
  if (Object.hasOwn(payload, 'limit') && (!integer(payload.limit) || payload.limit < 1 || payload.limit > 250)) fail('invalid_request', 'Invalid inventory page limit')
  if (Object.hasOwn(payload, 'cursor') && (typeof payload.cursor !== 'string' || !/^(0|[1-9][0-9]{0,8})$/.test(payload.cursor))) fail('invalid_request', 'Invalid inventory cursor')
  if (Object.hasOwn(payload, 'collection') && !['threads', 'projects', 'warnings'].includes(payload.collection)) fail('invalid_request', 'Invalid inventory collection')
}

const errorCodes = new Set(['invalid_request', 'unsupported_version', 'revoked', 'unsupported_method', 'oversize', 'busy', 'state_conflict', 'unavailable'])
const taggedError = (code, message) => {
  const known = errorCodes.has(code) ? code : 'unavailable'
  const text = String(message || 'Colony operation unavailable').replace(/^\[colony:[a-z_]+\] /, '').slice(0, 1024)
  return Object.assign(new Error(`[colony:${known}] ${text}`), { code: known })
}
let port = null
let documentId = null
let revoked = process.isMainFrame === false
let attached = false
let serial = 0
const pending = new Map()
const handshakeTimer = setTimeout(() => revoke('Colony channel unavailable'), 10000)
handshakeTimer.unref?.()
function revoke(reason = 'Colony document revoked') {
  revoked = true
  clearTimeout(handshakeTimer)
  port?.close()
  port = null
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(taggedError('revoked', reason)) }
  pending.clear()
}
function receive(event) {
  try {
    const message = event.data
    jsonOnly(message)
    if (!object(message) || message.v !== 1 || message.documentId !== documentId || !id(message.id) ||
      typeof message.ok !== 'boolean' || Object.keys(message).length !== 5 ||
      !['v', 'documentId', 'id', 'ok', message.ok ? 'result' : 'error'].every(key => Object.hasOwn(message, key)) ||
      bytes(message) > FRAME_BYTES || !pending.has(message.id)) throw new Error('Invalid Colony response or size limit')
    if (!message.ok && (!object(message.error) || Object.keys(message.error).length !== 2 ||
      !errorCodes.has(message.error.code) || typeof message.error.message !== 'string' || message.error.message.length > 1024)) throw new Error('Invalid Colony error')
    const entry = pending.get(message.id)
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.ok) entry.resolve(message.result)
    else entry.reject(taggedError(message.error.code, message.error.message))
  } catch (error) { revoke(error.message) }
}
ipcRenderer.on('colony:port', (event, config) => {
  const ports = event.ports || []
  // Exactly one attachment for this preload/document lifetime, even after revocation.
  if (revoked || attached || !object(config) || config.v !== 1 || !id(config.documentId) ||
    Object.keys(config).length !== 2 || ports.length !== 1 || typeof ports[0]?.postMessage !== 'function') {
    for (const candidate of ports) candidate.close?.()
    revoke('Invalid or revoked Colony document attachment')
    return
  }
  attached = true
  clearTimeout(handshakeTimer)
  documentId = config.documentId
  port = ports[0]
  port.onmessage = receive
  port.onmessageerror = () => revoke('Invalid Colony port message')
  port.onclose = () => revoke('Colony channel closed')
  port.start()
  for (const entry of pending.values()) post(entry)
})
ipcRenderer.on('colony:revoke', () => revoke())
window.addEventListener('pagehide', () => revoke())
function post(entry) {
  if (!port || revoked) return
  entry.message.documentId = documentId
  try { port.postMessage(entry.message) }
  catch { revoke('Colony channel closed') }
}
contextBridge.exposeInMainWorld('colonyEmbedded', Object.freeze({
  product: 'colony', protocolVersion: 1,
  electronMajor: Number(process.versions.electron?.split('.')[0]) || null,
  async request(method, payload = {}) {
    try {
      if (revoked) throw taggedError('revoked', 'Colony document revoked')
      if (pending.size >= 32) throw taggedError('busy', 'Colony pending request limit reached')
      // Worst-case document identity reserves the complete frame budget while awaiting init.
      const message = { v: 1, documentId: documentId || 'd'.repeat(64), id: `request-${++serial}`, method, payload }
      validate(message, message.documentId)
      const detached = JSON.parse(JSON.stringify(message))
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => revoke('Colony request expired; document revoked'), 60000)
        timer.unref?.()
        const entry = { resolve, reject, timer, message: detached }
        pending.set(message.id, entry)
        post(entry)
      })
    } catch (error) { throw taggedError(error.code, error.message) }
  },
}))
// Receiver authenticates the exact sender frame; this event carries no credentials or paths.
ipcRenderer.send('colony:scene-ready', { v: 1, product: 'colony' })
