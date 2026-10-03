/**
 * The options of one child the plugin starts: which route it runs on, how hard
 * it may think, and how many tokens a single request may produce.
 *
 * Why this exists. DSH resolves a child's options from its parent, and when the
 * route changes without an effort it clears the parent's level so the new model
 * "resolves its own default". On the deployments this plugin targets that
 * default is `max` (the route's `reasoning: max`), and the output ceiling is
 * the route's declared `maxTokens` (131K to 943K tokens). Two failures seen in real
 * runs follow directly: a fast worker burned its entire budget deliberating a
 * numeric edge case, and a slow reasoning model needed two minutes per turn.
 * The studies behind `docs/estudos/` agree on the remedy (a ceiling on the
 * effort and a hard output cap), so every child gets both unless the user
 * picked an explicit level or the operator turned the policy off.
 * @module dsh-orquestrator/effort
 */

import type { AgentLike, AgentOptionsLike, LoggerLike, ModelInfoLike, ModelInfoSourceLike } from './host-services.ts'
import { capFor, chooseEffort, type EffortLevel, type Role } from './models.ts'
import type { ModelRoute } from './shared.ts'

/** The slice of the plugin configuration the planner reads. */
export interface ChildPolicy {
  /** False leaves children exactly as the user picked them (no ceiling, no cap). */
  readonly enabled: boolean
  /** Operator ceilings per role; a missing role falls back to the model's profile, then `medium`. */
  readonly caps: { readonly worker?: EffortLevel; readonly reviewer?: EffortLevel }
  /** Output-token ceilings per role. */
  readonly maxTokens: { readonly worker?: number | undefined; readonly reviewer?: number | undefined }
}

/** Inputs of {@link planChild}. */
export interface PlanInput {
  /** The LLM runtime, or undefined when it is not available (the plan then keeps the user's pick untouched). */
  readonly source: ModelInfoSourceLike | undefined
  readonly parent: AgentLike
  /** The route the user picked for this role, or null to inherit the parent's. */
  readonly route: ModelRoute | null
  readonly role: Role
  /** A reasoning level the user or the operator asked for explicitly. */
  readonly explicitEffort: string | undefined
  readonly policy: ChildPolicy
  readonly signal: AbortSignal
  readonly logger: LoggerLike
}

/** The resolved plan of one child. */
export interface ChildPlan {
  /** What to pass as `agentOptions`; undefined when nothing needs overriding. */
  readonly options: AgentOptionsLike | undefined
  /** The route the child will run on, when known. */
  readonly route: { readonly provider: string; readonly model: string } | undefined
  /** The levels the model offers, when known (a retry steps down this ladder). */
  readonly ladder: readonly string[] | undefined
  /** The level the child will run at, when known. */
  readonly effective: string | undefined
  /** One line for the logs. */
  readonly summary: string
}

/**
 * The route, level and token ceiling the parent would hand to a child. Mirrors
 * DSH's own resolution: the latest request header owns provider, model and
 * effort once a request ran; creation options are the fallback.
 * @param parent - the delegating agent.
 * @returns detached options.
 */
export function parentOptionsOf(parent: AgentLike): AgentOptionsLike {
  const requested = parent.session.requestHeader?.()?.config
  if (requested === undefined) return { ...parent.options }
  const { provider: _provider, model: _model, reasoningEffort: _effort, ...created } = parent.options
  return {
    ...created,
    ...requested.provider === undefined ? {} : { provider: requested.provider },
    ...requested.model === undefined ? {} : { model: requested.model },
    ...requested.reasoningEffort === undefined ? {} : { reasoningEffort: requested.reasoningEffort },
  }
}

/** The options exactly as the user picked them, without the policy. */
function untouched(route: ModelRoute | null, explicitEffort: string | undefined): AgentOptionsLike | undefined {
  const options: AgentOptionsLike = {
    ...route === null ? {} : { provider: route.provider, model: route.model },
    ...explicitEffort === undefined ? {} : { reasoningEffort: explicitEffort },
  }
  return Object.keys(options).length === 0 ? undefined : options
}

/**
 * Plan one child. Never throws: when the model cannot be described the plan
 * degrades to the user's own pick, which is what the plugin did before.
 * @param input - the route, role, policy and LLM runtime.
 * @returns the plan.
 */
export async function planChild(input: PlanInput): Promise<ChildPlan> {
  const { source, parent, route, role, explicitEffort, policy, signal, logger } = input
  const inherited = parentOptionsOf(parent)
  const target = route !== null
    ? { provider: route.provider, model: route.model }
    : inherited.provider !== undefined && inherited.model !== undefined ? { provider: inherited.provider, model: inherited.model } : undefined

  const fallback = (why: string): ChildPlan => ({
    options: untouched(route, explicitEffort),
    route: target,
    ladder: undefined,
    effective: explicitEffort,
    summary: `${role}: ${target === undefined ? 'inherited route' : `${target.provider}/${target.model}`}, effort left as picked (${why})`,
  })
  if (!policy.enabled) return fallback('policy off')
  if (target === undefined || source === undefined) return fallback('route or runtime unknown')

  let info: ModelInfoLike
  try {
    info = await source.resolveModelInfo(target.provider, target.model, signal)
  } catch (error: unknown) {
    signal.throwIfAborted()
    logger.warn(`dsh-orquestrator: cannot describe ${target.provider}/${target.model} (${error instanceof Error ? error.message : String(error)}); its effort is left as picked`)
    return fallback('model not describable')
  }

  const ladder = info.reasoning === undefined ? [] : info.reasoning.efforts.map(effort => effort.id)
  const current = route === null ? inherited.reasoningEffort ?? info.reasoning?.defaultEffort : info.reasoning?.defaultEffort
  const cap = capFor(target, role, policy.caps[role])
  const choice = chooseEffort({ ladder, current, explicit: explicitEffort, cap })
  if (choice.dropped !== undefined) {
    logger.warn(`dsh-orquestrator: ${target.provider}/${target.model} does not offer reasoning effort "${choice.dropped}"; using the recommended level instead`)
  }

  const options: { provider?: string; model?: string; reasoningEffort?: string; maxTokens?: number } = {
    ...route === null ? {} : { provider: route.provider, model: route.model },
    ...choice.effort === undefined ? {} : { reasoningEffort: choice.effort },
  }
  const limit = policy.maxTokens[role]
  const ceiling = route === null ? inherited.maxTokens ?? info.defaultMaxTokens : info.defaultMaxTokens
  if (limit !== undefined && ceiling !== undefined && ceiling > limit) options.maxTokens = limit

  const effective = choice.effort ?? current
  return {
    options: Object.keys(options).length === 0 ? undefined : options,
    route: target,
    ladder,
    effective,
    summary: `${role}: ${target.provider}/${target.model}, effort ${effective ?? 'route default'} (${choice.reason}, ceiling ${cap}), max output ${options.maxTokens === undefined ? 'unchanged' : String(options.maxTokens)}`,
  }
}
