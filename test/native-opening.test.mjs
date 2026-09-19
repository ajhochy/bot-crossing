import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { withEnv, fakeExecutable } from './support/env.mjs'
import { withServer } from './support/with-server.mjs'
import codex from '../server/harnesses/codex.mjs'

const id = '11111111-2222-4333-8444-555555555555'
const mac = { skip: process.platform !== 'darwin' }

async function fixture(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-native-open-'))
  try {
    const app = path.join(dir, 'Codex.app')
    await fs.mkdir(path.join(app, 'Contents'), { recursive: true })
    await fs.writeFile(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.openai.codex</string><key>CFBundleURLTypes</key><array><dict><key>CFBundleURLSchemes</key><array><string>codex</string></array></dict></array></dict></plist>`)
    const opener = await fakeExecutable(dir, 'open')
    await withEnv({ BOT_CROSSING_CODEX_APP: app, BOT_CROSSING_CODEX_CLI: '', PATH: dir }, () => fn({ dir, app, opener }))
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
}

test('opening-c1: an installed Codex desktop opens the exact worker UUID without a CLI', mac, async () => {
  // Catches the unconditional desktop-unavailable gate, even when a handler is installed.
  await fixture(async ({ dir, opener }) => {
    await withServer(async ({ call }) => {
      const response = await call('/api/open', { method: 'POST', body: JSON.stringify({ harness: 'codex', ref: { sessionId: id, cwd: dir } }) })
      const result = await response.json()
      assert.equal(result.ok, true, result.error)
      assert.deepEqual(await opener.argv(), ['-b', 'com.openai.codex', `codex://threads/${id}`])
    })
  })
})

test('opening-c2: failed native dispatch is an error, never an Opened success', mac, async () => {
  // Catches fire-and-forget launch claiming success for a failed OS opener.
  await fixture(async ({ dir, opener }) => {
    await fs.writeFile(opener.file, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    await withServer(async ({ call }) => {
      const response = await call('/api/open', { method: 'POST', body: JSON.stringify({ harness: 'codex', ref: { sessionId: id, cwd: dir } }) })
      const result = await response.json()
      assert.equal(response.status, 400)
      assert.equal(result.ok, false)
      assert.match(result.error, /could not open/i)
    })
  })
})

test('opening-c3: a missing desktop app keeps the unavailable reason actionable', async () => {
  await withEnv({ BOT_CROSSING_CODEX_APP: '', BOT_CROSSING_CODEX_CLI: '' }, async () => {
    const result = await codex.openThread({ sessionId: id })
    assert.match(result.appUnavailableReason, /not installed|not available/i)
  })
})

test('opening-c6: scanned tasks enable desktop opening even without the CLI', mac, async () => {
  await fixture(async ({ dir }) => {
    const sessions = path.join(dir, 'sessions', '2026', '09', '18')
    await fs.mkdir(sessions, { recursive: true })
    await fs.writeFile(path.join(sessions, `rollout-${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id, cwd: dir } }) + '\n')
    await withEnv({ CODEX_HOME: dir }, async () => {
      const adapter = (await import(`../server/harnesses/codex.mjs?native=${encodeURIComponent(dir)}`)).default
      const [thread] = await adapter.scanThreads()
      assert.equal(thread.canOpen, true)
      assert.equal(thread.openCapabilities.app.available, true)
      assert.equal(thread.openCapabilities.terminal.available, false)
    })
  })
})
