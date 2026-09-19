import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { groupProjects, migrateProjectState } from '../src/game/projects.js'
import { withServer } from './support/with-server.mjs'

test('ambiguous legacy layout stays pending even after explicit clone grouping', () => {
  const state = { plots: { Garden: [[4, 5]] }, hiddenProjects: ['Garden'] }
  const raw = [{ id: 'a', legacyProject: 'Garden', projectId: 'p1', checkoutId: 'c1' }, { id: 'b', legacyProject: 'Garden', projectId: 'p2', checkoutId: 'c2' }]
  const grouped = groupProjects(raw, [{ id: 'p1', checkouts: [{ id: 'c1' }] }, { id: 'p2', checkouts: [{ id: 'c2' }] }], { c2: 'p1' })
  const migrated = migrateProjectState(state, grouped.threads)
  assert.deepEqual(migrated.plots, { Garden: [[4, 5]] })
  assert.deepEqual(migrated.hiddenProjects, ['Garden'])
  assert.equal(migrated.projectMigrations, undefined)
})

test('corrupt saved colony is reported and cannot be silently overwritten with an empty state', async () => {
  await withServer(async ({ call, put, dir }) => {
    const file = path.join(dir, 'colony.json')
    await fs.writeFile(file, '{broken')
    const read = await call('/api/state')
    assert.equal(read.status, 500)
    assert.match((await read.json()).error, /left untouched/)
    assert.equal((await put({ archived: [] })).status, 500)
    assert.equal(await fs.readFile(file, 'utf8'), '{broken')
  })
})

test('an unused worktree can be grouped and remains listed without inventing a session', () => {
  const rows = [{ id: 'a', projectId: 'p1', checkoutId: 'c1' }, { id: 'b', projectId: 'p2', checkoutId: 'c2' }]
  const inventory = [{ id: 'p1', checkouts: [{ id: 'c1' }, { id: 'empty' }] }, { id: 'p2', checkouts: [{ id: 'c2' }] }]
  const out = groupProjects(rows, inventory, { empty: 'p2' })
  assert.deepEqual(out.projects.find(p => p.id === 'p2').checkouts.map(c => c.id), ['empty', 'c2'])
  assert.equal(out.threads.length, 2)
})

import { migrateSessionState } from '../src/game/projects.js'
test('proven Rhythm engine alias carries archive and viewed preferences without losing the old IDs', () => {
  const old = { archived: ['opencode:engine'], opened: ['opencode:engine'], viewedAt: { 'opencode:engine': 42 }, seen: { 'opencode:engine': 1 } }
  const migrated = migrateSessionState(old, [{ id: 'rhythm:local', dedupeIds: ['opencode:engine'] }])
  assert.deepEqual(migrated.archived, ['opencode:engine', 'rhythm:local'])
  assert.equal(migrated.viewedAt['rhythm:local'], 42)
  assert.equal(migrated.seen['rhythm:local'], 1)
  assert.deepEqual(old.archived, ['opencode:engine'])
  const unarchived = { ...migrated, archived: ['opencode:engine'], viewedAt: { ...migrated.viewedAt, 'rhythm:local': 99 } }
  assert.equal(migrateSessionState(unarchived, [{ id: 'rhythm:local', dedupeIds: ['opencode:engine'] }]), unarchived)
  assert.equal(migrateSessionState(old, [{ id: 'a', dedupeIds: ['opencode:engine'] }, { id: 'b', dedupeIds: ['opencode:engine'] }]), old)
})

test('session migration markers survive saved-state round trips', async () => {
  await withServer(async ({ call, put }) => {
    assert.equal((await put({ sessionMigrations: { 'opencode:engine': 'rhythm:local' } })).status, 200)
    assert.deepEqual((await (await call('/api/state')).json()).sessionMigrations, { 'opencode:engine': 'rhythm:local' })
  })
})
