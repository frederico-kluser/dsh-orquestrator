/**
 * Wire contract shared by the host routes and the browser half: route paths,
 * the per-session orchestration config, and its validator. Pure types,
 * constants and functions with no runtime dependencies, because both bundles
 * (Node ESM and browser CJS) inline this file.
 * @module dsh-orquestrator/shared
 */

/** Stable plugin identity (loader-table id, log prefix, state directory name). */
export const PLUGIN_ID = 'dsh-orquestrator'

/** Route prefix owned by this plugin on the composition's web server. */
export const ROUTE_PREFIX = '/dsh-orquestrator'

/** Session configuration route: `GET ?sessionId=<id>` reads, `POST` writes or clears. */
export const CONFIG_ROUTE = `${ROUTE_PREFIX}/config`

/** One provider/model route, as advertised by the model catalog. */
export interface ModelRoute {
  /** Registered LLM provider id (catalog group id). */
  readonly provider: string
  /** Provider-owned exact model id. */
  readonly model: string
  /** Optional adapter-owned reasoning effort for this exact route. */
  readonly reasoningEffort?: string
}

/** The reviewer half of a session configuration. */
export interface ReviewerConfig {
  /** Whether every subagent's work goes through the independent reviewer. */
  readonly enabled: boolean
  /** Reviewer route; null means "same route as the subagent that did the work". */
  readonly model: ModelRoute | null
  /** Reasoning effort the user picked for the reviewer; null means the recommended level for its model. */
  readonly effort: string | null
}

/** What the user confirmed in the modal for one session. */
export interface OrchestratorConfig {
  /** Schema version of this record (persisted to disk). */
  readonly version: 1
  /** Route every subagent runs on; null keeps the main agent's route (stock behavior). */
  readonly subagentModel: ModelRoute | null
  /** Reasoning effort the user picked for subagents; null means the recommended level for their model. */
  readonly workerEffort: string | null
  /** The independent reviewer that validates each subagent's work. */
  readonly reviewer: ReviewerConfig
  /** Skip the modal on the next tasks of this session and reuse this choice. */
  readonly remember: boolean
}

/** The inert configuration: exactly the stock DSH behavior. */
export const OFF_CONFIG: OrchestratorConfig = Object.freeze({
  version: 1,
  subagentModel: null,
  workerEffort: null,
  reviewer: Object.freeze({ enabled: false, model: null, effort: null }),
  remember: false,
})

/**
 * Whether a configuration changes anything relative to stock DSH.
 * @param config - a session configuration, or null/undefined for "none".
 * @returns true when a different subagent model or the reviewer is on.
 */
export function isActive(config: OrchestratorConfig | null | undefined): config is OrchestratorConfig {
  return config != null && (config.subagentModel !== null || config.reviewer.enabled)
}

/** Payload of `GET ${CONFIG_ROUTE}?sessionId=<id>` and the answer to a successful `POST`. */
export interface ConfigStatePayload {
  /** The session the configuration belongs to. */
  readonly sessionId: string
  /** The stored configuration; null when the user never confirmed or cancelled. */
  readonly config: OrchestratorConfig | null
}

/** Body of `POST ${CONFIG_ROUTE}`; `config: null` clears the session's configuration. */
export interface ConfigWritePayload {
  readonly sessionId: string
  readonly config: OrchestratorConfig | null
}

/** Structured wire failure codes. */
export type ErrorCode = 'bad-request' | 'invalid-config' | 'invalid-model' | 'internal'

/** Uniform JSON error body. */
export interface ErrorPayload {
  readonly code: ErrorCode
  readonly message: string
}

/** Longest provider/model/effort id the validator admits (defensive bound). */
const MAX_ID_LENGTH = 256

/** A plain object check that also excludes arrays. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A bounded, non-empty, control-character-free identifier string. */
function isId(value: unknown): value is string {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH && !/[\u0000-\u001f\u007f]/.test(value)
}

/**
 * Parse an optional reasoning-effort id from untrusted JSON. Absent and null
 * both mean "the recommended level", so configurations written before the
 * field existed still load.
 * @param value - candidate value.
 * @returns the id wrapped (null when none), or undefined when malformed.
 */
function parseEffort(value: unknown): { readonly value: string | null } | undefined {
  if (value === null || value === undefined) return { value: null }
  return isId(value) ? { value } : undefined
}

/**
 * Parse one model route from untrusted JSON.
 * @param value - candidate value.
 * @returns the normalized route, or undefined when malformed.
 */
export function parseModelRoute(value: unknown): ModelRoute | undefined {
  if (!isRecord(value) || !isId(value['provider']) || !isId(value['model'])) return undefined
  const effort = value['reasoningEffort']
  if (effort !== undefined && !isId(effort)) return undefined
  return effort === undefined
    ? { provider: value['provider'], model: value['model'] }
    : { provider: value['provider'], model: value['model'], reasoningEffort: effort }
}

/**
 * Parse a session configuration from untrusted JSON (request body or disk).
 * @param value - candidate value.
 * @returns the normalized configuration, or undefined when malformed.
 */
export function parseConfig(value: unknown): OrchestratorConfig | undefined {
  if (!isRecord(value) || value['version'] !== 1) return undefined
  const rawSubagent = value['subagentModel']
  const subagentModel = rawSubagent === null || rawSubagent === undefined ? null : parseModelRoute(rawSubagent)
  if (subagentModel === undefined) return undefined
  const workerEffort = parseEffort(value['workerEffort'])
  if (workerEffort === undefined) return undefined
  const reviewer = value['reviewer']
  if (!isRecord(reviewer) || typeof reviewer['enabled'] !== 'boolean') return undefined
  const rawReviewerModel = reviewer['model']
  const reviewerModel = rawReviewerModel === null || rawReviewerModel === undefined ? null : parseModelRoute(rawReviewerModel)
  if (reviewerModel === undefined) return undefined
  const reviewerEffort = parseEffort(reviewer['effort'])
  if (reviewerEffort === undefined) return undefined
  if (typeof value['remember'] !== 'boolean') return undefined
  return {
    version: 1,
    subagentModel,
    workerEffort: workerEffort.value,
    reviewer: { enabled: reviewer['enabled'], model: reviewerModel, effort: reviewerEffort.value },
    remember: value['remember'],
  }
}

/**
 * Build the configuration a modal confirmation produces.
 * @param input - the modal's fields.
 * @returns a normalized configuration.
 */
export function buildConfig(input: {
  readonly subagentModel: ModelRoute | null
  readonly reviewerEnabled: boolean
  readonly reviewerModel: ModelRoute | null
  readonly remember: boolean
  /** Explicit subagent effort; omitted or null means the recommended level. */
  readonly workerEffort?: string | null
  /** Explicit reviewer effort; omitted or null means the recommended level. */
  readonly reviewerEffort?: string | null
}): OrchestratorConfig {
  return {
    version: 1,
    subagentModel: input.subagentModel,
    workerEffort: input.workerEffort ?? null,
    reviewer: {
      enabled: input.reviewerEnabled,
      model: input.reviewerEnabled ? input.reviewerModel : null,
      effort: input.reviewerEnabled ? input.reviewerEffort ?? null : null,
    },
    remember: input.remember,
  }
}

/**
 * Stable identity of a route, for equality checks and select option ids.
 * @param route - a model route.
 * @returns `provider/model`.
 */
export function routeKey(route: ModelRoute): string {
  return `${route.provider}/${route.model}`
}
