/** Git evidence, not names or remotes, identifies a repository and its checkouts. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const hash = (kind, value) => `${kind}:${createHash('sha256').update(value).digest('hex').slice(0, 20)}`
const stat = (p) => fs.stat(p).catch(() => null)
const real = (p) => fs.realpath(p).catch(() => path.resolve(p))
const read = (p) => fs.readFile(p, 'utf8').catch(() => '')
const validPath = (p) => typeof p === 'string' && path.isAbsolute(p)

async function mapLimit(list, work, limit = 8) {
  let index = 0
  const out = []
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
    for (;;) {
      const i = index++
      if (i >= list.length) break
      out[i] = await work(list[i], i)
    }
  }))
  return out
}

export function createProjectResolver({
  dataDir,
  ttlMs = 120000,
  statusTtlMs = 30000,
  statusLimit = 12,
  gitConcurrency = 4,
} = {}) {
  const paths = new Map()
  const repos = new Map()
  const statuses = new Map()
  const knownCheckouts = new Map()
  let hints = null
  let saved = ''
  let queue = Promise.resolve()
  let activeGit = 0
  const gitWaiters = []
  const metrics = { gitCommands: 0, statusCommands: 0, cacheHits: 0, maxConcurrentGit: 0 }
  const file = dataDir && path.join(dataDir, 'identities.json')

  const emptyHints = () => {
    hints = {}
    saved = JSON.stringify(hints)
  }

  const cacheError = (problem, cause) => new Error(
    `Project identity cache ${problem}. Repair or move data/identities.json and reload; the file was left unchanged.`,
    cause ? { cause } : undefined,
  )

  async function withGitSlot(work) {
    if (activeGit >= gitConcurrency) await new Promise(resolve => gitWaiters.push(resolve))
    else activeGit++
    metrics.maxConcurrentGit = Math.max(metrics.maxConcurrentGit, activeGit)
    try { return await work() } finally {
      const next = gitWaiters.shift()
      if (next) next()
      else activeGit--
    }
  }

  const git = async (cwd, args) => withGitSlot(async () => {
    metrics.gitCommands++
    if (args[0] === 'status') metrics.statusCommands++
    // Optional locks disabled: even status may otherwise refresh another process's index.
    const { stdout } = await exec('git', ['--no-optional-locks', '-C', cwd, ...args], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    })
    return stdout
  })

  const rememberCheckout = (checkout) => {
    if (!checkout?.id) return checkout
    const value = { ...checkout, dirty: null }
    knownCheckouts.set(value.id, value)
    return value
  }

  async function loadHints() {
    if (hints !== null) return
    if (!file) {
      emptyHints()
      return
    }
    let raw
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch (err) {
      if (err?.code === 'ENOENT') {
        emptyHints()
        return
      }
      throw cacheError(`could not be read${err?.code ? ` (${err.code})` : ''}`, err)
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw cacheError('contains invalid JSON', err)
    }
    const record = (value) => value && typeof value === 'object' && !Array.isArray(value)
    if (!record(parsed) || parsed.version !== 1 || !record(parsed.paths) ||
        Object.values(parsed.paths).some(value => !record(value) || typeof value.id !== 'string' ||
          !value.id || typeof value.path !== 'string')) {
      throw cacheError('uses an unsupported schema (expected version 1 with a paths object)')
    }
    hints = parsed.paths
    for (const value of Object.values(hints)) rememberCheckout(value)
    saved = JSON.stringify(hints)
  }

  async function remember() {
    if (!file || JSON.stringify(hints) === saved) return
    await fs.mkdir(dataDir, { recursive: true })
    const next = JSON.stringify(hints)
    const tmp = `${file}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify({ version: 1, paths: hints }))
    await fs.rename(tmp, file)
    saved = next
  }

  const missingCheckout = (prior, input, evidence = 'Recorded path is missing; no current ownership evidence') =>
    rememberCheckout({
      ...prior,
      id: prior?.id || hash('checkout', input),
      repositoryId: prior?.repositoryId || '',
      path: prior?.path || input,
      recordedPath: input,
      kind: prior?.kind || 'missing',
      missing: true,
      dirty: null,
      branch: prior?.branch || '',
      evidence,
    })

  async function validGitDir(dir) {
    if (!(await stat(dir))?.isDirectory() || !(await stat(path.join(dir, 'HEAD')))?.isFile()) return false
    if ((await stat(path.join(dir, 'objects')))?.isDirectory()) return true
    return Boolean((await read(path.join(dir, 'commondir'))).trim())
  }

  async function locate(input, unknownKey = input) {
    if (!validPath(input)) return rememberCheckout({
      id: hash('checkout', `unknown:${unknownKey}`), repositoryId: '', path: input || '',
      kind: 'unknown', missing: true, dirty: null, branch: '', evidence: 'No absolute working directory recorded',
    })

    // Presence is deliberately not covered by the metadata TTL. A cached identity may be kept,
    // but a checkout deleted between two polls must immediately stop looking openable or clean.
    const exists = await stat(input)
    const cached = paths.get(input)
    if (!exists?.isDirectory()) return missingCheckout(cached?.value || hints[input], input)
    const canonical = await real(input)
    if (cached && cached.canonical === canonical && Date.now() - cached.at < ttlMs) {
      metrics.cacheHits++
      return cached.value
    }

    let root = canonical
    let gitDir = ''
    let malformedGit = false
    while (true) {
      const dot = path.join(root, '.git')
      const s = await stat(dot)
      if (s?.isDirectory()) {
        const target = await real(dot)
        if (!(await validGitDir(target))) malformedGit = true
        else gitDir = target
        break
      }
      if (s?.isFile()) {
        const match = (await read(dot)).match(/^gitdir:\s*(.+)\s*$/m)
        if (!match) {
          malformedGit = true
          break
        }
        const target = path.resolve(root, match[1].trim())
        if (!(await validGitDir(target))) {
          malformedGit = true
          break
        }
        gitDir = await real(target)
        break
      }
      const parent = path.dirname(root)
      if (parent === root) {
        root = canonical
        break
      }
      root = parent
    }

    let value
    if (gitDir) {
      const commonRel = (await read(path.join(gitDir, 'commondir'))).trim()
      const commonTarget = commonRel ? path.resolve(gitDir, commonRel) : gitDir
      if (!(await validGitDir(commonTarget))) {
        value = { id: hash('checkout', root), repositoryId: '', path: root, kind: 'unknown',
          missing: false, dirty: null, branch: '', evidence: 'Malformed Git metadata; repository relationship unknown' }
      } else {
        const commonDir = await real(commonTarget)
        const repositoryId = hash('repo', commonDir)
        value = { id: hash('checkout', root), repositoryId, path: root, commonDir, gitDir,
          kind: 'git', missing: false, dirty: null, branch: '', evidence: 'Canonical Git common directory; status not inspected' }
      }
    } else if (malformedGit) {
      value = { id: hash('checkout', root), repositoryId: '', path: root, kind: 'unknown',
        missing: false, dirty: null, branch: '', evidence: 'Malformed Git metadata; repository relationship unknown' }
    } else {
      value = { id: hash('checkout', root), repositoryId: '', path: root, kind: 'directory',
        missing: false, dirty: null, branch: '', evidence: 'Existing non-Git directory; no repository relationship inferred' }
    }
    value = rememberCheckout(value)
    hints[input] = value
    hints[canonical] = value
    paths.set(input, { at: Date.now(), canonical, value })
    return value
  }

  async function refreshPresence(checkout) {
    if (!validPath(checkout.path) || !(await stat(checkout.path))?.isDirectory()) {
      return missingCheckout(checkout, checkout.path, checkout.repositoryId
        ? 'Registered checkout path is missing; no current status evidence'
        : 'Recorded path is missing; no current ownership evidence')
    }
    return rememberCheckout({ ...checkout, missing: false, dirty: null })
  }

  async function inventory(checkout) {
    const key = checkout.repositoryId
    if (!key) return [checkout]
    const cached = repos.get(key)
    if (cached && Date.now() - cached.at < ttlMs) {
      metrics.cacheHits++
      return mapLimit(cached.value, refreshPresence)
    }
    let records = []
    try {
      const raw = await git(checkout.path, ['worktree', 'list', '--porcelain', '-z'])
      let current
      for (const field of raw.split('\0')) {
        if (field.startsWith('worktree ')) {
          current = { path: field.slice(9), branch: '', kind: 'git' }
          records.push(current)
        } else if (current && field.startsWith('branch ')) current.branch = field.slice(7).replace(/^refs\/heads\//, '')
        else if (current && field === 'detached') current.branch = '(detached)'
        else if (current && field.startsWith('locked')) current.locked = true
        else if (current && field.startsWith('prunable')) current.prunable = true
      }
    } catch (err) {
      records = [{ ...checkout, evidence: `Git inventory unavailable (${err.code || 'error'}); status not inspected` }]
    }
    const value = await mapLimit(records, async (record, index) => {
      const canonical = await real(record.path)
      const exists = (await stat(canonical))?.isDirectory()
      const entry = rememberCheckout({ ...record, path: canonical, id: hash('checkout', canonical), repositoryId: key,
        commonDir: checkout.commonDir, main: index === 0, missing: !exists, dirty: null,
        evidence: record.evidence || (exists
          ? 'Git worktree registration; status not inspected'
          : 'Git worktree registration; path is missing; no current status evidence') })
      hints[record.path] = entry
      hints[canonical] = entry
      return entry
    })
    repos.set(key, { at: Date.now(), value })
    return value
  }

  const cachedStatus = (checkout) => {
    const cached = statuses.get(checkout.id)
    return cached && cached.path === checkout.path && Date.now() - cached.at < statusTtlMs ? cached : null
  }

  async function inspectStatus(checkout) {
    const present = await refreshPresence(checkout)
    if (present.missing || present.kind !== 'git') return present
    const cached = cachedStatus(present)
    if (cached) {
      metrics.cacheHits++
      return { ...present, dirty: cached.dirty, evidence: cached.evidence }
    }
    let result
    try {
      const dirty = (await git(present.path, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'])).length > 0
      result = { dirty, evidence: 'Git worktree registration; read-only status' }
    } catch (err) {
      if (!(await stat(present.path))?.isDirectory()) {
        return missingCheckout(present, present.path, 'Registered checkout path is missing; no current status evidence')
      }
      result = { dirty: null, evidence: `Status unavailable (${err.code || 'error'})` }
    }
    statuses.set(present.id, { ...result, path: present.path, at: Date.now() })
    return { ...present, ...result }
  }

  async function inspect(checkoutId) {
    await loadHints()
    let checkout = knownCheckouts.get(checkoutId)
    if (!checkout) checkout = Object.values(hints).find(value => value?.id === checkoutId)
    return checkout ? inspectStatus(checkout) : null
  }

  async function resolve(threads) {
    await loadHints()
    const start = performance.now()
    metrics.gitCommands = metrics.statusCommands = metrics.cacheHits = metrics.maxConcurrentGit = 0
    const cwdOf = (t) => t.cwd || t.projectPath || ''
    const descriptors = threads.map((thread, index) => {
      const input = cwdOf(thread)
      return { input, key: validPath(input) ? `path:${input}` : `unknown:${thread.id || index}` }
    })
    const unique = new Map(descriptors.map(({ key, input }) => [key, input]))
    const located = new Map(await mapLimit([...unique], async ([key, input]) => [key, await locate(input, key)]))
    const repositoryRoots = new Map()
    for (const c of located.values()) {
      if (c.repositoryId && (!repositoryRoots.has(c.repositoryId) || !c.missing)) repositoryRoots.set(c.repositoryId, c)
    }
    const inventories = new Map(await mapLimit([...repositoryRoots], async ([id, c]) => [id, await inventory(c)], 4))
    const checkouts = new Map()
    for (const list of inventories.values()) for (const c of list) checkouts.set(c.id, c)
    for (const c of located.values()) if (!checkouts.has(c.id)) checkouts.set(c.id, c)

    // Status is the expensive part. Prefer every currently active checkout, then fill the
    // remaining budget by session recency. The inventory remains complete and honest: checkout
    // entries outside the budget say that status was not inspected instead of posing as clean.
    const ranked = []
    const rankedIds = new Set()
    const add = (i) => {
      const id = located.get(descriptors[i].key)?.id
      const checkout = checkouts.get(id)
      if (!checkout || checkout.kind !== 'git' || checkout.missing || rankedIds.has(id)) return
      rankedIds.add(id)
      ranked.push(checkout)
    }
    const order = threads.map((thread, index) => ({ thread, index }))
      .sort((a, b) => (b.thread.lastActivityAt || 0) - (a.thread.lastActivityAt || 0))
    for (const { thread, index } of order) if (thread.running === true) add(index)
    for (const { index } of order) add(index)
    const inspected = new Map((await mapLimit(ranked.slice(0, statusLimit), async checkout => {
      const value = await inspectStatus(checkout)
      return [value.id, value]
    }, gitConcurrency)))
    for (const [id, checkout] of checkouts) {
      const status = inspected.get(id) || cachedStatus(checkout)
      if (status) checkouts.set(id, status.dirty === undefined ? { ...checkout, ...status } : {
        ...checkout, dirty: status.dirty, evidence: status.evidence,
      })
      else if (!checkout.missing && checkout.kind === 'git') checkouts.set(id, {
        ...checkout, dirty: null, evidence: 'Git worktree registration; status not inspected',
      })
    }

    const projects = new Map()
    const normalized = threads.map((t, index) => {
      const recorded = located.get(descriptors[index].key)
      const c = { ...checkouts.get(recorded.id), ...recorded,
        ...(!recorded.missing ? checkouts.get(recorded.id) : {}) }
      const projectId = c.repositoryId ? hash('project', c.repositoryId) : hash('project', c.id)
      const inventory = (c.repositoryId ? inventories.get(c.repositoryId) || [c] : [c])
        .map(item => checkouts.get(item.id) || item)
      if (!projects.has(projectId)) {
        const main = inventory.find(item => item.main) || c
        projects.set(projectId, { id: projectId, name: path.basename(main.path) || 'Unknown project',
          path: main.path, repositoryIds: c.repositoryId ? [c.repositoryId] : [], checkouts: [...inventory] })
      }
      const p = projects.get(projectId)
      if (!p.checkouts.some(item => item.id === c.id)) p.checkouts.push(c)
      return { ...t, legacyProject: t.project, project: projectId, projectId, defaultProjectId: projectId,
        projectName: p.name, repositoryId: c.repositoryId, checkoutId: c.id, checkout: c,
        projectPath: c.path, cwd: t.cwd || t.projectPath || '',
        gitBranch: c.branch || t.gitBranch || '', worktree: c.main ? '' : c.kind === 'git' ? path.basename(c.path) : '' }
    })
    const sessionsByCheckout = new Map()
    for (const t of normalized) {
      if (!sessionsByCheckout.has(t.checkoutId)) sessionsByCheckout.set(t.checkoutId, [])
      sessionsByCheckout.get(t.checkoutId).push(t)
    }
    for (const p of projects.values()) for (const c of p.checkouts) {
      const sessions = sessionsByCheckout.get(c.id) || []
      c.conversations = sessions.filter(t => !t.parentId).length
      c.workers = sessions.filter(t => t.parentId).length
      c.harnesses = [...new Set(sessions.map(t => t.harness))]
      c.activeAgents = sessions.filter(t => t.running === true).map(t => t.id)
      c.activity = c.activeAgents.length ? 'active' : sessions.some(t => t.activity === 'unknown' || t.running == null) ? 'unknown' : 'quiet'
      c.shared = c.activeAgents.length > 1
    }
    await remember()
    return { threads: normalized, projects: [...projects.values()], metrics: { ...metrics, durationMs: Math.round(performance.now() - start) } }
  }

  // One scan owns the metadata caches at a time; concurrent browser polls cannot race the
  // identity file. An explicit checkout inspection shares the bounded Git/status cache.
  const queuedResolve = (threads) => (queue = queue.then(() => resolve(threads), () => resolve(threads)))
  queuedResolve.inspect = inspect
  return queuedResolve
}
