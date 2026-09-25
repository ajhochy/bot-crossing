import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createEmbeddedService } from '../server/embedded-service.mjs'
import { createEmbeddedVisibilityScheduler, applyEmbeddedQuality } from '../src/game/embedded-api.js'
import { Engine } from '../src/core/engine.js'
import { Ambience } from '../src/audio/ambience.js'

test('visibility scheduler skips polling while either document or host is hidden and refreshes once on return', () => {
  let documentHidden = false
  let interval
  let polls = 0
  const scheduler = createEmbeddedVisibilityScheduler({ poll: () => { polls++ }, isDocumentHidden: () => documentHidden,
    setIntervalFn: callback => { interval = callback; return 1 }, clearIntervalFn() {}, period: 15_000 })
  interval()
  assert.equal(polls, 1)
  documentHidden = true
  interval()
  assert.equal(polls, 1)
  documentHidden = false
  scheduler.setHostHidden(true)
  interval()
  assert.equal(polls, 1)
  scheduler.setHostHidden(false)
  assert.equal(polls, 2)
  scheduler.documentVisibilityChanged()
  assert.equal(polls, 2, 'already-visible notification must not double refresh')
  scheduler.dispose()
})

test('host hidden stops engine animation and mutes ambience until visible', () => {
  const loops = []
  const engine = Object.create(Engine.prototype)
  engine.running = true
  engine.hostHidden = false
  engine._boundLoop = () => {}
  engine.renderer = { setAnimationLoop: value => loops.push(value) }
  engine._onWake = () => loops.push('wake')
  engine.setHostHidden(true)
  engine.setHostHidden(false)
  assert.deepEqual(loops, [null, engine._boundLoop, 'wake'])

  const targets = []
  const ambience = Object.create(Ambience.prototype)
  Object.assign(ambience, { _hostHidden: false, _enabled: true, _visible: true, ctx: { currentTime: 1 },
    mute: { gain: { setTargetAtTime: value => targets.push(value) } } })
  ambience.setHostHidden(true)
  ambience.setHostHidden(false)
  assert.deepEqual(targets, [0, 1])
})

test('cached 15,000-thread snapshot serves another first page without rescanning and cancel refreshes generation', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-resource-'))
  let scans = 0
  const records = Array.from({ length: 15_000 }, (_, index) => ({ id: `thread-${index}` }))
  const service = createEmbeddedService({ dataDir: dir, scan: async () => { scans++; return { threads: records, projects: [], warnings: [], scannedAt: 44 } } })
  try {
    const first = await service.invoke('inventory.page', { collection: 'threads', limit: 250 })
    const cached = await service.invoke('inventory.page', { collection: 'threads', limit: 250 })
    assert.equal(scans, 1)
    assert.equal(cached.generation, first.generation)
    assert.equal(cached.scannedAt, 44)
    await service.invoke('inventory.cancel', { generation: first.generation })
    const refreshed = await service.invoke('inventory.page', { collection: 'threads', limit: 1 })
    assert.equal(scans, 2)
    assert.notEqual(refreshed.generation, first.generation)
  } finally { service.dispose(); await fs.rm(dir, { recursive: true, force: true }) }
})

test('inventory.cancel during a named scan rejects all waiters and the next generation can scan', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-cancel-'))
  let release
  let scans = 0
  const service = createEmbeddedService({ dataDir: dir, scan: async () => { scans++; return new Promise(resolve => { release = resolve }) } })
  try {
    const first = service.invoke('inventory.page', { generation: 'refresh-1', collection: 'threads', limit: 1 })
    const waiter = service.invoke('inventory.page', { generation: 'refresh-1', collection: 'projects', limit: 1 })
    await new Promise(resolve => setImmediate(resolve))
    await service.invoke('inventory.cancel', { generation: 'refresh-1' })
    release({ threads: [], projects: [], warnings: [], scannedAt: 1 })
    await assert.rejects(first, /cancel/i)
    await assert.rejects(waiter, /cancel/i)
    const next = service.invoke('inventory.page', { generation: 'refresh-2', collection: 'threads', limit: 1 })
    await new Promise(resolve => setImmediate(resolve))
    release({ threads: [], projects: [], warnings: [], scannedAt: 2 })
    assert.equal((await next).scannedAt, 2)
    assert.equal(scans, 2)
  } finally { service.dispose(); await fs.rm(dir, { recursive: true, force: true }) }
})

test('embedded low quality caps render scale and disables costly passes', () => {
  const values = { renderScale: 2, bloom: true, tiltShift: true, ambientOcclusion: 1, clouds: true }
  const settings = { applyPreset() {}, get: key => values[key], set: (key, value) => { values[key] = value } }
  applyEmbeddedQuality(settings, 'low')
  assert.ok(values.renderScale <= 0.7)
  assert.deepEqual({ bloom: values.bloom, tiltShift: values.tiltShift, ambientOcclusion: values.ambientOcclusion, clouds: values.clouds },
    { bloom: false, tiltShift: false, ambientOcclusion: 0, clouds: false })
})
