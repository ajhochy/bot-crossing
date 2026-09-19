import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const unavailable = reason => ({ available: false, reason })
export const validRhythmSessionId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)

/** Bot-owned configuration opts a qualified Electron shell/profile into navigation. */
export async function rhythmDesktop() {
  const file = process.env.BOT_CROSSING_NATIVE_OPENERS || path.join(
    process.env.BOT_CROSSING_DATA || path.resolve(here, '..', '..', 'data'), 'native-openers.json')
  let config
  try { config = JSON.parse(await fs.readFile(file, 'utf8')).rhythm } catch {
    return unavailable('Rhythm Electron opening is not configured. The installed Flutter app has no external session link.')
  }
  if (!config || !['shellPath', 'userDataPath', 'executable'].every(key => typeof config[key] === 'string' && path.isAbsolute(config[key]))) {
    return unavailable('Rhythm Electron opening configuration requires absolute shell, executable and profile paths.')
  }
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(config.shellPath, 'package.json'), 'utf8'))
    const capabilities = JSON.parse(await fs.readFile(path.resolve(config.shellPath, '../web/dist/desktop-capabilities.json'), 'utf8'))
    if (pkg.name !== 'rhythm-electron-shell' || capabilities.version !== 1 || capabilities.agentSessionDeepLink !== true) throw new Error('unsupported')
    await fs.access(config.executable, fs.constants.X_OK)
    if (!(await fs.stat(config.executable)).isFile()) throw new Error('invalid executable')
  } catch { return unavailable('Build the Rhythm Electron session-link update before opening conversations here.') }
  // Never start a second owning runtime. The existing profile lock supplies the live owner.
  try {
    const lock = await fs.readlink(path.join(config.userDataPath, 'SingletonLock'))
    const pid = Number(lock.match(/-(\d+)$/)?.[1])
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('no owner')
    process.kill(pid, 0)
  } catch { return unavailable('Open the configured Rhythm Electron app first; its profile is not currently running.') }
  return { available: true, reason: 'Open this conversation in Rhythm Electron', config }
}

export function rhythmAppCommand(desktop, sessionId) {
  const { executable, shellPath, userDataPath } = desktop.config
  return {
    argv: [executable, shellPath, '--interactive-smoke', `rhythm://app/index.html#/agents?${new URLSearchParams({ sessionId })}`],
    cwd: shellPath,
    env: { RHYTHM_SHELL_USER_DATA: userDataPath },
  }
}
