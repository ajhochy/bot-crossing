const CONTROL_BYTES = 64 * 1024
const FRAME_BYTES = 1024 * 1024
const MAX_BYTES = 32 * 1024 * 1024
const CHUNK_BYTES = 512 * 1024
const encoder = new TextEncoder()
const byteSize = value => encoder.encode(JSON.stringify(value)).length
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = value => Number.isSafeInteger(value) && value >= 0
const reject = message => { throw new Error(message) }
const requestSize = (method, payload) => byteSize({ v: 1, documentId: 'd'.repeat(64), id: 'i'.repeat(64), method, payload })
const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
const base64 = bytes => {
  let text = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return btoa(text)
}
const unbase64 = value => {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) reject('Invalid state download data')
  return Uint8Array.from(atob(value), char => char.charCodeAt(0))
}

/** The only injected boundary is the document-owned preload request function. */
export function createEmbeddedTransport(bridge) {
  if (!object(bridge) || bridge.product !== 'colony' || bridge.protocolVersion !== 1 || typeof bridge.request !== 'function') reject('Invalid or unsupported Colony bridge version')
  let projects = []
  const request = async (method, payload = {}) => {
    if (requestSize(method, payload) > (method === 'state.chunk' ? FRAME_BYTES : CONTROL_BYTES)) reject('Colony request exceeds its frame limit')
    let result
    try { result = await bridge.request(method, payload) }
    catch (error) {
      // contextBridge can recreate Error objects without their custom code property.
      const match = /^\[colony:(invalid_request|unsupported_version|revoked|unsupported_method|oversize|busy|state_conflict|unavailable)\] ([\s\S]{0,1024})$/.exec(error?.message || '')
      if (match) throw Object.assign(new Error(match[2]), { code: match[1] })
      throw error
    }
    // Native preload validates the exact envelope. This extra bound limits renderer allocations.
    if (!object(result) || byteSize(result) > FRAME_BYTES) reject('Invalid or oversized Colony response')
    return result
  }
  const cleanup = async (method, payload) => {
    try { await request(method, payload) }
    catch (error) {
      // An expired/already committed transfer needs no cleanup. Revocation must
      // still prevent a completed-but-undelivered result reaching the old scene.
      if (error.code === 'revoked') throw error
    }
  }

  async function decodeState(result) {
    let state = result
    // A complete v3 state may contain any opaque future metadata, including
    // transferId. Only a non-state response can describe a chunked download.
    if (result.version !== 3 && Object.hasOwn(result, 'transferId')) {
      const { transferId, totalBytes, sha256 } = result
      if (typeof transferId !== 'string' || !integer(totalBytes) || totalBytes < 1 || totalBytes > MAX_BYTES || !/^[a-f0-9]{64}$/.test(sha256)) reject('Invalid state download metadata')
      try {
        const bytes = new Uint8Array(totalBytes)
        let offset = 0
        while (offset < totalBytes) {
          const page = await request('state.readChunk', { transferId, offset })
          const chunk = unbase64(page.data)
          const end = offset + chunk.length
          if (page.transferId !== transferId || page.offset !== offset || chunk.length !== Math.min(CHUNK_BYTES, totalBytes - offset) || end > totalBytes || page.nextOffset !== (end === totalBytes ? null : end)) reject('Invalid state download position or length')
          bytes.set(chunk, offset)
          offset = end
        }
        if (await hash(bytes) !== sha256) reject('State download digest mismatch')
        state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      } finally { await cleanup('state.readCancel', { transferId }) }
    }
    if (!object(state) || !integer(state.updatedAt) || state.version !== 3 || !Array.isArray(state.archived)) reject('Invalid saved Colony state')
    return state
  }

  return {
    readState: async () => decodeState(await request('state.read')),
    async writeState(state, baseUpdatedAt) {
      const payload = { state, baseUpdatedAt }
      if (requestSize('state.write', payload) <= CONTROL_BYTES) return decodeState(await request('state.write', payload))
      const bytes = encoder.encode(JSON.stringify(state))
      if (bytes.length > MAX_BYTES) reject('Colony state exceeds 32 MiB')
      const transfer = await request('state.begin', { baseUpdatedAt, totalBytes: bytes.length, sha256: await hash(bytes) })
      if (typeof transfer.transferId !== 'string') reject('Invalid state transfer identity')
      try {
        for (let offset = 0, index = 0; offset < bytes.length; offset += CHUNK_BYTES, index++) {
          const end = Math.min(offset + CHUNK_BYTES, bytes.length)
          const receipt = await request('state.chunk', { transferId: transfer.transferId, index, data: base64(bytes.subarray(offset, end)) })
          if (receipt.received !== end) reject('Invalid state upload receipt')
        }
        return decodeState(await request('state.commit', { transferId: transfer.transferId }))
      } finally { await cleanup('state.cancel', { transferId: transfer.transferId }) }
    },
    async fetchThreads() {
      let generation
      let scannedAt
      let size = 0
      let count = 0
      const result = { threads: [], projects: [], warnings: [] }
      try {
        for (const collection of ['threads', 'projects', 'warnings']) {
          let cursor
          do {
            const page = await request('inventory.page', { collection, limit: 250, ...(generation ? { generation } : {}), ...(cursor === undefined ? {} : { cursor }) })
            if (typeof page.generation !== 'string' || !page.generation || (generation && page.generation !== generation)) reject('Invalid inventory generation')
            generation = page.generation
            if (!integer(page.scannedAt) || (scannedAt !== undefined && scannedAt !== page.scannedAt) || page.collection !== collection || !Array.isArray(page.records) || page.records.length > 250) reject('Invalid inventory page')
            scannedAt = page.scannedAt
            count += page.records.length
            if (count > 20_000) reject('Inventory record count exceeds limit')
            for (const record of page.records) {
              if (collection === 'warnings' ? typeof record !== 'string' : !object(record)) reject('Invalid inventory record')
              size += byteSize(record) + 1
              if (size > MAX_BYTES) reject('Inventory snapshot exceeds 32 MiB')
            }
            result[collection].push(...page.records)
            if (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || page.nextCursor !== String(result[collection].length) || !page.records.length)) reject('Invalid inventory cursor')
            cursor = page.nextCursor
          } while (cursor !== null)
        }
        result.scannedAt = scannedAt
        if (byteSize(result) > MAX_BYTES) reject('Inventory snapshot exceeds 32 MiB')
        projects = structuredClone(result.projects)
        return result
      } finally { if (generation) await cleanup('inventory.cancel', { generation }) }
    },
    async fetchCheckout(id) {
      if (typeof id !== 'string') reject('Invalid checkout identity')
      const checkout = projects.flatMap(project => Array.isArray(project.checkouts) ? project.checkouts : []).find(checkout => checkout.id === id)
      if (!checkout) reject('Checkout is no longer in the scan; refresh the colony')
      return { checkout: structuredClone(checkout) }
    },
  }
}

/** Routes the closed host-event surface without giving the scene native capabilities. */
export function createEmbeddedHostController(bridge, handlers) {
  if (!object(bridge) || bridge.product !== 'colony' || bridge.protocolVersion !== 1 ||
    typeof bridge.request !== 'function' || typeof bridge.onHostEvent !== 'function' || !object(handlers)) reject('Invalid embedded host controller')
  const unsubscribe = bridge.onHostEvent(message => {
    if (!object(message) || typeof message.event !== 'string' || !object(message.payload)) return
    if (message.event === 'host.select') handlers.select?.(message.payload.threadId, { fly: true })
    else if (message.event === 'host.filter') handlers.filter?.(structuredClone(message.payload))
    else if (message.event === 'host.view') handlers.view?.(structuredClone(message.payload))
    else if (message.event === 'host.visibility') handlers.visibility?.(structuredClone(message.payload))
  })
  return Object.freeze({
    dispose: unsubscribe,
    sceneSelected: threadId => bridge.request('scene.select', { threadId }),
    webglLost: () => bridge.request('scene.status', { webgl: 'lost' }),
  })
}

export function createEmbeddedVisibilityScheduler({ poll, isDocumentHidden, setIntervalFn = setInterval, clearIntervalFn = clearInterval, period }) {
  if (typeof poll !== 'function' || typeof isDocumentHidden !== 'function') reject('Invalid visibility scheduler')
  let hostHidden = false
  let visible = !isDocumentHidden()
  const canPoll = () => !hostHidden && !isDocumentHidden()
  const timer = setIntervalFn(() => { if (canPoll()) poll() }, period)
  const wake = () => {
    const next = canPoll()
    if (next && !visible) poll()
    visible = next
  }
  return Object.freeze({
    setHostHidden(hidden) { hostHidden = Boolean(hidden); wake() },
    documentVisibilityChanged: wake,
    dispose() { clearIntervalFn(timer) },
  })
}

export function applyEmbeddedQuality(settings, quality) {
  settings.applyPreset(quality === 'auto' ? 'balanced' : quality)
  if (quality !== 'low') return
  settings.set('renderScale', Math.min(0.7, Number(settings.get('renderScale')) || 0.7))
  settings.set('bloom', false)
  settings.set('tiltShift', false)
  settings.set('ambientOcclusion', 0)
  settings.set('clouds', false)
}

export function filterEmbeddedThreads(threads, { query = '', harness = [], activity = [] } = {}, statusForThread = thread => thread.activity) {
  const needle = query.trim().toLowerCase()
  const harnesses = new Set(harness)
  const activities = new Set(activity)
  return threads.filter(thread => (!harnesses.size || harnesses.has(thread.harness)) &&
    (!activities.size || activities.has(statusForThread(thread))) &&
    (!needle || [thread.title, thread.projectName, thread.cwd, thread.gitBranch, thread.harnessName, thread.agentName, thread.profile]
      .join(' ').toLowerCase().includes(needle)))
}
