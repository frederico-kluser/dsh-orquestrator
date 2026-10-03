/**
 * Deployment configuration of the host half. Every tunable is a validated
 * `Config` field overridable from `cordis.patch.yml`; a malformed value fails
 * loud at load (never a silent permissive fallback).
 * @module dsh-orquestrator/config
 */

import { isEffortLevel, type EffortLevel } from './models.ts'
import { parseModelRoute, type ModelRoute, type OrchestratorConfig } from './shared.ts'
import { globToRegExp } from './workspace.ts'

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
    /** Reasoning effort for subagents; absent means the recommended level for their model. */
    readonly workerEffort?: string
    readonly reviewer?: { readonly enabled?: boolean; readonly model?: ModelRoute; readonly effort?: string }
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
  /**
   * What the reviewer sees of the worker: `auto` (default) withholds the worker's report whenever the working
   * tree changed, so the reviewer judges the diff, not the story; `isolated` always withholds it; `claims`
   * always hands it over, delimited as untrusted.
   */
  readonly reviewerContext?: 'auto' | 'isolated' | 'claims'
  /** Ask the reviewer to report through DSH's structured-output tool and render the report from it (default true). */
  readonly structuredVerdict?: boolean
  /**
   * Ceiling on the reasoning effort of every child the plugin starts, per role. Defaults come from the
   * model's own profile (`src/models.ts`), else `medium`. `false` turns the ceiling off.
   */
  readonly effort?: false | { readonly worker?: string; readonly reviewer?: string }
  /** Ceiling on output tokens per model request (reasoning included), per role. `false` turns a ceiling off. */
  readonly limits?: false | { readonly workerMaxTokens?: number | false; readonly reviewerMaxTokens?: number | false }
  /** Retry a worker once, one reasoning level lower, when it stopped at its token limit (default true). */
  readonly retryOnTokenLimit?: boolean
  /** Fingerprint the working tree with git around each reviewed delegation (default true). */
  readonly workspaceChecks?: boolean
  /** Extra globs for files the reviewer must scrutinize when the worker changed them (`*` and `**`). */
  readonly sensitivePaths?: readonly string[]
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
  readonly reviewerContext: 'auto' | 'isolated' | 'claims'
  readonly structuredVerdict: boolean
  /** Effort ceiling policy: `enabled` false leaves children exactly as the user picked them. */
  readonly effort: { readonly enabled: boolean; readonly caps: { readonly worker?: EffortLevel; readonly reviewer?: EffortLevel } }
  /** Output-token ceilings per role; undefined means no ceiling. */
  readonly limits: { readonly worker: number | undefined; readonly reviewer: number | undefined }
  readonly retryOnTokenLimit: boolean
  readonly workspaceChecks: boolean
  readonly sensitivePaths: readonly RegExp[]
}

/** Default output-token ceilings: far below the 384K-943K some routes allow, far above any legitimate single step. */
export const DEFAULT_LIMITS = Object.freeze({ worker: 64_000, reviewer: 32_000 })

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

/** A canonical reasoning level, or undefined when absent. */
function level(field: string, value: unknown): EffortLevel | undefined {
  if (value === undefined) return undefined
  if (!isEffortLevel(value)) throw invalid(field, 'must be one of off, minimal, low, medium, high, xhigh, max')
  return value
}

/** An output-token ceiling: a positive integer, `false` (none), or the default when absent. */
function ceiling(field: string, value: unknown, fallback: number): number | undefined {
  if (value === undefined) return fallback
  if (value === false) return undefined
  return positiveInt(field, value, fallback)
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
    const workerEffort = level('defaults.workerEffort', config.defaults.workerEffort) ?? null
    const reviewerEffort = level('defaults.reviewer.effort', reviewerRaw?.effort) ?? null
    if (subagentModel !== null || enabled) {
      defaults = {
        version: 1,
        subagentModel,
        workerEffort,
        reviewer: { enabled, model: enabled ? reviewerModel : null, effort: enabled ? reviewerEffort : null },
        remember: true,
      }
    }
  }

  if (config.stateDir !== undefined && (typeof config.stateDir !== 'string' || config.stateDir.trim() === '')) {
    throw invalid('stateDir', 'must be a non-empty string')
  }
  const reviewerContext = config.reviewerContext ?? 'auto'
  if (reviewerContext !== 'auto' && reviewerContext !== 'isolated' && reviewerContext !== 'claims') {
    throw invalid('reviewerContext', 'must be "auto", "isolated" or "claims"')
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
    reviewerContext,
    structuredVerdict: bool('structuredVerdict', config.structuredVerdict, true),
    effort: parseEffortPolicy(config.effort),
    limits: parseLimits(config.limits),
    retryOnTokenLimit: bool('retryOnTokenLimit', config.retryOnTokenLimit, true),
    workspaceChecks: bool('workspaceChecks', config.workspaceChecks, true),
    sensitivePaths: parseSensitivePaths(config.sensitivePaths),
  }
}

/** Resolve the `effort` block. */
function parseEffortPolicy(raw: Config['effort']): PluginConfig['effort'] {
  if (raw === undefined) return { enabled: true, caps: {} }
  if (raw === false) return { enabled: false, caps: {} }
  if (typeof raw !== 'object' || raw === null) throw invalid('effort', 'must be false or an object with worker and/or reviewer')
  const worker = level('effort.worker', raw.worker)
  const reviewer = level('effort.reviewer', raw.reviewer)
  return { enabled: true, caps: { ...worker === undefined ? {} : { worker }, ...reviewer === undefined ? {} : { reviewer } } }
}

/** Resolve the `limits` block. */
function parseLimits(raw: Config['limits']): PluginConfig['limits'] {
  if (raw === undefined) return { worker: DEFAULT_LIMITS.worker, reviewer: DEFAULT_LIMITS.reviewer }
  if (raw === false) return { worker: undefined, reviewer: undefined }
  if (typeof raw !== 'object' || raw === null) throw invalid('limits', 'must be false or an object')
  return {
    worker: ceiling('limits.workerMaxTokens', raw.workerMaxTokens, DEFAULT_LIMITS.worker),
    reviewer: ceiling('limits.reviewerMaxTokens', raw.reviewerMaxTokens, DEFAULT_LIMITS.reviewer),
  }
}

/** Compile the extra sensitive-path globs. */
function parseSensitivePaths(raw: Config['sensitivePaths']): readonly RegExp[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.some(entry => typeof entry !== 'string' || entry.trim() === '')) {
    throw invalid('sensitivePaths', 'must be an array of non-empty glob strings')
  }
  return raw.map(entry => globToRegExp(entry.trim()))
}
