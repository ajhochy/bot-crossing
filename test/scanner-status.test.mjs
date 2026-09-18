import test from 'node:test'
import assert from 'node:assert/strict'
import { harnessStatus } from '../server/scan.mjs'

test('combined harness status accepts synchronous diagnostics and isolates diagnostic failures', async () => {
  const rows = await harnessStatus([
    { id: 'old-profile', name: 'Old profile', detect: () => true, diagnostic: () => 'One profile is unreadable' },
    { id: 'async', name: 'Async', detect: async () => true, diagnostic: async () => 'Offline metadata' },
    { id: 'broken', name: 'Broken', detect: () => { throw new Error('missing') }, diagnostic: () => { throw new Error('missing') } },
  ])
  assert.deepEqual(rows, [
    { id: 'old-profile', name: 'Old profile', detected: true, error: 'One profile is unreadable' },
    { id: 'async', name: 'Async', detected: true, error: 'Offline metadata' },
    { id: 'broken', name: 'Broken', detected: false, error: '' },
  ])
})
