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

/** Subagent ledger route: `GET ?sessionId=<id>` lists the subagents started under that session, with their model and outcome. */
export const SUBAGENTS_ROUTE = `${ROUTE_PREFIX}/subagents`

/**
 * The global skill this plugin registers with DSH's skill registry. The kebab-case name is the `/name` token DSH
 * expands into the skill's instructions, and the token the dialog adds to a message when the user ticks the skill.
 */
export const SKILL_NAME = 'orchestrate-subagents'

/** One provider/model route, as advertised by the model catalog. */
export interface ModelRoute {
  /** Registered LLM provider id (catalog group id). */
  readonly provider: string
  /** Provider-owned exact model id. */
  readonly model: string
  /** Optional adapter-owned reasoning effort for this exact route. */
  readonly reasoningEffort?: string
}

/** What the user confirmed in the modal for one session. */
export interface OrchestratorConfig {
  /** Schema version of this record (persisted to disk). */
  readonly version: 1
  /** Route every subagent runs on; null keeps the main agent's route (stock behavior). */
  readonly subagentModel: ModelRoute | null
  /** Reasoning effort the user picked for subagents; null means the recommended level for their model. */
  readonly workerEffort: string | null
}

/** The inert configuration: exactly the stock DSH behavior. */
export const OFF_CONFIG: OrchestratorConfig = Object.freeze({
  version: 1,
  subagentModel: null,
  workerEffort: null,
})

/**
 * Whether a configuration changes anything relative to stock DSH.
 * @param config - a session configuration, or null/undefined for "none".
 * @returns true when a different subagent model or an explicit reasoning level is set.
 */
export function isActive(config: OrchestratorConfig | null | undefined): config is OrchestratorConfig {
  return config != null && (config.subagentModel !== null || config.workerEffort !== null)
}

/**
 * The reviewer block 0.2 to 0.4 sent and validated strictly, kept on the wire as a disabled no-op.
 *
 * The two halves of this plugin load at different moments: the host half when `dsh` starts, the browser half when
 * the page loads. A user who updates the plugin and refreshes the page without restarting runs a new browser against
 * an old host, and a tab opened before a restart runs an old browser against a new host. 0.2 to 0.4 refused a
 * configuration without this block ("config does not match the expected shape") and, in the browser, an answer
 * without it, so either mix could not save anything. Both ends therefore keep sending it. 0.5 reads and ignores it;
 * it is never stored. Drop it once nobody runs 0.4 any more.
 */
export const LEGACY_REVIEWER = Object.freeze({ enabled: false, model: null, effort: null } as const)

/** A configuration as it travels on the wire: the plugin's own fields plus the disabled legacy reviewer block. */
export type WireConfig = OrchestratorConfig & { readonly reviewer: typeof LEGACY_REVIEWER }

/**
 * Put a configuration in the shape every version of the plugin accepts.
 * @param config - a validated configuration.
 * @returns the same fields plus {@link LEGACY_REVIEWER}; the input is not modified.
 */
export function toWireConfig(config: OrchestratorConfig): WireConfig {
  return { ...config, reviewer: LEGACY_REVIEWER }
}

/** What the host says about the global skill: registered with `ctx.skills` (`available`), or not (switched off, or no skill registry). */
export interface SkillOffer {
  /** Kebab-case skill name, also the `/name` token. */
  readonly name: string
  /** Whether the skill is registered right now, so that the token will load it. */
  readonly available: boolean
}

/** Payload of `GET ${CONFIG_ROUTE}?sessionId=<id>` and the answer to a successful `POST`, as the browser reads it. */
export interface ConfigStatePayload {
  /** The session the configuration belongs to. */
  readonly sessionId: string
  /** The stored configuration; null when the user never confirmed or cancelled. */
  readonly config: OrchestratorConfig | null
  /** The skill the host offers; null when the host does not say (a host older than the skill), which means "do not offer it". */
  readonly skill: SkillOffer | null
}

/** The same payload as the host writes it: the configuration carries {@link LEGACY_REVIEWER}; `skill` is absent from hosts older than 0.8. */
export interface ConfigWirePayload {
  readonly sessionId: string
  readonly config: WireConfig | null
  readonly skill?: SkillOffer
}

/** Body of `POST ${CONFIG_ROUTE}`; `config: null` clears the session's configuration. */
export interface ConfigWritePayload {
  readonly sessionId: string
  readonly config: WireConfig | null
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
 * Parse a session configuration from untrusted JSON (request body, disk or the browser's memory).
 * Records written by 0.4.0 and older carry a `reviewer` block (and 0.2.x a `remember` flag): the reviewer was removed
 * in 0.5.0, so those fields are accepted and dropped, never a reason to lose the model the user picked.
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
  return { version: 1, subagentModel, workerEffort: workerEffort.value }
}

/**
 * Build the configuration a modal confirmation produces.
 * @param input - the modal's fields.
 * @returns a normalized configuration.
 */
export function buildConfig(input: {
  readonly subagentModel: ModelRoute | null
  /** Explicit subagent effort; omitted or null means the recommended level. */
  readonly workerEffort?: string | null
}): OrchestratorConfig {
  return { version: 1, subagentModel: input.subagentModel, workerEffort: input.workerEffort ?? null }
}

/**
 * Stable identity of a route, for equality checks and select option ids.
 * @param route - a model route.
 * @returns `provider/model`.
 */
export function routeKey(route: ModelRoute): string {
  return `${route.provider}/${route.model}`
}

/** The skill-name grammar of DSH's registry (`isSkillName`): lowercase words joined by single hyphens. */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Parse the host's skill offer from untrusted JSON.
 * @param value - candidate `skill` field of a configuration payload.
 * @returns the offer, or null when the field is absent or malformed (a host that predates the skill never sends it).
 */
export function parseSkillOffer(value: unknown): SkillOffer | null {
  if (!isRecord(value)) return null
  const name = value['name']
  const available = value['available']
  if (typeof name !== 'string' || name.length > 64 || !SKILL_NAME_PATTERN.test(name) || typeof available !== 'boolean') return null
  return { name, available }
}

/**
 * Where a subagent stands. `stopped` is a cancellation (stop reason `aborted`); `failed` is every other ending that is
 * not a normal completion (an error, a token ceiling, a refusal, and any reason a backend adds later).
 */
export type SubagentState = 'running' | 'done' | 'failed' | 'stopped'

/**
 * Map a terminal stop reason of DSH's subagent seam to a state. The reason set is merge-extensible, so an unknown
 * reason counts as a failure, as DSH's own consumers treat it.
 * @param stopReason - `completed`, `aborted`, `error`, `max-tokens`, `refusal` or a reason a backend added.
 * @returns the terminal state.
 */
export function subagentStateOf(stopReason: string): Exclude<SubagentState, 'running'> {
  if (stopReason === 'completed') return 'done'
  if (stopReason === 'aborted') return 'stopped'
  return 'failed'
}

/** One subagent the host saw start, as `GET ${SUBAGENTS_ROUTE}` reports it. */
export interface SubagentRecord {
  /** The child session id: the id the web client's subagent catalog uses. */
  readonly id: string
  /** The session that started the child (the caller's own session), when known. */
  readonly parentId: string | null
  /** The DSH subagent backend that runs the child (`spawn`, `fork`, ...). */
  readonly backend: string
  /** The model route the child runs on; null when it is not known. */
  readonly route: ModelRoute | null
  readonly state: SubagentState
  /** The terminal stop reason of the latest run, null while running. */
  readonly stopReason: string | null
  /** Epoch milliseconds of the latest start (a continuable child starts again when it is resumed). */
  readonly startedAt: number
  /** Epoch milliseconds of the latest end, null while running. */
  readonly endedAt: number | null
}

/** Answer of `GET ${SUBAGENTS_ROUTE}?sessionId=<id>`: the subagents started under that session, direct and deeper, oldest first. */
export interface SubagentsPayload {
  readonly sessionId: string
  readonly subagents: readonly SubagentRecord[]
  /**
   * The host's clock, epoch milliseconds, when it answered. The records' times are the host's, so the browser compares
   * them with this and not with its own clock (a tunnelled or skewed browser would otherwise misjudge how long ago a
   * child started). Absent from a host that does not send it.
   */
  readonly now?: number
}

/** Most records one answer carries (a defensive bound on both ends of the wire). */
export const MAX_SUBAGENTS_PER_RESPONSE = 500

const SUBAGENT_STATES: ReadonlySet<string> = new Set<SubagentState>(['running', 'done', 'failed', 'stopped'])

/** A finite, non-negative epoch-milliseconds value. */
function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * Parse one subagent record from untrusted JSON.
 * @param value - candidate record.
 * @returns the normalized record, or undefined when malformed.
 */
export function parseSubagentRecord(value: unknown): SubagentRecord | undefined {
  if (!isRecord(value) || !isId(value['id']) || !isId(value['backend'])) return undefined
  const state = value['state']
  if (typeof state !== 'string' || !SUBAGENT_STATES.has(state)) return undefined
  const parentId = value['parentId'] ?? null
  if (parentId !== null && !isId(parentId)) return undefined
  const rawRoute = value['route'] ?? null
  const route = rawRoute === null ? null : parseModelRoute(rawRoute)
  if (route === undefined) return undefined
  const stopReason = value['stopReason'] ?? null
  if (stopReason !== null && !isId(stopReason)) return undefined
  const endedAt = value['endedAt'] ?? null
  if (!isTime(value['startedAt']) || (endedAt !== null && !isTime(endedAt))) return undefined
  return {
    id: value['id'],
    parentId,
    backend: value['backend'],
    route,
    state: state as SubagentState,
    stopReason,
    startedAt: value['startedAt'],
    endedAt,
  }
}

/**
 * Parse the subagent ledger answer from untrusted JSON. A malformed record is dropped, never a reason to lose the others.
 * @param value - candidate payload.
 * @returns the payload, or undefined when it is not an object with a session id and a list.
 */
export function parseSubagentsPayload(value: unknown): SubagentsPayload | undefined {
  if (!isRecord(value) || !isId(value['sessionId']) || !Array.isArray(value['subagents'])) return undefined
  const subagents: SubagentRecord[] = []
  for (const candidate of (value['subagents'] as unknown[]).slice(0, MAX_SUBAGENTS_PER_RESPONSE)) {
    const record = parseSubagentRecord(candidate)
    if (record !== undefined) subagents.push(record)
  }
  return isTime(value['now']) ? { sessionId: value['sessionId'], subagents, now: value['now'] } : { sessionId: value['sessionId'], subagents }
}
