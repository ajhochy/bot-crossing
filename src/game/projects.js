/** Pure project preferences: no filesystem or harness writes. */
export function groupProjects(threads, inventory, overrides = {}, aliases = {}) {
  const byId = new Map(inventory.map(p => [p.id, p]))
  const projects = new Map()
  const ensure = (id, source) => {
    if (!projects.has(id)) {
      const target = byId.get(id) || source || {}
      projects.set(id, { ...target, id, name: aliases[id] || target.name || 'Unknown project', checkouts: [], repositoryIds: [] })
    }
    return projects.get(id)
  }
  // Inventory is independent of conversations: an unused linked checkout remains inspectable.
  for (const source of inventory) for (const c of source.checkouts || []) {
    const id = overrides[c.id] || overrides[c.repositoryId] || source.id
    const p = ensure(id, source)
    if (!p.checkouts.some(x => x.id === c.id)) p.checkouts.push(c)
    if (c.repositoryId && !p.repositoryIds.includes(c.repositoryId)) p.repositoryIds.push(c.repositoryId)
  }
  const out = threads.map(t => {
    const original = t.defaultProjectId || t.projectId || t.project
    const projectId = overrides[t.checkoutId] || overrides[t.repositoryId] || original
    const p = ensure(projectId, byId.get(original) || { name: t.projectName || t.project })
    if (t.checkout && !p.checkouts.some(c => c.id === t.checkoutId)) p.checkouts.push(t.checkout)
    return { ...t, project: projectId, projectId, defaultProjectId: original, projectName: p.name }
  })
  return { threads: out, projects: [...projects.values()] }
}

/** Retain old keys as a reversible migration record; never guess which collision was intended. */
export function migrateProjectState(state, threads) {
  const candidates = new Map()
  for (const t of threads) {
    const id = t.defaultProjectId || t.projectId
    if (!t.legacyProject || !id) continue
    if (!candidates.has(t.legacyProject)) candidates.set(t.legacyProject, new Set())
    candidates.get(t.legacyProject).add(id)
  }
  const plots = { ...state.plots }
  const hidden = new Set(state.hiddenProjects || [])
  const migrations = { ...state.projectMigrations }
  let changed = false
  for (const [name, ids] of candidates) {
    if (migrations[name]) continue
    if (!(name in plots) && !hidden.has(name)) continue
    if (ids.size !== 1) continue
    const [id] = ids
    if (plots[name] && !plots[id]) plots[id] = structuredClone(plots[name])
    if (hidden.has(name)) hidden.add(id)
    migrations[name] = id
    changed = true
  }
  return changed ? { ...state, plots, hiddenProjects: [...hidden], projectMigrations: migrations } : state
}

/** A proven engine alias can carry colony preferences to its owning harness without losing the old key. */
export function migrateSessionState(state, threads) {
  const owners = new Map()
  for (const t of threads) for (const alias of t.dedupeIds || []) {
    if (!owners.has(alias)) owners.set(alias, new Set())
    owners.get(alias).add(t.id)
  }
  let next = state
  for (const [alias, ids] of owners) {
    if (ids.size !== 1 || next.sessionMigrations?.[alias]) continue
    const [id] = ids
    for (const key of ['archived', 'opened']) {
      if (next[key]?.includes(alias) && !next[key].includes(id)) next = { ...next, [key]: [...next[key], id] }
    }
    for (const key of ['archivedAt', 'viewedAt', 'seen']) {
      if (next[key]?.[alias] && !next[key][id]) next = { ...next, [key]: { ...next[key], [id]: next[key][alias] } }
    }
    // The old key is a backup, not an instruction to re-archive after a later user edit.
    next = { ...next, sessionMigrations: { ...next.sessionMigrations, [alias]: id } }
  }
  return next
}

export function filterSessions(threads, { query = '', checkout = '', harness = '', status = '' } = {}) {
  const needle = query.toLowerCase().trim()
  return threads.filter(t => (!checkout || t.checkoutId === checkout) && (!harness || t.harness === harness) &&
    (!status || (status === 'active' ? t.running === true : status === 'unknown' ? t.activity === 'unknown' || t.running == null :
      status === 'attention' ? t.hasError || t.unread : status === 'worker' ? !!t.parentId :
        status === 'archived' ? !!t.archived : !t.running && t.activity !== 'unknown')) &&
    (!needle || [t.title, t.projectName, t.cwd, t.gitBranch, t.harnessName, t.agentName, t.profile].join(' ').toLowerCase().includes(needle)))
}

/** A retained identity is history until at least one grouped checkout is present. */
export function projectCategory(project) {
  const present = (project.checkouts || []).filter(c => !c.missing)
  if (present.some(c => c.kind === 'git')) return 'repository'
  if (present.some(c => c.kind === 'directory')) return 'workspace'
  return 'historical'
}

/** Share one location scope between the inventory and the colony without dropping records. */
export function projectOverview(threads, inventory, filters = {}, hiddenProjects = []) {
  const hidden = hiddenProjects instanceof Set ? hiddenProjects : new Set(hiddenProjects)
  const classified = inventory.map(p => ({ ...p, category: projectCategory(p) }))
  const included = classified.filter(p => filters.includeHistorical || p.category !== 'historical')
  const ids = new Set(included.map(p => p.id))
  const visible = filterSessions(threads.filter(t => ids.has(t.projectId || t.project)), { ...filters, checkout: '' })
  const matching = new Set(visible.map(t => t.projectId || t.project))
  const projects = included.filter(p => !hidden.has(p.id) &&
    (matching.has(p.id) || (!filters.query && !filters.harness && !filters.status)))
  const counts = { repository: 0, workspace: 0, historical: 0 }
  for (const p of projects) counts[p.category]++
  return { projects, threads: visible, counts,
    historicalCount: classified.filter(p => p.category === 'historical' && !hidden.has(p.id)).length }
}
