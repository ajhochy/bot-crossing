import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { schemeHasHandler } from './xdg.mjs'

const exec = promisify(execFile)
const cache = new Map()
const BUNDLE_ID = 'com.openai.codex'

/** Check installation metadata only; discovering sessions must never launch their harness. */
export async function codexDesktop() {
  if (process.platform === 'linux') return (await schemeHasHandler('codex://threads/')) ? { available: true } : { available: false }
  if (process.platform !== 'darwin') return { available: false }
  const override = process.env.BOT_CROSSING_CODEX_APP
  const roots = override === undefined
    ? ['/Applications', path.join(os.homedir(), 'Applications')].flatMap(dir => ['ChatGPT.app', 'Codex.app'].map(name => path.join(dir, name)))
    : override ? [override] : []
  const key = JSON.stringify(roots)
  const prior = cache.get(key)
  if (prior && Date.now() - prior.at < 30000) return prior.value
  let value = { available: false }
  for (const root of roots) {
    if (!path.isAbsolute(root)) continue
    try {
      const { stdout } = await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(root, 'Contents', 'Info.plist')], { timeout: 2000, maxBuffer: 256 * 1024 })
      const plist = JSON.parse(stdout)
      if (plist.CFBundleIdentifier === BUNDLE_ID && plist.CFBundleURLTypes?.some(t => t.CFBundleURLSchemes?.includes('codex'))) {
        value = { available: true, bundleId: BUNDLE_ID }
        break
      }
    } catch { /* Missing or unrelated application; try the next conventional location. */ }
  }
  cache.set(key, { value, at: Date.now() })
  return value
}
