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
  'state.mark': [['threadId'], ['archived', 'viewedAt']],
  'state.begin': [['baseUpdatedAt', 'totalBytes', 'sha256'], []],
  'state.chunk': [['transferId', 'index', 'data'], []],
  'state.commit': [['transferId'], []],
  'state.cancel': [['transferId'], []],
  'state.readChunk': [['transferId', 'offset'], []],
  'state.readCancel': [['transferId'], []],
  'inventory.page': [[], ['generation', 'cursor', 'collection', 'limit']],
  'inventory.cancel': [['generation'], []],
  'scene.select': [['threadId'], []],
  'scene.status': [['webgl'], []],
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
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) fail('invalid_request', 'Expected plain JSON data')
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
  if (Object.hasOwn(payload, 'threadId') && (typeof payload.threadId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(payload.threadId))) fail('invalid_request', 'Invalid thread identity')
  if (Object.hasOwn(payload, 'webgl') && !['ready', 'lost'].includes(payload.webgl)) fail('invalid_request', 'Invalid WebGL status')
  if (message.method === 'state.mark' && !Object.hasOwn(payload, 'archived') && !Object.hasOwn(payload, 'viewedAt')) fail('invalid_request', 'State mark requires a change')
  if (Object.hasOwn(payload, 'archived') && typeof payload.archived !== 'boolean') fail('invalid_request', 'Invalid archive mark')
  if (Object.hasOwn(payload, 'viewedAt') && !integer(payload.viewedAt)) fail('invalid_request', 'Invalid viewed timestamp')
}

function serviceError(error) {
  const message = String(error?.message || '')
  if (/disposed|revoked/i.test(message)) return ['revoked', 'Colony document was revoked']
  if (/conflict/i.test(message)) return ['state_conflict', 'Saved colony changed; reload before saving']
  if (/exceeds|size limit|aggregate limit|too many/i.test(message)) return ['oversize', 'Colony operation exceeds its size or capacity limit']
  return ['unavailable', 'Colony operation could not be completed']
}

/** Native sender/frame verification is required before constructing this document session. */
export function createProtocolSession({ service, documentId }) {
  if (!id(documentId) || typeof service?.invoke !== 'function' || typeof service?.dispose !== 'function') throw new Error('Invalid Colony protocol session')
  const pending = new Map()
  let disposed = false
  return {
    dispose() { disposed = true; for (const revoke of pending.values()) revoke(); service.dispose(); pending.clear() },
    async handle(message) {
      let requestId = ''
      let accepted = false
      try {
        const candidateId = object(message) ? Object.getOwnPropertyDescriptor(message, 'id')?.value : undefined
        if (id(candidateId)) requestId = candidateId
        if (disposed) fail('revoked', 'Colony document was revoked')
        validate(message, documentId)
        // Detach accepted data from caller-owned objects before service awaits.
        message = JSON.parse(JSON.stringify(message))
        requestId = message.id
        if (pending.has(requestId)) fail('invalid_request', 'Duplicate outstanding Colony request')
        if (pending.size >= 32) fail('busy', 'Colony request limit reached')
        if (message.method.startsWith('scene.')) fail('unsupported_method', 'Host must intercept scene intent')
        let revoke
        const revoked = new Promise(resolve => { revoke = resolve })
        pending.set(requestId, revoke)
        accepted = true
        const envelope = { v: 1, documentId, id: requestId, ok: true, result: null }
        const maxResultBytes = FRAME_BYTES - (bytes(envelope) - 4)
        const result = await Promise.race([service.invoke(message.method, message.payload, { maxResultBytes }), revoked])
        if (disposed) fail('revoked', 'Colony document was revoked')
        envelope.result = result
        jsonOnly(envelope)
        if (bytes(envelope) > FRAME_BYTES) fail('oversize', 'Colony response exceeds 1 MiB')
        return envelope
      } catch (error) {
        const [code, text] = error?.code && ['invalid_request', 'unsupported_version', 'unsupported_method', 'revoked', 'oversize', 'busy'].includes(error.code)
          ? [error.code, error.message] : serviceError(error)
        return { v: 1, documentId, id: requestId, ok: false, error: { code, message: text } }
      } finally { if (accepted) pending.delete(requestId) }
    },
  }
}
