/**
 * The subagent ledger: what the host knows about the children DSH ran, kept for the browser's subagent dropdown.
 *
 * DSH records no outcome for a subagent (done or failed) and does not show which model it runs on. It does announce
 * every in-process child, one-shot and continuable alike, with `subagent/start` and `subagent/end`. A listener on the
 * root context sees every delegation, so the tracker below turns those two events into one small record per child
 * (parent session, backend, model route, state, stop reason of the latest run) and the browser reads the records
 * through `GET /dsh-orquestrator/subagents?sessionId=<id>`.
 *
 * Remote backends (`acp`, `codex`, ...) have no session of their own and are absent from the web catalog, so they are
 * not tracked. The ledger lives in memory, optionally persisted like the session store (one owner-only JSON file,
 * read and written through `state-file.ts`, which does not trust what is in the state directory), pruned
 * least-recently-updated first, and its writes are debounced: a workflow can start dozens of agents at once and must
 * cost one write, not dozens.
 *
 * Two DSH processes may share a state directory (`dsh web` next to a headless run), and each writes the whole file.
 * So before every write the ledger folds in what the file holds that this process does not know, or knows older: the
 * records another process wrote survive this process's next write. A child that is running here is never overruled by
 * the file, because it is alive here.
 * @module dsh-orquestrator/subagents
 */

import { renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  AgentOptionsLike, AgentRegistryLike, LoggerLike, SubagentRunEndInfoLike, SubagentRunInfoLike,
} from './host-services.ts'
import {
  MAX_SUBAGENTS_PER_RESPONSE, parseModelRoute, parseSubagentRecord, subagentStateOf,
  type ModelRoute, type SubagentRecord,
} from './shared.ts'
import { readStateFile, writeStateFile } from './state-file.ts'
import { defaultStateFile } from './store.ts'

/** Persisted file schema version. */
const FILE_VERSION = 1

/** Wait before a burst of updates is written, in milliseconds. */
const DEFAULT_SAVE_DELAY_MS = 250

/** Deepest descendant level `descendantsOf` reports; a bound on top of the visited set. */
const MAX_DESCENDANT_DEPTH = 16

/** Stop reason a persisted `running` record gets when it is loaded: the process that was running the child is gone. */
const INTERRUPTED = 'interrupted'

/** The same warning is not logged again within this many milliseconds (a failing disk would otherwise log on every write). */
const WARN_INTERVAL_MS = 60_000

/** Most distinct warnings remembered for that limit. */
const MAX_REMEMBERED_WARNINGS = 16

/** Most records the ledger keeps unless told otherwise; the least recently updated are pruned first. */
export const DEFAULT_MAX_SUBAGENTS = 2000

/**
 * Default ledger file, next to the session store's `sessions.json`.
 * @param stateDir - explicit directory override (the same one the session store takes).
 * @returns absolute path of `subagents.json`.
 */
export function defaultLedgerFile(stateDir?: string): string {
  return join(dirname(defaultStateFile(stateDir)), 'subagents.json')
}

/** Construction options. */
export interface SubagentLedgerOptions {
  /** State file path; absent keeps the ledger purely in memory. */
  readonly file?: string
  /** Most records kept (default {@link DEFAULT_MAX_SUBAGENTS}); the least recently updated are pruned first. */
  readonly maxRecords?: number
  /** Clock, injectable for deterministic tests. */
  readonly now?: () => number
  /**
   * When this process started, in epoch milliseconds (default: now minus the process uptime). A persisted child that
   * was still running and started before that belongs to a process that is gone; one that started after it was
   * written by this process (the plugin was loaded again), and is alive.
   */
  readonly bootedAt?: number
  /** Diagnostics sink. */
  readonly logger?: { warn(message: string): void }
  /** Wait before pending updates are written, in milliseconds (default 250); 0 writes on the next turn of the event loop. */
  readonly saveDelayMs?: number
}

/** A copy a caller may keep or change without touching the ledger. */
function copyRecord(record: SubagentRecord): SubagentRecord {
  return { ...record, route: record.route === null ? null : { ...record.route } }
}

/** When a record last changed: its end, else its start. This is what recency means. */
function changedAt(record: SubagentRecord): number {
  return record.endedAt ?? record.startedAt
}

/** Least recently changed first. */
function byChange(a: SubagentRecord, b: SubagentRecord): number {
  return changedAt(a) - changedAt(b)
}

/** Oldest start first; children that started in the same millisecond order by id. */
function byStart(a: SubagentRecord, b: SubagentRecord): number {
  if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

/**
 * Whether what the file says about a child replaces what this process has. A child running here is alive here, so the
 * file never overrules it; otherwise the later change wins, and a tie keeps this process's record.
 */
function supersedes(theirs: SubagentRecord, mine: SubagentRecord): boolean {
  if (mine.state === 'running') return false
  return changedAt(theirs) > changedAt(mine)
}

/**
 * The ledger of the subagents the host saw start: one record per child session id, kept in recency order (every
 * start and finish moves its record to the newest end, like the session store) so the pruned ones are always the
 * ones nothing touched for longest.
 */
export class SubagentLedger {
  private readonly records = new Map<string, SubagentRecord>()
  /** The run (`runId`) each child that was started with one is in. In memory only: a run is a fact of this process. */
  private readonly runs = new Map<string, string>()
  private readonly file: string | undefined
  private readonly maxRecords: number
  private readonly now: () => number
  private readonly bootedAt: number
  private readonly logger: { warn(message: string): void } | undefined
  private readonly saveDelayMs: number
  /** Warnings logged lately, by text, with the time they were: the same one is not repeated within the interval. */
  private readonly warned = new Map<string, number>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private dirty = false

  /**
   * Load the persisted records when a file is given. A missing file starts empty. A file that is corrupt or of an
   * unsupported version is set aside as `<file>.corrupt-<now>` with a warning, and the ledger starts empty. A file that
   * cannot be read, is not a regular file (a link, a pipe, a directory) or is larger than 16 MiB is only reported, and
   * the first write replaces it. Records that were still running and started before this process did belong to a
   * process that is gone: each becomes `stopped` with the stop reason `interrupted`, ended now.
   * @param options - persistence target, capacity, clock, process start, logger and write delay. An unusable capacity,
   *   process start or delay falls back to its default.
   */
  constructor(options: SubagentLedgerOptions = {}) {
    this.file = options.file
    const capacity = options.maxRecords
    this.maxRecords = capacity !== undefined && Number.isInteger(capacity) && capacity >= 1 ? capacity : DEFAULT_MAX_SUBAGENTS
    this.now = options.now ?? Date.now
    const booted = options.bootedAt
    this.bootedAt = booted !== undefined && Number.isFinite(booted) ? booted : Date.now() - process.uptime() * 1000
    this.logger = options.logger
    const delay = options.saveDelayMs
    this.saveDelayMs = delay !== undefined && Number.isFinite(delay) && delay >= 0 ? delay : DEFAULT_SAVE_DELAY_MS
    this.load()
  }

  /**
   * Record that a child started. A child that is already known (a continuable child that is resumed starts again)
   * goes back to `running`: its start time is now, its end and stop reason are cleared, and the backend, parent and
   * route this start gives replace the old ones. A parent or route this start does not know keeps the one known.
   * @param info - the child's session id, the session that started it, the backend that runs it, its model route and,
   *   when the event carries one, the id of this run: an end that names another run is not this run's end.
   */
  start(info: {
    readonly id: string
    readonly parentId: string | null
    readonly backend: string
    readonly route: ModelRoute | null
    readonly runId?: string
  }): void {
    const known = this.records.get(info.id)
    if (info.runId === undefined) this.runs.delete(info.id)
    else this.runs.set(info.id, info.runId)
    this.put({
      id: info.id,
      parentId: info.parentId ?? known?.parentId ?? null,
      backend: info.backend,
      route: parseModelRoute(info.route) ?? known?.route ?? null,
      state: 'running',
      stopReason: null,
      startedAt: this.now(),
      endedAt: null,
    })
  }

  /**
   * Record that a child's run ended. The state follows the stop reason (`completed` is done, `aborted` is stopped,
   * every other reason is a failure). The parent and backend stay; the route is replaced only when the outcome names
   * one. A child the ledger never saw start is ignored: the plugin may have loaded mid-run, and a record without a
   * parent could never be found again. So is the end of a run that is not the child's current one: a continuable child
   * that was resumed has started again, and the end of its earlier run must not close the new one.
   * @param id - the child's session id.
   * @param outcome - the terminal stop reason, the route the child last requested when it is known, and the id of the
   *   run that ended when the event carries one.
   */
  finish(id: string, outcome: { readonly stopReason: string; readonly route?: ModelRoute | null; readonly runId?: string }): void {
    const known = this.records.get(id)
    if (known === undefined) return
    const current = this.runs.get(id)
    if (outcome.runId !== undefined && current !== undefined && outcome.runId !== current) return
    this.put({
      ...known,
      route: parseModelRoute(outcome.route) ?? known.route,
      state: subagentStateOf(outcome.stopReason),
      stopReason: outcome.stopReason,
      endedAt: this.now(),
    })
  }

  /**
   * Read one record.
   * @param id - the child's session id.
   * @returns a copy of the record, or undefined when none.
   */
  get(id: string): SubagentRecord | undefined {
    const record = this.records.get(id)
    return record === undefined ? undefined : copyRecord(record)
  }

  /** Number of records kept. */
  get size(): number {
    return this.records.size
  }

  /**
   * The subagents started under one session, direct and deeper, up to {@link MAX_DESCENDANT_DEPTH} levels, never the
   * session itself. A parent chain that loops back on itself, or a record that is its own parent, ends the walk
   * instead of repeating. The order is that of the LATEST start of each child: a continuable child that is resumed
   * starts again, so it moves to the end, and the cap keeps the children that were active most recently.
   * @param rootId - the session whose subagents are wanted.
   * @returns copies of the records, oldest start first (equal starts by id); when more than
   *   {@link MAX_SUBAGENTS_PER_RESPONSE} qualify, the newest ones, still oldest first.
   */
  descendantsOf(rootId: string): SubagentRecord[] {
    const childrenOf = new Map<string, SubagentRecord[]>()
    for (const record of this.records.values()) {
      if (record.parentId === null) continue
      const siblings = childrenOf.get(record.parentId)
      if (siblings === undefined) childrenOf.set(record.parentId, [record])
      else siblings.push(record)
    }
    const visited = new Set<string>([rootId])
    const found: SubagentRecord[] = []
    let level: readonly string[] = [rootId]
    for (let depth = 0; depth < MAX_DESCENDANT_DEPTH && level.length > 0; depth += 1) {
      const next: string[] = []
      for (const parentId of level) {
        for (const child of childrenOf.get(parentId) ?? []) {
          if (visited.has(child.id)) continue
          visited.add(child.id)
          found.push(child)
          next.push(child.id)
        }
      }
      level = next
    }
    found.sort(byStart)
    const newest = found.length > MAX_SUBAGENTS_PER_RESPONSE ? found.slice(found.length - MAX_SUBAGENTS_PER_RESPONSE) : found
    return newest.map(copyRecord)
  }

  /**
   * Write now what a pending delayed write would have written. Does nothing when no file is set or nothing changed
   * since the last write that succeeded: a write that failed is tried again here.
   */
  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.file === undefined || !this.dirty) return
    this.save()
  }

  /** Store one record as the most recently updated, prune and schedule the write. */
  private put(record: SubagentRecord): void {
    // Re-insert so Map iteration order tracks recency of update.
    this.records.delete(record.id)
    this.records.set(record.id, record)
    this.prune()
    this.schedule()
  }

  /** Drop the least recently updated records beyond capacity. */
  private prune(): void {
    while (this.records.size > this.maxRecords) {
      const oldest = this.records.keys().next()
      if (oldest.done === true) return
      this.records.delete(oldest.value)
      this.runs.delete(oldest.value)
    }
  }

  /** Log a warning, unless the same one was logged within the last minute. */
  private warn(message: string): void {
    const at = this.now()
    const last = this.warned.get(message)
    if (last !== undefined && at - last < WARN_INTERVAL_MS) return
    if (this.warned.size >= MAX_REMEMBERED_WARNINGS) this.warned.clear()
    this.warned.set(message, at)
    this.logger?.warn(message)
  }

  /** Mark the ledger changed and make sure one write is pending; a burst of updates shares it. */
  private schedule(): void {
    if (this.file === undefined) return
    this.dirty = true
    if (this.timer !== undefined) return
    const timer = setTimeout(() => {
      this.timer = undefined
      if (this.dirty) this.save()
    }, this.saveDelayMs)
    // A pending write must never keep the host process alive. Not every timer has `unref` (a fake clock's may not).
    const handle = timer as { unref?: () => unknown }
    if (typeof handle.unref === 'function') handle.unref()
    this.timer = timer
  }

  /**
   * What the state file holds right now: its records, valid ones only, least recently changed first, at most
   * `maxRecords` of them (the newest), so that a huge file costs one sort and not a pruning loop that is quadratic.
   * @returns undefined when there is nothing to use: no file, a file that was refused or could not be read (a warning
   *   says so), or a corrupt one (set aside, with a warning).
   */
  private readRecords(): SubagentRecord[] | undefined {
    if (this.file === undefined) return undefined
    const read = readStateFile(this.file)
    if (read.kind === 'missing') return undefined
    if (read.kind !== 'text') {
      this.warn(`dsh-orquestrator: cannot read ${this.file}: ${read.kind === 'refused' ? read.reason : String(read.error)}`)
      return undefined
    }
    try {
      const parsed: unknown = JSON.parse(read.text)
      if (typeof parsed !== 'object' || parsed === null || (parsed as { version?: unknown }).version !== FILE_VERSION) {
        throw new Error('unsupported subagent ledger version')
      }
      const subagents = (parsed as { subagents?: unknown }).subagents
      if (typeof subagents !== 'object' || subagents === null || Array.isArray(subagents)) throw new Error('missing subagents map')
      const records: SubagentRecord[] = []
      for (const [id, value] of Object.entries(subagents)) {
        const record = parseSubagentRecord(value)
        if (record === undefined || record.id !== id) continue
        records.push(record)
      }
      // Recency is not stored: rebuild it from the last time each record changed.
      records.sort(byChange)
      return records.slice(Math.max(0, records.length - this.maxRecords))
    } catch (error: unknown) {
      const aside = `${this.file}.corrupt-${String(this.now())}`
      try {
        renameSync(this.file, aside)
        this.warn(`dsh-orquestrator: subagent ledger state file was unreadable (${String(error)}); moved to ${aside}`)
      } catch (renameError: unknown) {
        this.warn(`dsh-orquestrator: subagent ledger state file unreadable and could not be set aside: ${String(renameError)}`)
      }
      return undefined
    }
  }

  /** Load the state file. A child that was running when its process went away is marked interrupted. */
  private load(): void {
    const records = this.readRecords()
    if (records === undefined) return
    const at = this.now()
    for (const record of records) {
      // A child still running in the file was running in a process that is gone, unless this process wrote it (the plugin
      // was loaded again in the same process: a reload, a restart of its fiber), which is when it started after this
      // process did. A start in the future (a clock that went back) cannot be a live child's either.
      const orphan = record.state === 'running' && (record.startedAt < this.bootedAt || record.startedAt > at)
      this.records.set(record.id, orphan ? { ...record, state: 'stopped', stopReason: INTERRUPTED, endedAt: at } : record)
    }
  }

  /**
   * Fold in what the file holds that another process wrote since this one last did: a child this process does not
   * know, or knows older. Without it, two processes on one state directory would each write their own view and drop the
   * other's records. The file is read with the same bounds as at load, and the result is pruned to capacity.
   */
  private mergeFromFile(): void {
    const theirs = this.readRecords()
    if (theirs === undefined) return
    let adopted = false
    for (const record of theirs) {
      const mine = this.records.get(record.id)
      if (mine !== undefined && !supersedes(record, mine)) continue
      this.records.set(record.id, record)
      adopted = true
    }
    if (!adopted) return
    // Recency again, now that records from elsewhere are in, and then the capacity.
    const ordered = [...this.records.values()].sort(byChange)
    this.records.clear()
    for (const record of ordered) this.records.set(record.id, record)
    this.prune()
  }

  /**
   * Write the ledger, after folding in the file. Failures are logged (once a minute at most), never thrown: this runs
   * from a timer. The ledger stays dirty after a failure, so the next change or a flush tries again.
   */
  private save(): void {
    if (this.file === undefined) return
    try {
      this.mergeFromFile()
    } catch (error: unknown) {
      this.warn(`dsh-orquestrator: could not merge ${this.file} into the subagent ledger: ${String(error)}`)
    }
    try {
      writeStateFile(this.file, `${JSON.stringify({ version: FILE_VERSION, subagents: Object.fromEntries(this.records) }, null, 2)}\n`)
      this.dirty = false
      this.warned.clear()
    } catch (error: unknown) {
      this.warn(`dsh-orquestrator: cannot persist ${this.file}: ${String(error)}`)
    }
  }
}

/** What the tracker reads from the host and the plugin. */
export interface TrackerDeps {
  /** The context the lifecycle listeners register on; a root context sees every delegation. `on` returns the listener's remover. */
  readonly ctx: { on(event: string, handler: (info: never) => void): () => void }
  /** The live agent registry (`ctx.agents`), resolved per event: it may appear after the plugin loads. */
  readonly agents: () => AgentRegistryLike | undefined
  /** Where the records go. */
  readonly ledger: SubagentLedger
  /** Diagnostics sink. */
  readonly logger: Pick<LoggerLike, 'warn'>
}

/** The route in an agent's options or logged request config, when it names both a provider and a model. */
function routeOf(config: AgentOptionsLike | undefined): ModelRoute | null {
  const provider = config?.provider
  const model = config?.model
  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return null
  const effort = config?.reasoningEffort
  return typeof effort === 'string' && effort !== '' ? { provider, model, reasoningEffort: effort } : { provider, model }
}

/** A thrown value as one line of text, without letting its own coercion escape. */
function describeError(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return 'unreadable error'
  }
}

/**
 * Feed the ledger from DSH's `subagent/start` and `subagent/end` events. Only in-process children (`local`) are
 * tracked: a remote backend's child has no session of its own and is absent from the web catalog. At start the
 * child's parent session and model route are read from the live agent (a child the registry does not know is still
 * recorded, with neither); at end the state follows the stop reason and, when the agent is still registered, the
 * route it actually requested last replaces the one it was created with. A handler never throws: trouble is logged.
 *
 * Each event carries the `runId` that pairs a start with its end, and the ledger is told, so that the end of an
 * earlier run of a resumed child never closes the run that is going on.
 *
 * What the end can know depends on the kind of child. A one-shot child is still registered when its end is emitted, so
 * the route it last requested is read then. A continuable child (the default of the standard preset's `subagent` tools)
 * is released before its end is emitted, so the agent is gone and its record keeps the route read at the start of the run.
 * @param deps - event source, agent registry, ledger and logger.
 * @returns one disposer that removes both listeners and writes any pending change.
 */
export function installSubagentTracker(deps: TrackerDeps): () => void {
  const { ctx, ledger } = deps
  const contained = (body: () => void): void => {
    try {
      body()
    } catch (error: unknown) {
      deps.logger.warn(`dsh-orquestrator: subagent tracker: ${describeError(error)}`)
    }
  }

  const offStart = ctx.on('subagent/start', (info: SubagentRunInfoLike) => {
    contained(() => {
      if (info.local !== true) return
      const agent = deps.agents()?.get(info.id)
      ledger.start({
        id: info.id,
        parentId: agent?.session.header.parentSession ?? null,
        backend: info.provider,
        route: routeOf(agent?.options),
        runId: info.runId,
      })
    })
  })
  let offEnd: () => void
  try {
    offEnd = ctx.on('subagent/end', (info: SubagentRunEndInfoLike) => {
      contained(() => {
        if (info.local !== true) return
        const agent = deps.agents()?.get(info.id)
        // The request header owns the live route once a request ran; the creation options may be a different route.
        // No agent, no logged request or no usable route in it: say nothing, and the route recorded at start stays.
        const route = routeOf(agent?.session.requestHeader?.()?.config)
        ledger.finish(info.id, { stopReason: info.stopReason, runId: info.runId, ...route === null ? {} : { route } })
      })
    })
  } catch (error: unknown) {
    // No half-installed tracker: a start listener without its end would leave every child running forever.
    offStart()
    throw error
  }

  return () => {
    try {
      offStart()
    } finally {
      try {
        offEnd()
      } finally {
        ledger.flush()
      }
    }
  }
}
