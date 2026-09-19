import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import rhythm from '../server/harnesses/rhythm.mjs'
import { withEnv, fakeExecutable } from './support/env.mjs'
import { withServer } from './support/with-server.mjs'
import { DatabaseSync } from 'node:sqlite'

const posix = { skip: process.platform === 'win32' }
async function fixture(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhythm-opening-'))
  try {
    const shellPath = path.join(dir, 'apps', 'electron')
    const userDataPath = path.join(dir, 'profile')
    const dist = path.join(dir, 'apps', 'web', 'dist')
    await Promise.all([shellPath, userDataPath, dist].map(p => fs.mkdir(p, { recursive: true })))
    await fs.writeFile(path.join(shellPath, 'package.json'), JSON.stringify({ name: 'rhythm-electron-shell' }))
    await fs.writeFile(path.join(dist, 'desktop-capabilities.json'), JSON.stringify({ version: 1, agentSessionDeepLink: true }))
    await fs.symlink(`localhost-${process.pid}`, path.join(userDataPath, 'SingletonLock'))
    const electron = await fakeExecutable(dir, 'electron')
    const config = path.join(dir, 'native-openers.json')
    await fs.writeFile(config, JSON.stringify({ rhythm: { shellPath, userDataPath, executable: electron.file } }))
    await withEnv({ BOT_CROSSING_NATIVE_OPENERS: config }, () => fn({ dir, shellPath, userDataPath, dist, electron }))
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
}

test('rhythm-opening-c1: exact local session ID reaches the running Electron profile', posix, async () => {
  // Catches replacing local ID with SDK ID, a wrong profile, or accidentally owning services.
  await fixture(async ({ electron, shellPath, userDataPath }) => {
    const result = await rhythm.openThread({ sessionId: 'local_worker-42', sdkSessionId: 'engine-other', cwd: '/missing/checkout' })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.appCommand.env.RHYTHM_SHELL_USER_DATA, userDataPath)
    await withServer(async ({ call }) => {
      const response = await call('/api/open', { method: 'POST', body: JSON.stringify({ harness: 'rhythm', ref: { sessionId: 'local_worker-42', sdkSessionId: 'engine-other', cwd: '/missing/checkout' } }) })
      assert.equal((await response.json()).ok, true)
      assert.deepEqual(await electron.argv(), [shellPath, '--interactive-smoke', 'rhythm://app/index.html#/agents?sessionId=local_worker-42'])
    })
  })
})

test('rhythm-opening-c2: unpatched or stopped Rhythm remains unavailable', posix, async () => {
  await fixture(async ({ dist, userDataPath }) => {
    const marker = path.join(dist, 'desktop-capabilities.json')
    await fs.rm(marker)
    assert.equal((await rhythm.openThread({ sessionId: 'local-42' })).ok, false)
    await fs.writeFile(marker, JSON.stringify({ version: 1, agentSessionDeepLink: true }))
    await fs.rm(path.join(userDataPath, 'SingletonLock'))
    const stopped = await rhythm.openThread({ sessionId: 'local-42' })
    assert.equal(stopped.ok, false)
    assert.match(stopped.error, /running/i)
  })
})

test('rhythm-opening-c3: invalid or URL-shaped IDs never reach the launcher', async () => {
  for (const sessionId of ['', ['session'], 'bad?sessionId=other', 'bad/path', '../other', 'a'.repeat(129)]) {
    assert.equal((await rhythm.openThread({ sessionId, cwd: '/tmp' })).ok, false)
  }
})

test('rhythm-opening-c4: cached sessions refresh opening availability without database changes', posix, async () => {
  // Catches a cached SQLite scan leaving a now-available or stopped opener permanently stale.
  await fixture(async ({ dir, dist }) => {
    const file = path.join(dir, 'rhythm.db')
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE agent_sessions (id TEXT, agent_kind TEXT, status TEXT, cwd TEXT, name TEXT, created_at TEXT, updated_at TEXT)')
    db.prepare('INSERT INTO agent_sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run('local-root', 'build', 'idle', dir, 'Synthetic task', new Date().toISOString(), new Date().toISOString())
    db.close()
    const before = await fs.readFile(file)
    await withEnv({ RHYTHM_DB: file }, async () => {
      assert.equal((await rhythm.scanThreads())[0].openCapabilities.app.available, true)
      await fs.rm(path.join(dist, 'desktop-capabilities.json'))
      assert.equal((await rhythm.scanThreads())[0].openCapabilities.app.available, false)
      assert.deepEqual(await fs.readFile(file), before)
    })
  })
})
