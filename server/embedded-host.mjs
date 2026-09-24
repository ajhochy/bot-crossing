import { createEmbeddedService } from './embedded-service.mjs'

/** Rhythm owns this private instance and supplies a read-only scanner. */
export function createEmbeddedHost({ dataDir, scan } = {}) {
  return createEmbeddedService({ dataDir, scan })
}
