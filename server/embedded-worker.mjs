import path from 'node:path'
import { createEmbeddedScanner, validateSources, sourcePaths } from './embedded-scanner.mjs'
import { createEmbeddedService } from './embedded-service.mjs'
import { createProtocolSession } from './embedded-protocol.mjs'

let initialized = false
let stopped = false
let documentId
let scanner
let protocol
const send = message => { if (!stopped && process.connected) process.send(message) }
const error = code => send({ type: 'colony:error', error: { code, message: 'Invalid Colony worker handshake or lifecycle control' } })
function dispose() {
  if (stopped) return
  stopped = true
  protocol?.dispose()
  scanner?.dispose()
  process.exit(0)
}
if (!process.send) throw new Error('Colony worker requires an owned parent IPC channel')
process.on('disconnect', dispose)
process.on('message', async message => {
  if (stopped) return
  if (message?.type === 'colony:init') {
    if (initialized) return error('duplicate_init')
    try {
      if (message.v !== 1 || typeof message.documentId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(message.documentId) ||
        typeof message.dataDir !== 'string' || !path.isAbsolute(message.dataDir) ||
        Object.keys(message).length !== 5 || Buffer.byteLength(JSON.stringify(message)) > 64 * 1024) throw new Error('Invalid handshake')
      validateSources(message.sources)
      // Only this owned process is configured, exactly once, before any lazy adapter import.
      for (const source of message.sources.filter(item => item.enabled)) {
        for (const [key, env] of Object.entries(sourcePaths[source.id])) process.env[env] = source.paths[key]
      }
      scanner = createEmbeddedScanner({ dataDir: message.dataDir, sources: message.sources })
      const service = createEmbeddedService({ dataDir: message.dataDir, scan: scanner.scan })
      documentId = message.documentId
      protocol = createProtocolSession({ service, documentId })
      initialized = true
      send({ type: 'colony:ready', v: 1, product: 'colony', documentId, capabilities: ['inventory-v1', 'state-v1'] })
    } catch { error('invalid_handshake') }
    return
  }
  if (!initialized) return error('init_required')
  if (message?.type === 'colony:dispose') {
    if (message.v === 1 && message.documentId === documentId && Object.keys(message).length === 3) dispose()
    else error('invalid_handshake')
    return
  }
  const response = await protocol.handle(message)
  send(response)
})
