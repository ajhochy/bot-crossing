export function disambiguateProjects(threads) {
  // Windows hands the same checkout back as `c:\…` from one transcript and `C:\…` from
  // another: the CLI's project-directory encoding keeps whatever case the drive letter was
  // given. Those are one path, not two — and counted as two they make an unambiguous name look
  // ambiguous, which renames a plot on a machine that has no collision at all.
  //
  // Codex hands the same checkout back a third way: with the extended-length prefix, as
  // `\\?\C:\…`. That does not begin with a drive letter, so the case fold below never reached
  // it and one folder on disk arrived here as two paths — enough to make `geh` look ambiguous
  // against itself and rename both plots to their full absolute paths. Drop the prefix first,
  // but only where a drive follows it: `\\?\UNC\server\share` is a different animal, and
  // folding its first character would be wrong.
  const canonical = (p) => {
    const s = /^\\\\\?\\[A-Za-z]:[\\/]/.test(p) ? p.slice(4) : p
    return /^[A-Za-z]:[\\/]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s
  }

  const pathsByName = new Map()
  for (const t of threads) {
    if (!t.project) continue
    if (!pathsByName.has(t.project)) pathsByName.set(t.project, new Set())
    pathsByName.get(t.project).add(canonical(t.projectPath || ''))
  }

  const renames = new Map()
  for (const [name, paths] of pathsByName) {
    if (paths.size < 2) continue
    const list = [...paths]
    // Both separators. A Windows path splits on neither otherwise, leaving a single "segment"
    // that is the whole absolute path — which then becomes the plot's name on the map.
    const segments = list.map((p) => p.split(/[\\/]/).filter(Boolean))
    const deepest = Math.max(...segments.map((s) => s.length))

    // Take one more trailing segment until every path in the group reads differently. Paths
    // that differ at all must separate by `deepest`, so this always terminates. A thread with
    // no path at all cannot be told apart by one, so it keeps the bare name and the others
    // move around it.
    const labelAt = (segs, depth) => (segs.length ? segs.slice(-depth).join('/') : name)
    let depth = 1
    let labels = segments.map((segs) => labelAt(segs, depth))
    while (new Set(labels).size < list.length && depth < deepest) {
      depth += 1
      labels = segments.map((segs) => labelAt(segs, depth))
    }
    list.forEach((path, i) => renames.set(`${name}\u0000${path}`, labels[i]))
  }

  if (!renames.size) return threads
  return threads.map((t) => {
    const next = renames.get(`${t.project || ''}\u0000${canonical(t.projectPath || '')}`)
    return next && next !== t.project ? { ...t, project: next } : t
  })
}


export function reconcileHarnessDuplicates(threads) {
  const engine = new Map(
    threads.filter(t => t.harness === 'opencode').map(t => [t.id, t])
  )
  const claimed = new Set(
    threads.filter(t => t.harness === 'rhythm').flatMap(t => t.dedupeIds || [])
  )

  return threads.flatMap((thread) => {
    if (thread.harness === 'opencode' && claimed.has(thread.id)) return []
    if (thread.harness !== 'rhythm' || !thread.stale) return [thread]

    // Keep Rhythm's durable local id, profile, checkout, and parent graph during an adapter
    // failure. When its mapped engine row is current, overlay only the volatile activity facts so
    // one worker stays on the map with fresh behavior instead of a second raw OpenCode copy.
    const current = (thread.dedupeIds || [])
      .map(id => engine.get(id))
      .find(candidate => candidate && !candidate.stale)
    if (!current) return [{ ...thread, staleMetadata: true }]
    return [{
      ...thread,
      activity: current.activity,
      running: current.running,
      hasError: current.hasError,
      lastActivityAt: current.lastActivityAt || thread.lastActivityAt,
      activityEvidence: `Rhythm metadata stale; ${current.activityEvidence || 'current OpenCode store activity'}`,
      engineActivityEvidence: current.activityEvidence || 'current OpenCode store activity',
      staleMetadata: true,
    }]
  })
}
