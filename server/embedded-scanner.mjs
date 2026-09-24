import path from 'node:path'
import { createProjectResolver } from './projects.mjs'
import { disambiguateProjects, reconcileHarnessDuplicates } from './scan-identity.mjs'

// Closed, lazy registry: importing this module never imports a harness.
const loaders = {
  hermes: () => import('./harnesses/hermes.mjs'),
  codex: () => import('./harnesses/codex.mjs'),
  rhythm: () => import('./harnesses/rhythm.mjs'),
  opencode: () => import('./harnesses/opencode.mjs'),
  kilocode: () => import('./harnesses/kilocode.mjs'),
  'claude-code': () => import('./harnesses/claude-code.mjs'),
  cursor: () => import('./harnesses/cursor.mjs'),
  antigravity: () => import('./harnesses/antigravity.mjs'),
}
export const sourcePaths = Object.freeze({
  hermes: { home: 'HERMES_HOME' }, codex: { home: 'CODEX_HOME' },
  rhythm: { database: 'RHYTHM_DB' }, opencode: { database: 'OPENCODE_DB' },
  kilocode: { database: 'KILO_DB' },
  'claude-code': { home: 'CLAUDE_CONFIG_DIR', desktopSessions: 'BOT_CROSSING_CLAUDE_DESKTOP' },
  cursor: { projects: 'BOT_CROSSING_CURSOR_PROJECTS' },
  antigravity: { home: 'BOT_CROSSING_ANTIGRAVITY_HOME' },
})
export function validateSources(sources, requirePaths = true) {
  if (!Array.isArray(sources) || sources.length > 8) throw new Error('Invalid source configuration')
  const seen = new Set()
  for (const source of sources) {
    if (!source || !Object.hasOwn(loaders, source.id) || seen.has(source.id) || typeof source.enabled !== 'boolean' ||
      Object.keys(source).some(key => !['id', 'enabled', 'paths'].includes(key))) throw new Error('Invalid source configuration')
    seen.add(source.id)
    const mapping = sourcePaths[source.id]
    if (source.paths !== undefined && (!source.paths || typeof source.paths !== 'object' || Array.isArray(source.paths) ||
      Object.entries(source.paths).some(([key, value]) => !Object.hasOwn(mapping, key) || typeof value !== 'string' || !path.isAbsolute(value)))) throw new Error('Invalid explicit source paths')
    if (requirePaths && source.enabled && Object.keys(mapping).some(key => !source.paths?.[key])) throw new Error('Enabled source requires explicit paths')
  }
}
const loadEmbeddedSource = async id => (await loaders[id]()).default
const observation = thread => {
  const { command, appCommand, terminalCommand, ...data } = thread
  return { ...data, canOpen: false, openCapabilities: {}, navigationReason: 'Embedded observation only' }
}

export function createEmbeddedScanner({ dataDir, sources, loadSource = loadEmbeddedSource, now = Date.now }) {
  validateSources(sources, loadSource === loadEmbeddedSource)
  const enabled = sources.filter(source => source.enabled).map(source => ({ ...source }))
  const resolve = createProjectResolver({ dataDir, gitEnabled: false })
  const lastGood = new Map()
  let disposed = false
  let pending = null
  let cancel
  const assertActive = () => { if (disposed) throw new Error('Embedded scanner disposed') }
  async function collect() {
    const warnings = []
    const lists = await Promise.all(enabled.map(async ({ id }) => {
      try {
        assertActive()
        const adapter = await loadSource(id)
        assertActive()
        if (!await adapter.detect()) throw new Error('Enabled source unavailable')
        assertActive()
        const rows = await adapter.scanThreads({ nativeCapabilities: false })
        assertActive()
        const diagnostic = await adapter.diagnostic?.({ nativeCapabilities: false })
        assertActive()
        if (diagnostic) throw new Error(String(diagnostic))
        const stamped = rows.map(row => observation({ ...row, harness: id, harnessName: adapter.name }))
        lastGood.set(id, stamped)
        return stamped
      } catch (error) {
        assertActive()
        warnings.push(`${id}: ${String(error.message || 'scan failed').slice(0, 512)}`)
        return (lastGood.get(id) || []).map(row => ({ ...row, stale: true, activity: 'unknown', running: null }))
      }
    }))
    assertActive()
    const rows = disambiguateProjects(reconcileHarnessDuplicates(lists.flat()))
    rows.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))
    const result = await resolve(rows)
    assertActive()
    return { threads: result.threads, projects: result.projects, warnings, scannedAt: now() }
  }
  return {
    scan() {
      if (disposed) return Promise.reject(new Error('Embedded scanner disposed'))
      if (!pending) {
        const revoked = new Promise((_, reject) => { cancel = () => reject(new Error('Embedded scanner disposed')) })
        pending = Promise.race([collect(), revoked]).finally(() => { pending = null; cancel = null })
      }
      return pending
    },
    dispose() { disposed = true; cancel?.(); lastGood.clear() },
  }
}
