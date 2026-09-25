import test from 'node:test'
import assert from 'node:assert/strict'
import { createEmbeddedHostController, filterEmbeddedThreads } from '../src/game/embedded-api.js'

function fixture() {
  let subscriber
  const emitted = []
  const bridge = {
    product: 'colony', protocolVersion: 1,
    request: async (method, payload) => { emitted.push({ method, payload }); return {} },
    onHostEvent(handler) { subscriber = handler; return () => { subscriber = null } },
  }
  const selected = []
  const filters = []
  const views = []
  const visibility = []
  const controller = createEmbeddedHostController(bridge, {
    select: (threadId, options) => selected.push({ threadId, options }),
    filter: value => filters.push(value),
    view: value => views.push(value),
    visibility: value => visibility.push(value),
  })
  return { controller, emitted, selected, filters, views, visibility, host: event => subscriber(event) }
}

test('bot selection emits one typed scene intent and host selection focuses the matching bot', async () => {
  const f = fixture()
  await f.controller.sceneSelected('codex:worker-1')
  assert.deepEqual(f.emitted, [{ method: 'scene.select', payload: { threadId: 'codex:worker-1' } }])
  f.host({ event: 'host.select', payload: { threadId: 'codex:worker-2' } })
  assert.deepEqual(f.selected, [{ threadId: 'codex:worker-2', options: { fly: true } }])
})

test('host filters, view preferences, visibility and webgl loss route through typed behavior', async () => {
  const f = fixture()
  const filter = { query: 'worker', harness: ['codex'], activity: ['working'], includeHistorical: false }
  const view = { quality: 'low', sound: false, motion: 'reduced', resetCamera: true, focusSelection: true }
  f.host({ event: 'host.filter', payload: filter })
  f.host({ event: 'host.view', payload: view })
  f.host({ event: 'host.visibility', payload: { hidden: true } })
  await f.controller.webglLost()
  assert.deepEqual(f.filters, [filter])
  assert.deepEqual(f.views, [view])
  assert.deepEqual(f.visibility, [{ hidden: true }])
  assert.deepEqual(f.emitted.at(-1), { method: 'scene.status', payload: { webgl: 'lost' } })
})

test('embedded multi-select filters apply the same query, harness and activity scope to scene records', () => {
  const rows = [
    { id: 'a', title: 'Release worker', harness: 'codex', activity: 'working' },
    { id: 'b', title: 'Release parent', harness: 'rhythm', activity: 'waiting' },
    { id: 'c', title: 'Other task', harness: 'codex', activity: 'blocked' },
  ]
  assert.deepEqual(filterEmbeddedThreads(rows, { query: 'release', harness: ['codex', 'rhythm'], activity: ['working', 'waiting'] }).map(row => row.id), ['a', 'b'])
})

test('embedded HUD keeps standalone controls detached while standalone mode mounts them unchanged', async () => {
  class Element {
    constructor() {
      this.children = []
      this.nodes = new Map()
      this.classList = { add() {}, remove() {}, toggle() {}, contains() { return false } }
      this.style = { setProperty() {} }
      this.dataset = {}
      this.offsetWidth = 304
      this.offsetHeight = 300
      this.offsetTop = 0
      this.offsetLeft = 0
      this.clientWidth = 1000
      this.clientHeight = 700
    }
    appendChild(child) { this.children.push(child); child.parentElement = this; return child }
    append(...children) { for (const child of children) this.appendChild(child) }
    querySelector(selector) { if (!this.nodes.has(selector)) this.nodes.set(selector, new Element()); return this.nodes.get(selector) }
    addEventListener() {}
    setAttribute(name, value) { this[name] = value }
    getContext() { return { clearRect() {}, drawImage() {}, fillRect() {} } }
  }
  const prior = {
    document: globalThis.document, navigator: globalThis.navigator, window: globalThis.window,
    ResizeObserver: globalThis.ResizeObserver, getComputedStyle: globalThis.getComputedStyle,
    colonyEmbedded: globalThis.colonyEmbedded,
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { platform: 'MacIntel' } })
  globalThis.document = { createElement: () => new Element(), activeElement: null }
  globalThis.window = { innerWidth: 1000, innerHeight: 700, matchMedia: () => ({ matches: false }) }
  globalThis.ResizeObserver = class { observe() {} }
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '0' })
  const settings = { get: key => ({ followSelected: true, sound: true }[key]), set() {}, applyPreset() {},
    isOverridden: () => false, onChange: () => () => {} }
  try {
    const { createServer } = await import('vite')
    const vite = await createServer({ configFile: false, cacheDir: `/private/tmp/bc-host-vite-${process.pid}`,
      server: { middlewareMode: true, watch: null }, appType: 'custom' })
    const { Hud } = await vite.ssrLoadModule('/src/ui/hud.js')
    globalThis.colonyEmbedded = {}
    const embeddedRoot = new Element()
    const embeddedHud = new Hud(embeddedRoot, settings, {})
    assert.equal(embeddedRoot.children.includes(embeddedHud.el), false)
    assert.ok(embeddedHud.$('#btn-open'))
    assert.ok(embeddedHud.$('#btn-new-session'))
    delete globalThis.colonyEmbedded
    const standaloneRoot = new Element()
    const standaloneHud = new Hud(standaloneRoot, settings, {})
    assert.equal(standaloneRoot.children.includes(standaloneHud.el), true)
    await vite.close()
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete globalThis[key]
      else Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
    }
  }
})
