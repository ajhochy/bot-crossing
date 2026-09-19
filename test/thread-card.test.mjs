import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

// Load the browser module through its real bundler so import.meta.env is resolved.
const vite = await createServer({ configFile: false, server: { middlewareMode: true, watch: null }, appType: 'custom' })
let Hud
try { ({ Hud } = await vite.ssrLoadModule('/src/ui/hud.js')) }
finally { await vite.close() }

// The DOM is the boundary; the production HUD setter supplies every displayed value.
function fixture() {
  const nodes = new Map()
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      classList: { add() {}, remove() {}, toggle() {} }, style: {},
      textContent: '', innerHTML: '', hidden: false, open: false,
      offsetWidth: 304, offsetHeight: 300,
    })
    return nodes.get(selector)
  }
  const hud = Object.create(Hud.prototype)
  hud.$ = node
  hud.settings = { get: () => 'app' }
  hud.actions = {}
  hud.isPhone = () => false
  return { hud, node }
}

test('overview-card: selected task puts exact path and branch on readable rows and evidence behind details', () => {
  // Regression: paths, capability diagnostics, and read-state prose fill one paragraph,
  // while the branch is squeezed into a tiny pill in the avatar header.
  const { hud, node } = fixture()
  const thread = { id: 'codex:worker', title: 'Worker', harnessName: 'Codex',
    cwd: '/fixture/garden/long-worker-directory', gitBranch: 'codex/very-long-worker-branch',
    activityEvidence: 'Persisted lifecycle observation with a detailed explanation',
    openCapabilities: { app: { available: false, reason: 'Detailed app navigation explanation' }, terminal: { available: true } },
    lastActivityAt: Date.now(), unread: null, parentId: 'codex:parent' }
  hud.setSelection({ status: 'idle', trim: { getHex: () => 0xffffff } }, thread)
  assert.equal(node('.thread-pop .session-path').textContent, thread.cwd)
  assert.equal(node('.thread-pop .session-path').title, thread.cwd)
  assert.equal(node('.thread-pop .session-branch').textContent, thread.gitBranch)
  assert.equal(node('.thread-pop .session-branch').title, thread.gitBranch)
  assert.doesNotMatch(node('.thread-pop .meta').innerHTML, /very-long-worker-branch|Persisted lifecycle|Detailed app/)
  assert.match(node('.thread-pop .session-details-body').innerHTML, /Persisted lifecycle observation/)
  assert.match(node('.thread-pop .session-details-body').innerHTML, /Detailed app navigation explanation/)
  assert.equal(node('.thread-pop .session-details').open, false)
  assert.equal(node('#btn-open-terminal').hidden, false)
  assert.equal(node('.session-parent').hidden, false)
})
