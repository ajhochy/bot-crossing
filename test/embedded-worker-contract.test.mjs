import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'

const worker = fileURLToPath(new URL('../server/embedded-worker.mjs', import.meta.url))
const guard = fileURLToPath(new URL('./support/colony-worker-guard.cjs', import.meta.url))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

async function fixture(run) {
  assert.equal(await fs.stat(worker).then(stat => stat.isFile()).catch(() => false), true, 'Required private worker entry is missing')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-worker-contract-'))
  const hermes = path.join(dir, 'hermes')
  await fs.mkdir(hermes)
  const database = path.join(hermes, 'state.db')
  const db = new DatabaseSync(database)
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, cwd TEXT); INSERT INTO sessions VALUES ('fixture', 'Synthetic worker task', '/synthetic/no-git');")
  db.close()
  const before = digest(await fs.readFile(database))
  const child = fork(worker, [], { execPath: process.execPath, execArgv: ['--require', guard],
    env: { HOME: dir, PATH: '', TMPDIR: dir, COLONY_TEST_FORBIDDEN_ROOT: path.join(dir, 'disabled') }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const messages = []
  const waiters = []
  child.on('message', message => {
    messages.push(message)
    for (const waiter of [...waiters]) if (waiter.accept(message)) { waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(message) }
  })
  const wait = accept => {
    const prior = messages.find(accept)
    if (prior) return Promise.resolve(prior)
    return new Promise((resolve, reject) => {
      const waiter = { accept, resolve, timer: setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error('Worker did not answer within five seconds')) }, 5000) }
      waiters.push(waiter)
    })
  }
  const init = { type: 'colony:init', v: 1, documentId: 'worker-document', dataDir: path.join(dir, 'owned'),
    sources: [{ id: 'hermes', enabled: true, paths: { home: hermes } }, { id: 'codex', enabled: false, paths: { home: path.join(dir, 'disabled') } }] }
  try { await run({ child, wait, init, messages, database, before, hermes, dir }) }
  finally {
    for (const waiter of waiters) clearTimeout(waiter.timer)
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        }, 1000)
        child.once('exit', () => { clearTimeout(timer); resolve() })
        child.kill('SIGTERM')
      })
    }
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test('actual private worker scans a synthetic enabled source without sockets or subprocesses', async () => {
  await fixture(async ({ child, wait, init, messages, database, before, hermes }) => {
    child.send(init)
    const ready = await wait(message => message.type === 'colony:ready')
    assert.equal(ready.v, 1)
    assert.equal(ready.product, 'colony')
    assert.deepEqual(ready.capabilities, ['inventory-v1', 'state-v1', 'host-intents-v1', 'state-mark-v1', 'import-v1'])
    assert.deepEqual(ready.runtime, { node: process.versions.node, sqlite: true })
    assert.equal(ready.documentId, init.documentId)
    child.send({ v: 1, documentId: init.documentId, id: 'scan-1', method: 'inventory.page', payload: { collection: 'threads', limit: 250 } })
    const response = await wait(message => message.id === 'scan-1')
    assert.equal(response.ok, true)
    assert.ok(response.result.records.some(thread => thread.id === 'hermes:main:fixture' && thread.title === 'Synthetic worker task'))
    assert.equal(messages.some(message => message.type === 'forbidden-operation'), false)
    assert.equal(digest(await fs.readFile(database)), before)
    assert.deepEqual(await fs.readdir(hermes), ['state.db'], 'read-only scan must not create SQLite sidecars')
    child.send({ type: 'colony:dispose', v: 1, documentId: init.documentId })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Owned worker did not stop')), 2000)
      child.once('exit', code => { clearTimeout(timer); assert.equal(code, 0); resolve() })
    })
  })
})

test('private worker rejects a bad handshake before accepting a document request', async () => {
  await fixture(async ({ child, wait, init, messages, database, before }) => {
    child.send({ ...init, v: 99 })
    const response = await wait(message => message.type === 'colony:error')
    assert.match(response.error.code, /version|handshake/)
    assert.equal(messages.some(message => message.type === 'colony:ready'), false)
    assert.equal(messages.some(message => message.type === 'forbidden-operation'), false)
    assert.equal(digest(await fs.readFile(database)), before)
  })
})

test('actual worker reads Codex and Rhythm without desktop capability probes or Git subprocesses', async () => {
  await fixture(async ({ child, wait, init, messages, dir }) => {
    const codex = path.join(dir, 'codex')
    await fs.mkdir(codex)
    const codexFile = path.join(codex, 'state_5.sqlite')
    const codexDb = new DatabaseSync(codexFile)
    codexDb.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT); INSERT INTO threads VALUES ('fe911daa-2393-4e29-8d36-6e37c328594c', '/synthetic/no-git', 'Codex synthetic');")
    codexDb.close()
    const rhythmFile = path.join(dir, 'rhythm.db')
    const rhythmDb = new DatabaseSync(rhythmFile)
    rhythmDb.exec("CREATE TABLE agent_sessions (id TEXT, agent_kind TEXT, status TEXT, cwd TEXT, name TEXT, created_at TEXT, updated_at TEXT); INSERT INTO agent_sessions VALUES ('fixture-rhythm', 'opencode', 'idle', '/synthetic/no-git', 'Rhythm synthetic', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');")
    rhythmDb.close()
    const hashes = await Promise.all([codexFile, rhythmFile].map(async file => digest(await fs.readFile(file))))
    child.send({ ...init, sources: [{ id: 'codex', enabled: true, paths: { home: codex } },
      { id: 'rhythm', enabled: true, paths: { database: rhythmFile } }, { id: 'claude-code', enabled: false }] })
    await wait(message => message.type === 'colony:ready')
    child.send({ v: 1, documentId: init.documentId, id: 'scan-2', method: 'inventory.page', payload: { collection: 'threads', limit: 250 } })
    const response = await wait(message => message.id === 'scan-2')
    assert.equal(response.ok, true)
    const ids = response.result.records.map(thread => thread.id)
    assert.ok(ids.includes('codex:fe911daa-2393-4e29-8d36-6e37c328594c'))
    assert.ok(ids.includes('rhythm:fixture-rhythm'))
    assert.equal(messages.some(message => message.type === 'forbidden-operation'), false)
    assert.deepEqual(await Promise.all([codexFile, rhythmFile].map(async file => digest(await fs.readFile(file)))), hashes)
  })
})

test('private worker rejects requests before init without starting sources', async () => {
  await fixture(async ({ child, wait, messages, before, database }) => {
    child.send({ v: 1, documentId: 'not-initialized', id: 'early', method: 'inventory.page', payload: {} })
    const response = await wait(message => message.type === 'colony:error')
    assert.match(response.error.code, /init|handshake/)
    assert.equal(messages.some(message => message.type === 'colony:ready'), false)
    assert.equal(messages.some(message => message.type === 'forbidden-operation'), false)
    assert.equal(digest(await fs.readFile(database)), before)
  })
})

test('private worker rejects source reconfiguration through a duplicate handshake', async () => {
  await fixture(async ({ child, wait, init, messages, dir }) => {
    child.send(init)
    await wait(message => message.type === 'colony:ready')
    child.send({ ...init, sources: [{ id: 'hermes', enabled: true, paths: { home: path.join(dir, 'disabled') } }] })
    const refusal = await wait(message => message.type === 'colony:error')
    assert.match(refusal.error.code, /init|handshake|reconfig/)
    assert.equal(messages.filter(message => message.type === 'colony:ready').length, 1)
    assert.equal(messages.some(message => message.type === 'forbidden-operation'), false)
    child.send({ v: 1, documentId: init.documentId, id: 'original-source', method: 'inventory.page', payload: { collection: 'threads', limit: 250 } })
    const response = await wait(message => message.id === 'original-source')
    assert.equal(response.ok, true)
    assert.ok(response.result.records.some(thread => thread.id === 'hermes:main:fixture'))
    assert.equal(messages.some(message => message.type === 'forbidden-operation'), false)
  })
})

test('private worker exits when its owning parent IPC channel disconnects', async () => {
  await fixture(async ({ child, wait, init }) => {
    child.send(init)
    await wait(message => message.type === 'colony:ready')
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Worker survived owner disconnect')), 2000)
      child.once('exit', code => { clearTimeout(timer); assert.equal(code, 0); resolve() })
      child.disconnect()
    })
  })
})

test('worker exposes import preview and commit only as parent lifecycle controls', async () => {
  await fixture(async ({ child, wait, init, dir }) => {
    const source = path.join(dir, 'import.json')
    await fs.writeFile(source, JSON.stringify({ version: 3, archived: ['codex:imported'], updatedAt: 9 }))
    child.send(init)
    await wait(message => message.type === 'colony:ready')
    child.send({ type: 'colony:import-preview', v: 1, documentId: init.documentId, path: source })
    const preview = await wait(message => message.type === 'colony:import-preview-result')
    assert.deepEqual(preview.counts, { archived: 1, viewed: 0, groups: 0, version: 3 })
    child.send({ type: 'colony:import-commit', v: 1, documentId: init.documentId, path: source })
    const committed = await wait(message => message.type === 'colony:import-commit-result')
    assert.deepEqual(committed.receipt.counts, { archived: 1, viewed: 0, groups: 0 })
    assert.ok(Number.isSafeInteger(committed.receipt.updatedAt))
  })
})
