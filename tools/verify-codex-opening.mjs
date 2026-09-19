/** Opt-in live check: opens the supplied tasks and verifies the desktop's own route receipt. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readTail } from '../server/lib/fsutil.mjs'

if (process.env.BOT_CROSSING_VERIFY_NATIVE_OPEN !== '1') {
  console.log('Skipped: set BOT_CROSSING_VERIFY_NATIVE_OPEN=1 and BOT_CROSSING_CODEX_TEST_IDS')
  process.exit(0)
}
assert.equal(process.platform, 'darwin', 'This probe verifies the macOS Codex desktop route log')
const base = new URL(process.env.BOT_CROSSING_LIVE_URL || 'http://127.0.0.1:5287')
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Live opening is loopback only')
const ids = (process.env.BOT_CROSSING_CODEX_TEST_IDS || '').split(',').filter(Boolean)
assert.ok(ids.length > 0 && ids.length <= 3, 'Supply one to three existing task UUIDs, ending with the task to leave selected')
assert.ok(ids.every(id => /^[0-9a-f-]{36}$/i.test(id)), 'Expected task UUIDs')
const inventory = await fetch(new URL('/api/threads', base)).then(r => r.json())
for (const id of ids) {
  const thread = inventory.threads.find(t => t.harness === 'codex' && t.ref?.sessionId === id)
  assert.ok(thread?.openCapabilities.app.available, 'Requested task must be in the live inventory with desktop opening available')
  const start = Date.now()
  const response = await fetch(new URL('/api/open', base), { method: 'POST', headers: { 'content-type': 'application/json', origin: base.origin },
    body: JSON.stringify({ harness: 'codex', ref: thread.ref, via: 'app' }) })
  const result = await response.json()
  assert.equal(result.ok, true, result.error)
  let matched = false
  while (Date.now() - start < 8000 && !matched) {
    const day = new Date().toISOString().slice(0, 10).replaceAll('-', '/')
    const dir = path.join(os.homedir(), 'Library/Logs/com.openai.codex', day)
    for (const file of await fs.readdir(dir)) {
      if (!file.endsWith('.log')) continue
      const tail = await readTail(path.join(dir, file), 256 * 1024)
      matched ||= tail.split('\n').some(line => Date.parse(line.slice(0, 24)) >= start &&
        line.includes(`ownerRoutePath=/local/${id}`))
    }
    if (!matched) await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.ok(matched, 'Desktop must report the exact selected route after the open request')
  console.log(`PASS: ${thread.parentId ? 'worker' : 'parent task'} selected in Codex desktop; exact route receipt matched`)
}
