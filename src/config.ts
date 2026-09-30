/**
 * Deployment configuration of the host half. Every tunable is a validated
 * `Config` field overridable from `cordis.patch.yml`; a malformed value fails
 * loud at load (never a silent permissive fallback).
 * @module dsh-orquestrator/config
 */

import { parseModelRoute, type ModelRoute, type OrchestratorConfig } from './shared.ts'

/** One delegation tool whose calls the plugin may orchestrate. */
export interface DelegationTool {
  /** Model-facing tool name (`subagent`, `subagent_fork`, ...). */
  readonly name: string
  /** `ctx.subagents` provider that tool delegates to (`spawn`, `fork`, ...). */
  readonly provider: string
  /**
   * How the tool's own configuration runs children in the background:
   * `continuable` (the shipped presets) returns an id at once; `one-shot`
   * waits for the result. Mirrors the tool row's `backgroundMode`.
   */
  readonly mode: 'continuable' | 'one-shot'
}

/** Raw plugin configuration, as written in `cordis.patch.yml`. */
export interface Config {
  /** Delegation tools to orchestrate; defaults to the shipped presets' two rows. */
  readonly tools?: readonly Partial<DelegationTool>[]
  /** Provider that runs the reviewer child (a fresh context); default `spawn`. */
  readonly reviewerProvider?: string
  /**
   * Defaults for sessions with no stored choice, mainly for headless runs
   * where no modal can be answered. Absent or empty means stock behavior.
   */
  readonly defaults?: {
    readonly subagentModel?: ModelRoute
    readonly reviewer?: { readonly enabled?: boolean; readonly model?: ModelRoute }
  }
  /** State directory; default `<DSH_HOME>/dsh-orquestrator`. */
  readonly stateDir?: string
  /** Persist per-session choices across restarts (default true). */
  readonly persist?: boolean
  /** Ask the worker to end with a structured handoff report for the reviewer (default true). */
  readonly workerHandoff?: boolean
  /** Longest worker report (characters) embedded in the reviewer's packet (default 60000). */
  readonly maxWorkerReportChars?: number
  /** Most sessions kept in the persisted state; the least recently updated are pruned (default 500). */
  readonly maxSessions?: number
}

/** Validated configuration with every default resolved. */
export interface PluginConfig {
  readonly tools: readonly DelegationTool[]
  readonly reviewerProvider: string
  readonly defaults: OrchestratorConfig | null
  readonly stateDir: string | undefined
  readonly persist: boolean
  readonly workerHandoff: boolean
  readonly maxWorkerReportChars: number
  readonly maxSessions: number
}

/** The shipped `standard` preset delegates through these two rows. */
const DEFAULT_TOOLS: readonly DelegationTool[] = [
  { name: 'subagent', provider: 'spawn', mode: 'continuable' },
  { name: 'subagent_fork', provider: 'fork', mode: 'continuable' },
]

/** Fail-loud helper: a configuration error names the field and the plugin. */
function invalid(field: string, detail: string): Error {
  return new Error(`dsh-orquestrator: invalid config field "${field}": ${detail}`)
}

/** A positive safe integer, or the default when absent. */
function positiveInt(field: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw invalid(field, 'must be a positive integer')
  return value
}

/** A boolean, or the default when absent. */
function bool(field: string, value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw invalid(field, 'must be a boolean')
  return value
}

/** A non-empty string, or the default when absent. */
function text(field: string, value: unknown, fallback: string): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.trim() === '') throw invalid(field, 'must be a non-empty string')
  return value
}

/**
 * Validate the raw configuration and resolve every default.
 * @param raw - the plugin's `config` from the loader (may be undefined).
 * @returns the validated configuration.
 * @throws {Error} naming the offending field when the value is malformed.
 */
export function parsePluginConfig(raw: Config | undefined): PluginConfig {
  const config = raw ?? {}
  let tools: readonly DelegationTool[] = DEFAULT_TOOLS
  if (config.tools !== undefined) {
    if (!Array.isArray(config.tools) || config.tools.length === 0) throw invalid('tools', 'must be a non-empty array')
    const seen = new Set<string>()
    tools = config.tools.map((entry, index): DelegationTool => {
      const where = `tools[${String(index)}]`
      const name = text(`${where}.name`, entry.name, '')
      if (name === '') throw invalid(`${where}.name`, 'is required')
      if (seen.has(name)) throw invalid(`${where}.name`, `repeats "${name}"`)
      seen.add(name)
      const provider = text(`${where}.provider`, entry.provider, '')
      if (provider === '') throw invalid(`${where}.provider`, 'is required')
      const mode = entry.mode ?? 'continuable'
      if (mode !== 'continuable' && mode !== 'one-shot') throw invalid(`${where}.mode`, 'must be "continuable" or "one-shot"')
      return { name, provider, mode }
    })
  }

  let defaults: OrchestratorConfig | null = null
  if (config.defaults !== undefined) {
    const subagentModel = config.defaults.subagentModel === undefined ? null : parseModelRoute(config.defaults.subagentModel)
    if (subagentModel === undefined) throw invalid('defaults.subagentModel', 'needs non-empty "provider" and "model"')
    const reviewerRaw = config.defaults.reviewer
    const reviewerModel = reviewerRaw?.model === undefined ? null : parseModelRoute(reviewerRaw.model)
    if (reviewerModel === undefined) throw invalid('defaults.reviewer.model', 'needs non-empty "provider" and "model"')
    const enabled = bool('defaults.reviewer.enabled', reviewerRaw?.enabled, false)
    if (subagentModel !== null || enabled) {
      defaults = { version: 1, subagentModel, reviewer: { enabled, model: enabled ? reviewerModel : null }, remember: true }
    }
  }

  if (config.stateDir !== undefined && (typeof config.stateDir !== 'string' || config.stateDir.trim() === '')) {
    throw invalid('stateDir', 'must be a non-empty string')
  }

  return {
    tools,
    reviewerProvider: text('reviewerProvider', config.reviewerProvider, 'spawn'),
    defaults,
    stateDir: config.stateDir,
    persist: bool('persist', config.persist, true),
    workerHandoff: bool('workerHandoff', config.workerHandoff, true),
    maxWorkerReportChars: positiveInt('maxWorkerReportChars', config.maxWorkerReportChars, 60_000),
    maxSessions: positiveInt('maxSessions', config.maxSessions, 500),
  }
}
