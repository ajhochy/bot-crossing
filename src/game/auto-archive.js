export const AUTO_ARCHIVE_AFTER_MS = 48 * 60 * 60 * 1000

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const sourceArchived = thread => thread?.harnessArchived ?? thread?.archived === true

export function autoArchiveInactiveThreads(state, threads, { now, maxAgeMs = AUTO_ARCHIVE_AFTER_MS } = {}) {
  const archived = new Set(Array.isArray(state?.archived) ? state.archived : [])
  const grace = object(state?.unarchivedAt)
  const additions = []
  for (const thread of threads || []) {
    if (!thread?.id || archived.has(thread.id) || sourceArchived(thread) || thread.running !== false ||
      thread.activity === 'unknown' || thread.stale === true || thread.staleMetadata === true) continue
    const activityAt = Number(thread.lastActivityAt)
    if (!Number.isFinite(activityAt) || activityAt <= 0 || activityAt > now) continue
    const unarchivedAt = Number(grace[thread.id])
    const effectiveAt = Number.isFinite(unarchivedAt) && unarchivedAt > 0 ? Math.max(activityAt, unarchivedAt) : activityAt
    if (effectiveAt < now - maxAgeMs) additions.push(thread.id)
  }
  if (!additions.length) return state
  const archivedAt = { ...object(state?.archivedAt) }
  for (const id of additions) archivedAt[id] = now
  return { ...state, archived: [...archived, ...additions], archivedAt }
}

export function autoArchiveBatch(state, threads, options) {
  const next = autoArchiveInactiveThreads(state, threads, options)
  if (next === state) return { state, notice: null }
  const count = next.archived.length - (state.archived?.length || 0)
  return {
    state: next,
    notice: `Archived ${count} ${count === 1 ? 'task' : 'tasks'} inactive for over 48 hours. Choose Archived to review or restore.`,
  }
}

export function restoreColonyThread(state, thread, { now } = {}) {
  if (!thread?.id || sourceArchived(thread) || !state?.archived?.includes(thread.id)) return state
  const archivedAt = { ...object(state.archivedAt) }
  delete archivedAt[thread.id]
  return {
    ...state,
    archived: state.archived.filter(id => id !== thread.id),
    archivedAt,
    unarchivedAt: { ...object(state.unarchivedAt), [thread.id]: now },
  }
}

export function archiveColonyThread(state, thread, { now } = {}) {
  if (!thread?.id || sourceArchived(thread) || state?.archived?.includes(thread.id)) return state
  const unarchivedAt = { ...object(state?.unarchivedAt) }
  delete unarchivedAt[thread.id]
  return {
    ...state,
    archived: [...new Set([...(state?.archived || []), thread.id])],
    archivedAt: { ...object(state?.archivedAt), [thread.id]: now },
    unarchivedAt,
  }
}

export function rankColonyRoster(threads, limit) {
  return [...threads].sort((a, b) => Number(b.running === true) - Number(a.running === true) ||
    Number(a.stale === true || a.staleMetadata === true || a.activity === 'unknown') - Number(b.stale === true || b.staleMetadata === true || b.activity === 'unknown') ||
    Number(Boolean(b.hasError)) - Number(Boolean(a.hasError)) ||
    (Number(b.lastActivityAt) || 0) - (Number(a.lastActivityAt) || 0) || String(a.id).localeCompare(String(b.id)))
    .slice(0, Math.max(0, limit))
}
