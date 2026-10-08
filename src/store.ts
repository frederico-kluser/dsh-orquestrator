/**
 * Per-session orchestration choices: in memory, optionally persisted to one
 * small JSON file under the DSH home (atomic tmp+rename, mode 0600). The file
 * holds no secret (only provider/model ids the user picked), but it is
 * user-private state, so it is created owner-only like the rest of `$DSH_HOME`.
 * @module dsh-orquestrator/store
 */

import { renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseConfig, type OrchestratorConfig } from './shared.ts'
import { readStateFile, writeStateFile } from './state-file.ts'

/** Persisted file schema version. */
const FILE_VERSION = 1

/** Longest parent chain a lineage lookup walks (recursion guard). */
const MAX_LINEAGE_HOPS = 8

/** One persisted session entry. */
interface Entry {
  readonly config: OrchestratorConfig
  readonly updatedAt: number
}

/** Logger slice the store needs for corruption diagnostics. */
export interface StoreLogger {
  warn(message: string): void
}

/** Construction options. */
export interface ConfigStoreOptions {
  /** State file path; absent keeps the store purely in memory. */
  readonly file?: string
  /** Most sessions kept; the least recently updated are pruned first. */
  readonly maxSessions: number
  /** Clock, injectable for deterministic tests. */
  readonly now?: () => number
  /** Diagnostics sink. */
  readonly logger?: StoreLogger
}

/**
 * Default state file under the DSH home.
 * @param stateDir - explicit directory override.
 * @returns absolute path of `sessions.json`.
 */
export function defaultStateFile(stateDir?: string): string {
  const dir = stateDir ?? join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'dsh-orquestrator')
  return join(dir, 'sessions.json')
}

/** The store of per-session orchestration choices. */
export class ConfigStore {
  private readonly entries = new Map<string, Entry>()
  private readonly file: string | undefined
  private readonly maxSessions: number
  private readonly now: () => number
  private readonly logger: StoreLogger | undefined

  /**
   * @param options - persistence target, capacity, clock and logger.
   */
  constructor(options: ConfigStoreOptions) {
    this.file = options.file
    this.maxSessions = options.maxSessions
    this.now = options.now ?? Date.now
    this.logger = options.logger
    this.load()
  }

  /**
   * Read one session's stored choice.
   * @param sessionId - session identity.
   * @returns the stored configuration, or undefined when none.
   */
  get(sessionId: string): OrchestratorConfig | undefined {
    return this.entries.get(sessionId)?.config
  }

  /**
   * Store (or replace) one session's choice and persist.
   * @param sessionId - session identity.
   * @param config - validated configuration.
   */
  set(sessionId: string, config: OrchestratorConfig): void {
    // Re-insert so Map iteration order tracks recency of update.
    this.entries.delete(sessionId)
    this.entries.set(sessionId, { config, updatedAt: this.now() })
    this.prune()
    this.save()
  }

  /**
   * Forget one session's choice and persist.
   * @param sessionId - session identity.
   * @returns whether an entry existed.
   */
  clear(sessionId: string): boolean {
    const existed = this.entries.delete(sessionId)
    if (existed) this.save()
    return existed
  }

  /** Number of stored sessions. */
  get size(): number {
    return this.entries.size
  }

  /**
   * Resolve the configuration governing one agent: its own session's choice,
   * else the nearest ancestor's (a subagent delegating further inherits the
   * user's choice for the whole task tree), else the deployment default.
   * @param sessionId - the calling agent's session id.
   * @param parentOf - resolver of a session's direct parent id.
   * @param fallback - deployment default (headless), or null for stock behavior.
   * @returns the governing configuration, or null when none applies.
   */
  resolve(
    sessionId: string,
    parentOf: (id: string) => string | undefined,
    fallback: OrchestratorConfig | null,
  ): OrchestratorConfig | null {
    let current: string | undefined = sessionId
    for (let hop = 0; current !== undefined && hop <= MAX_LINEAGE_HOPS; hop += 1) {
      const found = this.get(current)
      if (found !== undefined) return found
      current = parentOf(current)
    }
    return fallback
  }

  /** Drop the least recently updated entries beyond capacity. */
  private prune(): void {
    while (this.entries.size > this.maxSessions) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) return
      this.entries.delete(oldest.value)
    }
  }

  /**
   * Load the state file. A missing file is empty; a corrupt one is set aside; one that must not be read (a link, a
   * pipe, a directory, anything over the size bound) is only reported, and the next write replaces it.
   */
  private load(): void {
    if (this.file === undefined) return
    const read = readStateFile(this.file)
    if (read.kind === 'missing') return
    if (read.kind !== 'text') {
      this.logger?.warn(`dsh-orquestrator: cannot read ${this.file}: ${read.kind === 'refused' ? read.reason : String(read.error)}`)
      return
    }
    try {
      const parsed: unknown = JSON.parse(read.text)
      if (typeof parsed !== 'object' || parsed === null || (parsed as { version?: unknown }).version !== FILE_VERSION) {
        throw new Error('unsupported state file version')
      }
      const sessions = (parsed as { sessions?: unknown }).sessions
      if (typeof sessions !== 'object' || sessions === null || Array.isArray(sessions)) throw new Error('missing sessions map')
      const loaded: [string, Entry][] = []
      for (const [id, value] of Object.entries(sessions)) {
        const config = parseConfig((value as { config?: unknown } | null)?.config)
        const updatedAt = (value as { updatedAt?: unknown } | null)?.updatedAt
        if (config === undefined || typeof updatedAt !== 'number') continue
        loaded.push([id, { config, updatedAt }])
      }
      loaded.sort((a, b) => a[1].updatedAt - b[1].updatedAt)
      // Only the newest `maxSessions` go in: a huge file loads in bounded time (pruning one by one is quadratic).
      for (const [id, entry] of loaded.slice(Math.max(0, loaded.length - this.maxSessions))) this.entries.set(id, entry)
    } catch (error: unknown) {
      const aside = `${this.file}.corrupt-${String(this.now())}`
      try {
        renameSync(this.file, aside)
        this.logger?.warn(`dsh-orquestrator: state file was unreadable (${String(error)}); moved to ${aside}`)
      } catch (renameError: unknown) {
        this.logger?.warn(`dsh-orquestrator: state file unreadable and could not be set aside: ${String(renameError)}`)
      }
    }
  }

  /** Persist atomically (see {@link writeStateFile}), owner-only. Failures are logged, never thrown. */
  private save(): void {
    if (this.file === undefined) return
    const body = `${JSON.stringify({ version: FILE_VERSION, sessions: Object.fromEntries(this.entries) }, null, 2)}\n`
    try {
      writeStateFile(this.file, body)
    } catch (error: unknown) {
      this.logger?.warn(`dsh-orquestrator: cannot persist ${this.file}: ${String(error)}`)
    }
  }
}
