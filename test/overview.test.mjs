import test from 'node:test'
import assert from 'node:assert/strict'
import * as projects from '../src/game/projects.js'

// These are the checkout shapes emitted by the real project resolver, including a
// cached Git checkout whose directory was removed and an unresolved malformed root.
function fixture() {
  const checkouts = [
    { id: 'git', path: '/fixture/garden', kind: 'git', repositoryId: 'repo:garden', missing: false },
    { id: 'directory', path: '/fixture/notes', kind: 'directory', repositoryId: '', missing: false },
    { id: 'missing', path: '/fixture/old-worker', kind: 'missing', repositoryId: '', missing: true },
    { id: 'cached', path: '/fixture/removed-repo', kind: 'git', repositoryId: 'repo:removed', missing: true },
    { id: 'unknown', path: '', kind: 'unknown', repositoryId: '', missing: true },
    { id: 'malformed', path: '/fixture/malformed', kind: 'unknown', repositoryId: '', missing: false },
  ]
  const inventory = checkouts.map(c => ({ id: `project:${c.id}`, name: c.id, path: c.path,
    repositoryIds: c.repositoryId ? [c.repositoryId] : [], checkouts: [c] }))
  const threads = checkouts.map(c => ({ id: `codex:${c.id}`, title: `${c.id} task`, project: `project:${c.id}`,
    projectId: `project:${c.id}`, defaultProjectId: `project:${c.id}`, checkoutId: c.id,
    repositoryId: c.repositoryId, checkout: c, cwd: c.path, harness: 'codex', running: false }))
  return { inventory, threads }
}

function overview(threads, inventory, filters = {}) {
  assert.equal(typeof projects.projectOverview, 'function', 'The overview must distinguish current and historical locations')
  return projects.projectOverview(threads, inventory, filters)
}

test('overview-c1: count repositories and other workspaces separately from historical locations', () => {
  // Regression: every unresolved path was labelled as another project.
  const { threads, inventory } = fixture()
  const result = overview(threads, inventory, { includeHistorical: true })
  assert.deepEqual(result.counts, { repository: 1, workspace: 1, historical: 4 })
  assert.deepEqual(result.projects.map(p => p.category), ['repository', 'workspace', 'historical', 'historical', 'historical', 'historical'])
})

test('overview-c2: default overview and colony roster exclude missing and unknown-only groups', () => {
  // Regression: the legend looked cleaned up but old-path agents still filled the map.
  const { threads, inventory } = fixture()
  const result = overview(threads, inventory)
  assert.deepEqual(result.projects.map(p => p.id), ['project:git', 'project:directory'])
  assert.deepEqual(result.threads.map(t => t.id), ['codex:git', 'codex:directory'])
  assert.equal(result.historicalCount, 4)
})

test('overview-c3: historical locations remain searchable only after explicit opt-in', () => {
  // Regression: either search leaks hidden history or the cleanup loses access entirely.
  const { threads, inventory } = fixture()
  assert.equal(overview(threads, inventory, { query: 'old-worker' }).threads.length, 0)
  const result = overview(threads, inventory, { query: 'old-worker', includeHistorical: true })
  assert.deepEqual(result.threads.map(t => t.id), ['codex:missing'])
  assert.deepEqual(result.projects.map(p => p.id), ['project:missing'])
})

test('overview-c4: grouping a historical checkout into a live repository preserves sessions and source data', () => {
  // Regression: filtering by the session checkout drops deliberately grouped history.
  const { threads, inventory } = fixture()
  const snapshot = structuredClone({ threads, inventory })
  const overrides = { missing: 'project:git' }
  const grouped = projects.groupProjects(threads, inventory, overrides)
  const result = overview(grouped.threads, grouped.projects)
  assert.deepEqual(result.threads.map(t => t.id), ['codex:git', 'codex:directory', 'codex:missing'])
  assert.equal(result.projects.find(p => p.id === 'project:git').checkouts.length, 2)
  assert.equal(result.threads.find(t => t.id === 'codex:missing').cwd, '/fixture/old-worker')
  assert.deepEqual({ threads, inventory }, snapshot)
  assert.deepEqual(overrides, { missing: 'project:git' })
})
