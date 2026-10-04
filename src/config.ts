/**
 * Deployment configuration of the host half. Every tunable is a validated
 * `Config` field overridable from `cordis.patch.yml`; a malformed value fails
 * loud at load (never a silent permissive fallback). Fields that belonged to
 * the independent reviewer, removed in 0.5.0, are ignored with a warning
 * instead of failing the load, so an existing patch file keeps working.
 * @module dsh-orquestrator/config
 */

import { isEffortLevel, type EffortLevel } from './models.ts'
import { parseModelRoute, type ModelRoute, type OrchestratorConfig } from './shared.ts'

/** Raw plugin configuration, as written in `cordis.patch.yml`. */
export interface Config {
  /**
   * Defaults for sessions with no stored choice, mainly for headless runs
   * where no modal can be answered. Absent or empty means stock behavior.
   */
  readonly defaults?: {
    readonly subagentModel?: ModelRoute
    /** Reasoning effort for subagents; absent means the recommended level for their model. */
    readonly workerEffort?: string
  }
  /** State directory; default `<DSH_HOME>/dsh-orquestrator`. */
  readonly stateDir?: string
  /** Persist per-session choices across restarts (default true). */
  readonly persist?: boolean
  /** Most sessions kept in the persisted state; the least recently updated are pruned (default 500). */
  readonly maxSessions?: number
  /**
   * Ceiling on the reasoning effort of every subagent. The default comes from the model's own profile
   * (`src/models.ts`), else `medium`. `false` turns the ceiling off.
   */
  readonly effort?: false | { readonly worker?: string }
  /** Ceiling on output tokens per model request (reasoning included). `false` turns the ceiling off. */
  readonly limits?: false | { readonly workerMaxTokens?: number | false }
  /**
   * The start guard, the plugin's one mechanism: every child DSH starts for a session with a confirmed choice,
   * whichever tool started it (`subagent`, `subagent_fork`, the `workflow` tool, `ralph`, a one-shot background job, ...),
   * runs on the subagent model with the effort ceiling and the token cap. `false` switches the enforcement off (the
   * dialog still stores choices). `explicitModel` says what to do with a model the caller named itself (an
   * `agent({ model })` call in a workflow script): `override` (default) runs it on the user's pick, `keep` lets the
   * caller's model stand (with the ceilings).
   */
  readonly children?: false | { readonly explicitModel?: 'override' | 'keep' }
}

/** Validated configuration with every default resolved. */
export interface PluginConfig {
  readonly defaults: OrchestratorConfig | null
  readonly stateDir: string | undefined
  readonly persist: boolean
  readonly maxSessions: number
  /** Effort ceiling policy: `enabled` false leaves children exactly as the user picked them. */
  readonly effort: { readonly enabled: boolean; readonly cap?: EffortLevel }
  /** Output-token ceiling per request; undefined means no ceiling. */
  readonly limits: { readonly worker: number | undefined }
  /** The start guard (`children`): `enabled` false switches the enforcement off. */
  readonly guard: { readonly enabled: boolean; readonly explicitModel: 'override' | 'keep' }
}

/** Every top-level field of the configuration. */
const KNOWN_FIELDS: ReadonlySet<string> = new Set(['defaults', 'stateDir', 'persist', 'maxSessions', 'effort', 'limits', 'children'])

/** Top-level fields that existed until 0.4.0 for the reviewer and the tool wrapper, and do nothing now. */
const REMOVED_FIELDS: ReadonlySet<string> = new Set([
  'tools', 'reviewerProvider', 'reviewerContext', 'structuredVerdict', 'workerHandoff', 'maxWorkerReportChars',
  'retryOnTokenLimit', 'workspaceChecks', 'sensitivePaths',
])

/** Where a field that belongs inside a block most often ends up when it is mis-indented to the top level. */
const MISPLACED: Readonly<Record<string, string>> = Object.freeze({
  explicitModel: 'children.explicitModel',
  worker: 'effort.worker',
  workerMaxTokens: 'limits.workerMaxTokens',
  subagentModel: 'defaults.subagentModel',
  workerEffort: 'defaults.workerEffort',
})

/** A plain object check that also excludes arrays. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The top-level fields the plugin does not know, with a hint where the field most likely belongs. A typo or a
 * mis-indented key is otherwise ignored without a word, and the default quietly replaces the intent (a mis-indented
 * `explicitModel: keep` runs as `override`).
 * @param raw - the plugin's `config` from the loader.
 * @returns one message per unknown field, empty when there is none.
 */
export function unknownConfigFields(raw: unknown): string[] {
  if (!isRecord(raw)) return []
  return Object.keys(raw)
    .filter(key => !KNOWN_FIELDS.has(key) && !REMOVED_FIELDS.has(key))
    .map(key => `unknown config field "${key}" is ignored${MISPLACED[key] === undefined ? '' : ` (did you mean ${MISPLACED[key]}?)`}`)
}

/**
 * The fields of a configuration written for 0.4.0 or older that belonged to the independent reviewer (and to the
 * delegation-tool wrapper it needed). They are ignored; saying so beats a silent no-op.
 * @param raw - the plugin's `config` from the loader.
 * @returns one message per ignored field, empty when there is none.
 */
export function removedConfigFields(raw: unknown): string[] {
  if (!isRecord(raw)) return []
  const found: string[] = []
  for (const key of Object.keys(raw)) if (REMOVED_FIELDS.has(key)) found.push(key)
  if (isRecord(raw['defaults']) && raw['defaults']['reviewer'] !== undefined) found.push('defaults.reviewer')
  if (isRecord(raw['effort']) && raw['effort']['reviewer'] !== undefined) found.push('effort.reviewer')
  if (isRecord(raw['limits']) && raw['limits']['reviewerMaxTokens'] !== undefined) found.push('limits.reviewerMaxTokens')
  return found.map(field => `config field "${field}" belonged to the independent reviewer, removed in 0.5.0, and is ignored`)
}

/** Default output-token ceiling: far below the 384K-943K some routes allow, far above any legitimate single step. */
export const DEFAULT_LIMITS = Object.freeze({ worker: 64_000 })

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

  let defaults: OrchestratorConfig | null = null
  if (config.defaults !== undefined) {
    const subagentModel = config.defaults.subagentModel === undefined ? null : parseModelRoute(config.defaults.subagentModel)
    if (subagentModel === undefined) throw invalid('defaults.subagentModel', 'needs non-empty "provider" and "model"')
    const workerEffort = level('defaults.workerEffort', config.defaults.workerEffort) ?? null
    if (subagentModel !== null || workerEffort !== null) defaults = { version: 1, subagentModel, workerEffort }
  }

  if (config.stateDir !== undefined && (typeof config.stateDir !== 'string' || config.stateDir.trim() === '')) {
    throw invalid('stateDir', 'must be a non-empty string')
  }

  return {
    defaults,
    stateDir: config.stateDir,
    persist: bool('persist', config.persist, true),
    maxSessions: positiveInt('maxSessions', config.maxSessions, 500),
    effort: parseEffortPolicy(config.effort),
    limits: parseLimits(config.limits),
    guard: parseGuard(config.children),
  }
}

/** Resolve the `effort` block. */
function parseEffortPolicy(raw: Config['effort']): PluginConfig['effort'] {
  if (raw === undefined) return { enabled: true }
  if (raw === false) return { enabled: false }
  if (!isRecord(raw)) throw invalid('effort', 'must be false or an object with worker')
  const worker = level('effort.worker', raw['worker'])
  return { enabled: true, ...worker === undefined ? {} : { cap: worker } }
}

/** Resolve the `limits` block. */
function parseLimits(raw: Config['limits']): PluginConfig['limits'] {
  if (raw === undefined) return { worker: DEFAULT_LIMITS.worker }
  if (raw === false) return { worker: undefined }
  if (!isRecord(raw)) throw invalid('limits', 'must be false or an object')
  return { worker: ceiling('limits.workerMaxTokens', raw['workerMaxTokens'], DEFAULT_LIMITS.worker) }
}

/** Resolve the `children` block (the start guard). Unknown keys fail loud: a typo must not silently keep the default. */
function parseGuard(raw: Config['children']): PluginConfig['guard'] {
  if (raw === undefined) return { enabled: true, explicitModel: 'override' }
  if (raw === false) return { enabled: false, explicitModel: 'override' }
  if (!isRecord(raw)) throw invalid('children', 'must be false or an object')
  for (const key of Object.keys(raw)) {
    if (key !== 'explicitModel') throw invalid(`children.${key}`, 'is not a known field (explicitModel)')
  }
  const explicitModel = raw['explicitModel'] ?? 'override'
  if (explicitModel !== 'override' && explicitModel !== 'keep') throw invalid('children.explicitModel', 'must be "override" or "keep"')
  return { enabled: true, explicitModel }
}
