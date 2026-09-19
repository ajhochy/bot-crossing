/** Opt-in, read-only HTTP smoke. Run against this fork's built loopback server. */
import assert from 'node:assert/strict'

const base = process.env.BOT_CROSSING_LIVE_URL
if (!base) throw new Error('Set BOT_CROSSING_LIVE_URL to the running loopback server')
const url = new URL(base)
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Live smoke must stay on loopback')
async function get(route) {
  const response = await fetch(new URL(route, base))
  assert.equal(response.status, 200, route)
  return response.json()
}
const samples = []
for (const phase of ['cold', 'warm']) {
  const started = performance.now()
  const result = await get('/api/threads')
  assert.ok(result.threads.length > 0, 'Real harness sessions discovered')
  assert.ok(!result.warnings.some(w => /Synthetic preview/.test(w)), 'Live evidence must use actual harness stores')
  const ids = new Set(result.threads.map(t => t.id))
  assert.equal(ids.size, result.threads.length, 'Every session appears once')
  const checkouts = new Map(result.projects.flatMap(p => p.checkouts.map(c => [c.id, { ...c, projectId: p.id }])))
  const perHarness = {}
  for (const t of result.threads) {
    assert.ok(t.projectId && t.checkoutId && typeof t.repositoryId === 'string', 'Session identities are normalized; non-Git has no repository')
    assert.equal(checkouts.get(t.checkoutId)?.projectId, t.projectId, 'Session belongs to its checkout project')
    assert.notEqual(t.parentId, t.id, 'No self-parent edge')
    for (const alias of t.dedupeIds || []) assert.ok(!ids.has(alias), 'Mapped engine session is not duplicated')
    const counts = perHarness[t.harness] ||= { conversations: 0, workers: 0 }
    counts[t.parentId ? 'workers' : 'conversations']++
  }
  samples.push({ phase, elapsedMs: Math.round(performance.now() - started), sessions: ids.size,
    projects: result.projects.length, checkouts: checkouts.size, metrics: result.metrics,
    warningCount: result.warnings.length, perHarness })
}
assert.equal((await get('/api/state')).version, 3, 'Saved-state version')
assert.ok(Array.isArray((await get('/api/harnesses')).harnesses), 'Harness capabilities available')
console.log(JSON.stringify({ result: 'PASS', samples }, null, 2))
