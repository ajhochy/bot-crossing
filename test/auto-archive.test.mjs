import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcileHarnessDuplicates } from '../server/scan.mjs'
import { projectOverview } from '../src/game/projects.js'

let archiveModule = {}
try { archiveModule = await import('../src/game/auto-archive.js') } catch {}

const HOUR = 60 * 60 * 1000
const NOW = Date.parse('2026-09-26T12:00:00.000Z')

test('task-bot-crossing-c1: one deterministic update archives every eligible thread with one timestamp and is idempotent', () => {
  // Regression: per-row state writes churn the 8K-row archive and repeated scans save it again.
  assert.equal(typeof archiveModule.autoArchiveInactiveThreads, 'function')
  const state = { archived: [], archivedAt: {}, unarchivedAt: {} }
  const threads = Array.from({ length: 8_000 }, (_, index) => ({
    id: `rhythm:${index}`,
    running: false,
    activity: 'quiet',
    lastActivityAt: NOW - 49 * HOUR,
    ...(index % 2 ? { parentId: `rhythm:root-${index}` } : {}),
  }))
  const next = archiveModule.autoArchiveInactiveThreads(state, threads, { now: NOW })
  assert.notEqual(next, state)
  assert.equal(next.archived.length, 8_000)
  assert.equal(new Set(Object.values(next.archivedAt)).size, 1)
  assert.equal(next.archivedAt['rhythm:0'], NOW)
  assert.equal(archiveModule.autoArchiveInactiveThreads(next, threads, { now: NOW }), next)
})

test('task-bot-crossing-c14: exactly 48h is retained and only inactivity over 48h is eligible', () => {
  // Regression: stale/unknown or future-dated harness rows get hidden as if definitely inactive.
  assert.equal(typeof archiveModule.autoArchiveInactiveThreads, 'function')
  const candidates = [
    { id: 'root-boundary', running: false, activity: 'quiet', lastActivityAt: NOW - 48 * HOUR },
    { id: 'worker-old', parentId: 'root-boundary', running: false, activity: 'quiet', lastActivityAt: NOW - 48 * HOUR - 1 },
    { id: 'recent', running: false, activity: 'quiet', lastActivityAt: NOW - 48 * HOUR + 1 },
    { id: 'running', running: true, activity: 'running', lastActivityAt: NOW - 100 * HOUR },
    { id: 'unknown-running', running: null, activity: 'unknown', lastActivityAt: NOW - 100 * HOUR },
    { id: 'unknown-activity', running: false, activity: 'unknown', lastActivityAt: NOW - 100 * HOUR },
    { id: 'stale', running: false, activity: 'quiet', stale: true, lastActivityAt: NOW - 100 * HOUR },
    { id: 'stale-metadata', running: false, activity: 'quiet', staleMetadata: true, lastActivityAt: NOW - 100 * HOUR },
    { id: 'missing', running: false, activity: 'quiet', lastActivityAt: null },
    { id: 'invalid', running: false, activity: 'quiet', lastActivityAt: Number.NaN },
    { id: 'zero', running: false, activity: 'quiet', lastActivityAt: 0 },
    { id: 'future', running: false, activity: 'quiet', lastActivityAt: NOW + 1 },
    { id: 'harness-archived', running: false, activity: 'quiet', archived: true, lastActivityAt: NOW - 100 * HOUR },
    { id: 'colony-archived', running: false, activity: 'quiet', lastActivityAt: NOW - 100 * HOUR },
  ]
  const next = archiveModule.autoArchiveInactiveThreads(
    { archived: ['colony-archived'], archivedAt: { 'colony-archived': NOW - HOUR }, unarchivedAt: {} },
    candidates,
    { now: NOW },
  )
  assert.deepEqual(next.archived, ['colony-archived', 'worker-old'])
})

test('task-bot-crossing-c15: one auto-archive batch emits one recovery notice and an unchanged repeat emits none', () => {
  // Regression: thousands of candidates create one toast each, or unchanged polls repeat the batch notice.
  assert.equal(typeof archiveModule.autoArchiveBatch, 'function')
  const threads = Array.from({ length: 3 }, (_, index) => ({
    id: `old:${index}`, running: false, activity: 'quiet', lastActivityAt: NOW - 49 * HOUR,
  }))
  const first = archiveModule.autoArchiveBatch({ archived: [], archivedAt: {}, unarchivedAt: {} }, threads, { now: NOW })
  assert.equal(first.notice, 'Archived 3 tasks inactive for over 48 hours. Choose Archived to review or restore.')
  assert.equal(first.state.archived.length, 3)
  const repeat = archiveModule.autoArchiveBatch(first.state, threads, { now: NOW })
  assert.equal(repeat.state, first.state)
  assert.equal(repeat.notice, null)
})

test('task-bot-crossing-c5: restore grace wins for 48h and newer source activity wins naturally afterward', () => {
  // Regression: the next scan immediately re-archives a manually restored old thread.
  assert.equal(typeof archiveModule.autoArchiveInactiveThreads, 'function')
  const restoredAt = NOW - HOUR
  const state = { archived: [], archivedAt: {}, unarchivedAt: { restored: restoredAt } }
  const old = { id: 'restored', running: false, activity: 'quiet', lastActivityAt: NOW - 100 * HOUR }
  assert.equal(archiveModule.autoArchiveInactiveThreads(state, [old], { now: NOW }), state)
  const later = NOW + 49 * HOUR
  const reArchived = archiveModule.autoArchiveInactiveThreads(state, [old], { now: later })
  assert.deepEqual(reArchived.archived, ['restored'])
  const activeLater = { ...old, lastActivityAt: later - HOUR }
  assert.equal(archiveModule.autoArchiveInactiveThreads(state, [activeLater], { now: later }), state)
})

test('task-bot-crossing-c6: Colony restore and re-archive update local state truthfully without mutating harness rows', () => {
  // Regression: Restore only changes the label, or clears source-owned harness archive state.
  assert.equal(typeof archiveModule.restoreColonyThread, 'function')
  assert.equal(typeof archiveModule.archiveColonyThread, 'function')
  const harnessArchived = { id: 'source', archived: true }
  const base = { archived: ['local', 'source'], archivedAt: { local: 1, source: 2 }, unarchivedAt: {} }
  assert.equal(archiveModule.restoreColonyThread(base, harnessArchived, { now: NOW }), base)
  const restored = archiveModule.restoreColonyThread(base, { id: 'local', archived: false }, { now: NOW })
  assert.deepEqual(restored.archived, ['source'])
  assert.equal(Object.hasOwn(restored.archivedAt, 'local'), false)
  assert.equal(restored.unarchivedAt.local, NOW)
  const archived = archiveModule.archiveColonyThread(restored, { id: 'local', archived: false }, { now: NOW + 1 })
  assert.equal(archived.archivedAt.local, NOW + 1)
  assert.equal(Object.hasOwn(archived.unarchivedAt, 'local'), false)
  assert.equal(harnessArchived.archived, true, 'source row remains untouched')
})

test('task-bot-crossing-c7: 16.2K mixed rows preserve Rhythm identity and rank recent Rhythm deterministically after archive', () => {
  // Regression: raw aliases or stale error rows consume the entire capped scene roster.
  assert.equal(typeof archiveModule.rankColonyRoster, 'function')
  const rhythm = Array.from({ length: 8_600 }, (_, index) => ({
    id: `rhythm:${index}`,
    harness: 'rhythm',
    running: false,
    activity: 'quiet',
    lastActivityAt: index < 60 ? NOW - index * 1000 : NOW - 100 * HOUR,
    projectId: 'project:rhythm',
    project: 'project:rhythm',
    ...(index < 100 ? { dedupeIds: [`opencode:alias-${index}`] } : {}),
  }))
  const openCode = Array.from({ length: 7_600 }, (_, index) => ({
    id: index < 100 ? `opencode:alias-${index}` : `opencode:standalone-${index}`,
    harness: 'opencode',
    running: null,
    activity: 'unknown',
    stale: true,
    hasError: true,
    lastActivityAt: NOW - 200 * HOUR,
    projectId: 'project:opencode',
    project: 'project:opencode',
  }))
  const combined = reconcileHarnessDuplicates([...rhythm, ...openCode])
  assert.equal(combined.length, 16_100)
  assert.equal(combined.filter(row => row.harness === 'rhythm').length, 8_600)
  assert.equal(combined.some(row => row.id === 'opencode:alias-0'), false)
  assert.equal(combined.some(row => row.id === 'opencode:standalone-100'), true)

  const state = archiveModule.autoArchiveInactiveThreads({ archived: [], archivedAt: {}, unarchivedAt: {} }, combined, { now: NOW })
  assert.equal(state.archived.length, 8_540)
  const visible = combined.filter(row => !state.archived.includes(row.id))
  const roster = archiveModule.rankColonyRoster(visible, 60)
  assert.deepEqual(roster.map(row => row.id), Array.from({ length: 60 }, (_, index) => `rhythm:${index}`))

  const inventory = [
    { id: 'project:rhythm', checkouts: [{ id: 'present', kind: 'directory', missing: false }] },
    { id: 'project:missing', checkouts: [{ id: 'missing', kind: 'missing', missing: true }] },
  ]
  const overview = projectOverview([
    { ...rhythm[0], projectId: 'project:rhythm' },
    { ...rhythm[1], id: 'rhythm:historical', projectId: 'project:missing', project: 'project:missing' },
  ], inventory, { includeHistorical: false })
  assert.deepEqual(overview.threads.map(row => row.id), ['rhythm:0'])
})
