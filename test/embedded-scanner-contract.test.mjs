import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

let scannerModule
try { scannerModule = await import('../server/embedded-scanner.mjs') } catch {}

async function fixture(sources, loadSource, run) {
  assert.equal(typeof scannerModule?.createEmbeddedScanner, 'function', 'Required explicit-source scanner factory is missing')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-scanner-contract-'))
  const scanner = scannerModule.createEmbeddedScanner({ dataDir: path.join(dir, 'owned'), sources,
    loadSource, now: () => 1234 })
  try { await run({ scanner, dir }) }
  finally { scanner.dispose(); await fs.rm(dir, { recursive: true, force: true }) }
}

test('embedded scanner never loads a disabled source and stays inert until scan', async () => {
  let loads = 0
  let detects = 0
  await fixture([{ id: 'hermes', enabled: true }, { id: 'codex', enabled: false }], async id => {
    assert.equal(id, 'hermes', 'disabled source must not even be imported')
    loads++
    return { id, name: 'Hermes', detect: () => { detects++; return true }, scanThreads: () => [{ id: 'hermes:synthetic', title: 'Synthetic' }] }
  }, async ({ scanner }) => {
    assert.equal(loads + detects, 0)
    const snapshot = await scanner.scan()
    assert.equal(loads, 1)
    assert.equal(detects, 1)
    assert.deepEqual(snapshot.threads.map(thread => thread.id), ['hermes:synthetic'])
    assert.equal(snapshot.scannedAt, 1234)
    assert.equal(snapshot.threads[0].canOpen, false, 'embedded observation must not offer a shell/native delegate')
  })
})

test('embedded scanner reports one failed source while preserving healthy observations', async () => {
  await fixture([{ id: 'hermes', enabled: true }, { id: 'codex', enabled: true }], async id => ({
    id, name: id, detect: () => true,
    scanThreads: () => { if (id === 'codex') throw new Error('synthetic locked database'); return [{ id: 'hermes:healthy' }] },
  }), async ({ scanner }) => {
    const result = await scanner.scan()
    assert.deepEqual(result.threads.map(thread => thread.id), ['hermes:healthy'])
    assert.ok(result.warnings.some(warning => /codex/i.test(warning)), 'failed source must be named')
  })
})

test('embedded scanner coalesces concurrent scans and revokes delayed results', async () => {
  let reads = 0
  let release
  let started
  const scanning = new Promise(resolve => { started = resolve })
  await fixture([{ id: 'hermes', enabled: true }], async () => ({ id: 'hermes', name: 'Hermes', detect: () => true,
    scanThreads: () => { reads++; started(); return new Promise(resolve => { release = resolve }) },
  }), async ({ scanner }) => {
    const requests = Array.from({ length: 10 }, () => scanner.scan())
    await scanning
    assert.equal(reads, 1)
    scanner.dispose()
    release([{ id: 'stale-result' }])
    for (const result of await Promise.allSettled(requests)) {
      assert.equal(result.status, 'rejected')
      assert.match(result.reason.message, /disposed|revoked/)
    }
  })
})

test('embedded project resolution retains filesystem Git identity without executing Git', async () => {
  const { createProjectResolver } = await import('../server/projects.mjs')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-no-git-'))
  try {
    const checkout = path.join(dir, 'checkout')
    await fs.mkdir(path.join(checkout, '.git', 'objects'), { recursive: true })
    await fs.mkdir(path.join(checkout, '.git', 'refs'))
    await fs.writeFile(path.join(checkout, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const resolve = createProjectResolver({ dataDir: path.join(dir, 'owned'), gitEnabled: false })
    const result = await resolve([{ id: 'synthetic', project: 'checkout', projectPath: checkout }])
    assert.equal(result.metrics.gitCommands, 0)
    assert.equal(result.projects[0].checkouts[0].kind, 'git')
    assert.equal(result.projects[0].checkouts[0].dirty, null)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('missing enabled source warns and preserves prior observations as stale', async () => {
  let present = true
  await fixture([{ id: 'hermes', enabled: true }], async () => ({ id: 'hermes', name: 'Hermes',
    detect: () => present, scanThreads: () => [{ id: 'hermes:retained' }],
  }), async ({ scanner }) => {
    await scanner.scan()
    present = false
    const result = await scanner.scan()
    assert.equal(result.threads[0]?.id, 'hermes:retained')
    assert.equal(result.threads[0].stale, true)
    assert.ok(result.warnings.some(warning => /hermes.*unavailable/i.test(warning)))
  })
})
