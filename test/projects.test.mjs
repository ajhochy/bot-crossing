import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { encoding: 'utf8' }).trim()
async function fixture(fn) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bot-project-contract-')))
  try {
    const main = path.join(dir, 'one', 'garden')
    const clone = path.join(dir, 'two', 'garden')
    const wt = path.join(dir, 'arbitrary-worker')
    await fs.mkdir(main, { recursive: true })
    git(main, 'init', '-q')
    git(main, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture')
    git(main, 'worktree', 'add', '-qb', 'worker', wt)
    await fs.mkdir(path.dirname(clone), { recursive: true })
    git(dir, 'clone', '-q', main, clone)
    await fs.mkdir(path.join(wt, 'nested'))
    await fs.symlink(wt, path.join(dir, 'alias'))
    await fs.writeFile(path.join(wt, 'untracked.txt'), 'fixture')
    await fn({ dir, main, clone, wt })
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
}
async function resolver(dir, options = {}) {
  const module = await import('../server/scan.mjs')
  assert.equal(typeof module.createProjectResolver, 'function', 'P1: scanner must expose its real project identity resolver')
  return module.createProjectResolver({ dataDir: path.join(dir, 'bot-data'), ...options })
}
const session = (id, cwd, harness = 'codex') => ({ id, cwd, projectPath: cwd, project: 'garden', harness, running: false })

test('P1-1: linked worktrees share project identity with exact distinct checkouts across harnesses', async () => {
  await fixture(async ({ dir, main, wt }) => {
    const resolve = await resolver(dir)
    const out = await resolve([session('a', main), session('b', wt, 'claude-code')])
    assert.equal(out.threads[0].projectId, out.threads[1].projectId)
    assert.notEqual(out.threads[0].checkoutId, out.threads[1].checkoutId)
    assert.equal(out.projects.length, 1)
    assert.deepEqual(new Set(out.projects[0].checkouts.map(c => c.path)), new Set([main, wt]))
    assert.equal(out.threads[1].cwd, wt)
  })
})
test('P1-2: independent same-name clone stays separate; symlink and nested cwd share checkout', async () => {
  await fixture(async ({ dir, main, clone, wt }) => {
    const resolve = await resolver(dir)
    const out = await resolve([session('a', main), session('b', clone), session('c', path.join(wt, 'nested')), session('d', path.join(dir, 'alias'))])
    const [a,b,c,d] = out.threads
    assert.notEqual(a.projectId, b.projectId)
    assert.equal(a.projectId, c.projectId)
    assert.equal(c.checkoutId, d.checkoutId)
    assert.equal(c.cwd, path.join(wt, 'nested'))
  })
})
test('P1-4: previously observed missing checkout keeps identity and reports missing; non-Git is explicit', async () => {
  await fixture(async ({ dir, wt }) => {
    const resolve = await resolver(dir)
    const before = await resolve([session('a', wt)])
    await fs.rename(wt, `${wt}-moved`)
    // Regression: the metadata cache must not report a deleted checkout as present for its
    // whole TTL. The same long-lived resolver is what production polls use.
    const after = await resolve([session('a', wt), session('b', path.join(dir, 'not-recorded'))])
    assert.equal(after.threads[0].checkoutId, before.threads[0].checkoutId)
    assert.equal(after.threads[0].checkout.missing, true)
    assert.equal(after.threads[0].checkout.dirty, null)
    assert.match(after.threads[0].checkout.evidence, /missing/i)
    assert.equal(after.threads[1].checkout.kind, 'missing')
    const nonGit = await resolve([session('c', dir)])
    assert.equal(nonGit.threads[0].checkout.kind, 'directory')
  })
})

test('P1-4: records without an absolute cwd remain distinct instead of inventing shared ownership', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-project-unknown-'))
  try {
    const resolve = await resolver(dir)
    const out = await resolve([
      { ...session('codex:a', ''), project: 'Alpha' },
      { ...session('hermes:b', '', 'hermes'), project: 'Beta' },
    ])
    assert.notEqual(out.threads[0].checkoutId, out.threads[1].checkoutId)
    assert.notEqual(out.threads[0].projectId, out.threads[1].projectId)
    assert.match(out.threads[0].checkout.evidence, /no absolute working directory/i)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('P1-4: corrupt identity cache fails closed, reaches the API, and preserves its bytes', async () => {
  await withServer(async ({ call, dir }) => {
    const cache = path.join(dir, 'identities.json')
    const corrupt = '{broken identity cache\n'
    await fs.writeFile(cache, corrupt)

    const response = await call('/api/threads')
    assert.equal(response.status, 500)
    const body = await response.json()
    assert.match(body.error, /identity cache.*invalid JSON.*left unchanged/i)
    assert.equal(await fs.readFile(cache, 'utf8'), corrupt)
  })
})

test('P1-4: malformed identity cache schema fails closed without overwriting the cache', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-project-cache-schema-'))
  try {
    const cache = path.join(dir, 'bot-data', 'identities.json')
    const malformed = '{"version":1,"paths":[]}'
    await fs.mkdir(path.dirname(cache), { recursive: true })
    await fs.writeFile(cache, malformed)

    const resolve = await resolver(dir)
    await assert.rejects(resolve([session('a', dir)]), /identity cache.*unsupported schema.*left unchanged/i)
    assert.equal(await fs.readFile(cache, 'utf8'), malformed)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('P1-4: a missing identity cache initializes normally on first scan', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-project-cache-new-'))
  try {
    const resolve = await resolver(dir)
    const out = await resolve([session('a', dir)])
    assert.equal(out.threads.length, 1)

    const cache = JSON.parse(await fs.readFile(path.join(dir, 'bot-data', 'identities.json'), 'utf8'))
    assert.equal(cache.version, 1)
    assert.equal(Array.isArray(cache.paths), false)
    assert.ok(Object.keys(cache.paths).length > 0)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('P1-4: malformed nested .git metadata never inherits an unrelated parent repository', async () => {
  await fixture(async ({ dir, main }) => {
    const nested = path.join(main, 'malformed-checkout')
    await fs.mkdir(nested)
    const bogus = path.join(dir, 'bogus-git-dir')
    await fs.mkdir(bogus)
    await fs.writeFile(path.join(nested, '.git'), `gitdir: ${bogus}\n`)
    const targeted = await (await resolver(dir))([session('bad-target', nested)])
    assert.equal(targeted.threads[0].repositoryId, '')
    assert.equal(targeted.threads[0].checkout.kind, 'unknown')
    assert.equal(targeted.threads[0].checkout.path, nested)
    assert.match(targeted.threads[0].checkout.evidence, /malformed git metadata/i)

    await fs.writeFile(path.join(nested, '.git'), 'this is not a gitdir\n')
    const malformed = await (await resolver(path.join(dir, 'second-cache')))([session('bad-line', nested)])
    assert.equal(malformed.threads[0].repositoryId, '')
    assert.equal(malformed.threads[0].checkout.kind, 'unknown')
  })
})
test('P1-5: discovery preserves branches, worktree registration, index and untracked contents', async () => {
  await fixture(async ({ dir, main, wt }) => {
    const before = [git(main, 'worktree', 'list', '--porcelain'), git(wt, 'status', '--porcelain'), git(main, 'show-ref')]
    const out = await (await resolver(dir))([session('a', main), session('b', wt)])
    assert.equal(out.threads[1].checkout.dirty, true)
    assert.deepEqual([git(main, 'worktree', 'list', '--porcelain'), git(wt, 'status', '--porcelain'), git(main, 'show-ref')], before)
    assert.equal(await fs.readFile(path.join(wt, 'untracked.txt'), 'utf8'), 'fixture')
  })
})

import { groupProjects, migrateProjectState, filterSessions } from '../src/game/projects.js'
import { mergeState } from '../src/game/merge-state.js'
import { withServer } from './support/with-server.mjs'

test('P1-3: explicit grouping survives state API reload and reset preserves the session checkout', async () => {
  const t = [{ id: 'one', projectId: 'p1', defaultProjectId: 'p1', checkoutId: 'c1', cwd: '/fixture/one' },
    { id: 'two', projectId: 'p2', defaultProjectId: 'p2', checkoutId: 'c2', cwd: '/fixture/two' }]
  const inventory = [{ id: 'p1', name: 'Garden', checkouts: [{ id: 'c1' }] }, { id: 'p2', name: 'Garden', checkouts: [{ id: 'c2' }] }]
  await withServer(async ({ put, call }) => {
    await put({ projectOverrides: { c2: 'p1' }, archived: ['one'], viewedAt: { two: 10 } })
    const state = await (await call('/api/state')).json()
    const grouped = groupProjects(t, inventory, state.projectOverrides)
    assert.equal(grouped.projects.length, 1)
    assert.equal(grouped.threads[1].cwd, '/fixture/two')
    assert.equal(grouped.threads[1].checkoutId, 'c2')
    assert.deepEqual(state.archived, ['one'])
    assert.deepEqual(state.viewedAt, { two: 10 })
    await put({ ...state, projectOverrides: {}, baseUpdatedAt: state.updatedAt })
    const reset = await (await call('/api/state')).json()
    assert.equal(groupProjects(t, inventory, reset.projectOverrides).projects.length, 2)
  })
})
test('P1-6: unambiguous layout migrates without discarding archives/viewed/legacy keys; collision never guesses', () => {
  const original = { version: 2, plots: { Garden: [[4, 5]], collision: [[7, 8]] }, archived: ['a'], viewedAt: { b: 123 }, hiddenProjects: ['Garden'] }
  const next = migrateProjectState(original, [{ legacyProject: 'Garden', projectId: 'p1' }, { legacyProject: 'collision', projectId: 'p2' }, { legacyProject: 'collision', projectId: 'p3' }])
  assert.deepEqual(next.plots.p1, [[4, 5]])
  assert.deepEqual(next.plots.Garden, [[4, 5]])
  assert.equal(next.plots.p2, undefined)
  assert.equal(next.plots.p3, undefined)
  assert.deepEqual(next.archived, ['a'])
  assert.deepEqual(next.viewedAt, { b: 123 })
  assert.ok(next.hiddenProjects.includes('p1'))
  assert.equal(migrateProjectState(next, [{ legacyProject: 'Garden', projectId: 'p1' }]), next)
})
test('grouping conflicts merge edits to separate checkouts and allow reset', () => {
  assert.deepEqual(mergeState({ projectOverrides: {} }, { projectOverrides: { c1: 'p' } }, { projectOverrides: { c2: 'q' } }).projectOverrides, { c1: 'p', c2: 'q' })
  assert.deepEqual(mergeState({ projectOverrides: { c1: 'p' } }, { projectOverrides: {} }, { projectOverrides: { c1: 'p', c2: 'q' } }).projectOverrides, { c2: 'q' })
})
test('project filters use checkout, harness, status and path without rewriting navigation', () => {
  const sessions = [{ id: 'a', checkoutId: 'c1', harness: 'codex', cwd: '/garden/worker', running: true },
    { id: 'b', checkoutId: 'c2', harness: 'hermes', cwd: '/garden/main', running: null, activity: 'unknown' }]
  assert.deepEqual(filterSessions(sessions, { checkout: 'c1', harness: 'codex', status: 'active', query: 'worker' }).map(t => t.id), ['a'])
  assert.deepEqual(filterSessions(sessions, { status: 'unknown' }).map(t => t.id), ['b'])
})
test('warm scans cache Git work per checkout instead of per historical session', async () => {
  await fixture(async ({ dir, main, wt }) => {
    const { createProjectResolver } = await import('../server/scan.mjs')
    const resolve = createProjectResolver({ dataDir: path.join(dir, 'bot-data') })
    const sessions = Array.from({ length: 1000 }, (_, i) => session(String(i), i % 2 ? main : wt))
    const cold = await resolve(sessions)
    const warm = await resolve(sessions)
    assert.equal(cold.projects.length, 1)
    assert.ok(cold.metrics.gitCommands <= 3, `Git work is per repository + checkout: ${cold.metrics.gitCommands}`)
    assert.equal(warm.metrics.gitCommands, 0)
  })
})

test('large repositories inspect at most twelve recent or active checkouts with global Git concurrency capped at four', async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bot-project-many-')))
  try {
    const main = path.join(dir, 'main')
    await fs.mkdir(main)
    git(main, 'init', '-q')
    git(main, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture')
    const roots = [main]
    for (let i = 1; i < 14; i++) {
      const wt = path.join(dir, `worker-${i}`)
      git(main, 'worktree', 'add', '-q', '--detach', wt, 'HEAD')
      roots.push(wt)
    }
    const sessions = roots.map((cwd, i) => ({
      ...session(`s${i}`, cwd),
      lastActivityAt: 10_000 - i,
      running: i === roots.length - 1,
    }))
    const resolve = await resolver(dir)
    const cold = await resolve(sessions)
    const inspected = cold.threads.filter(t => t.checkout.dirty !== null)
    assert.equal(inspected.length, 12)
    assert.notEqual(cold.threads[0].checkout.dirty, null, 'latest checkout is inspected')
    assert.notEqual(cold.threads.at(-1).checkout.dirty, null, 'active checkout is inspected even when old')
    assert.ok(cold.threads.some(t => t.checkout.dirty === null && /not inspected/i.test(t.checkout.evidence)))
    assert.equal(cold.metrics.statusCommands, 12)
    assert.equal(cold.metrics.gitCommands, 13, 'one inventory command plus twelve bounded status commands')
    assert.ok(cold.metrics.maxConcurrentGit <= 4, `global Git concurrency was ${cold.metrics.maxConcurrentGit}`)

    const warm = await resolve(sessions)
    assert.equal(warm.metrics.gitCommands, 0)

    const skipped = cold.threads.find(t => t.checkout.dirty === null)
    assert.equal(typeof resolve.inspect, 'function')
    const detail = await resolve.inspect(skipped.checkoutId)
    assert.equal(detail.id, skipped.checkoutId)
    assert.equal(detail.dirty, false)
    assert.match(detail.evidence, /read-only status/i)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
