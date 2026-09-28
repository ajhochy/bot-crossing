import { disambiguateProjects, reconcileHarnessDuplicates } from './scan-identity.mjs'
export { disambiguateProjects, reconcileHarnessDuplicates } from './scan-identity.mjs'
/**
 * Harness-agnostic thread scanning.
 *
 * This module knows nothing about any particular agent harness: it asks every harness that
 * is present on this machine for its threads, stamps each one with which harness it came
 * from, and hands back a single list sorted by recency. Everything harness-specific lives
 * in `server/harnesses/` — see the README there.
 */
import { HARNESSES, detectedHarnesses, harnessById } from './harnesses/index.mjs'
export { createProjectResolver } from './projects.mjs'

/**
 * A project's ground is keyed on its name, and a name is the last segment of its path — so two
 * checkouts of the same repo, `~/workspaces/1/foo` and `~/workspaces/2/foo`, are both "foo".
 * Left alone they share one plot and their threads become indistinguishable, which is wrong for
 * anyone keeping parallel copies instead of using worktrees.
 *
 * Where a name is ambiguous, grow it leftward along the path until it is not: `1/foo` and
 * `2/foo`. Only names that actually collide are touched, and that restraint is the point — the
 * name is also the key a saved layout is stored under, so disambiguating unconditionally would
 * move every plot on everybody's map to fix something most people never hit.
 */

/**
 * Every thread from every detected harness.
 *
 * A harness that throws is skipped rather than allowed to take the scan down with it: one
 * broken adapter should cost you that harness's threads, not the whole colony.
 */
let pendingScan = null
const scanFailures = new Map()
const lastGood = new Map()
export function scanThreads() {
  if (!pendingScan) pendingScan = scanAll().finally(() => { pendingScan = null })
  return pendingScan
}


async function scanAll() {
  const harnesses = await detectedHarnesses()
  const lists = await Promise.all(
    harnesses.map(async (h) => {
      try {
        const threads = await h.scanThreads()
        const stamped = threads.map((t) => ({ ...t, harness: h.id, harnessName: h.name }))
        scanFailures.delete(h.id)
        lastGood.set(h.id, stamped)
        return stamped
      } catch (err) {
        console.warn(`bot-crossing: harness "${h.id}" failed to scan —`, err?.message || err)
        scanFailures.set(h.id, `${h.name}: scan failed; previous observations may be stale`)
        return (lastGood.get(h.id) || []).map(t => ({ ...t, stale: true, activity: 'unknown', running: null,
          activityEvidence: 'Scan failed; last successful observation retained' }))
      }
    })
  )
  const threads = disambiguateProjects(reconcileHarnessDuplicates(lists.flat()))
  threads.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return threads
}

/** What the HUD shows in the harness list: who is installed, and what they can do. */
export async function harnessStatus(harnesses = HARNESSES) {
  return Promise.all(
    harnesses.map(async (h) => ({
      id: h.id,
      name: h.name,
      detected: await Promise.resolve().then(() => h.detect()).catch(() => false),
      // Optional. An adapter that can see its harness but cannot read it — wrong Node, a store
      // it does not understand — says why here instead of failing silently on every poll.
      error: scanFailures.get(h.id) || (h.diagnostic ? await Promise.resolve().then(() => h.diagnostic()).catch(() => '') : ''),
    }))
  )
}

/** The harness to use when a caller has not said — the first one present on this machine. */
export async function defaultHarness() {
  const [first] = await detectedHarnesses()
  return first?.id || ''
}

const dispatch = (harnessId) => {
  const h = harnessById(harnessId)
  if (!h) throw new Error(`Unknown harness "${harnessId}"`)
  return h
}

/** Both may be async: an adapter that has to look for a CLI on disk cannot answer synchronously. */
export const openThread = async (harnessId, ref) => dispatch(harnessId).openThread(ref)

export const newSession = async (harnessId, dir) => dispatch(harnessId).newSession(dir)
