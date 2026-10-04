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

import type { PluginConfig } from './config.ts'
import type { AgentLike, AgentOptionsLike, LoggerLike, ModelInfoLike, ModelInfoSourceLike } from './host-services.ts'
import { capFor, chooseEffort, type EffortLevel } from './models.ts'
import type { ModelRoute } from './shared.ts'

/** The slice of the plugin configuration the planner reads. */
export interface ChildPolicy {
  /** False leaves children exactly as the user picked them (no ceiling, no cap). */
  readonly enabled: boolean
  /** Operator ceiling on the reasoning effort; absent falls back to the model's profile, then `medium`. */
  readonly cap?: EffortLevel
  /** Output-token ceiling per request; absent means none. */
  readonly maxTokens?: number | undefined
}

/**
 * The effort and token policy of a configuration.
 * @param config - the validated plugin configuration.
 * @returns the policy the planner reads.
 */
export function childPolicyOf(config: PluginConfig): ChildPolicy {
  return { enabled: config.effort.enabled, ...config.effort.cap === undefined ? {} : { cap: config.effort.cap }, maxTokens: config.limits.worker }
}

/** Inputs of {@link planChild}. */
export interface PlanInput {
  /** The LLM runtime, or undefined when it is not available (the plan then keeps the user's pick untouched). */
  readonly source: ModelInfoSourceLike | undefined
  readonly parent: AgentLike
  /** The route the user picked, or null to inherit the parent's. */
  readonly route: ModelRoute | null
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
  /** Why the route could not be described (a model the catalog no longer knows); the plan then only carries the user's own pick. */
  readonly unresolved?: string
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

/** A confirmed choice that cannot be honored (its model is gone): reported to the caller, never silently replaced by another model. */
export class ChoiceUnusableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChoiceUnusableError'
  }
}

/**
 * Refuse to run a child on a route the user confirmed and the LLM runtime can no longer call. A model that merely could
 * not be described is not enough to refuse: the route must also fail the check that gates storing a route
 * (`resolveCallConfig`) when the runtime offers it, so an adapter that cannot describe a model it can call keeps
 * working. Without that check the failed description stands as the reason.
 * @param source - the LLM runtime.
 * @param route - the route the user confirmed.
 * @param plan - the plan made for it.
 * @param signal - the caller's cancellation.
 * @throws {ChoiceUnusableError} when the route cannot be used.
 * @throws the cancellation reason when the caller cancelled.
 */
export async function assertChoiceUsable(source: ModelInfoSourceLike | undefined, route: ModelRoute, plan: ChildPlan, signal: AbortSignal): Promise<void> {
  if (plan.unresolved === undefined) return
  let reason = plan.unresolved
  if (source?.resolveCallConfig !== undefined) {
    try {
      await abortable(source.resolveCallConfig({ provider: route.provider, model: route.model }, signal), signal)
      return // routable after all: only the description failed, and the user's pick stands
    } catch (error: unknown) {
      if (signal.aborted) throw abortReason(signal)
      reason = error instanceof Error ? error.message : String(error)
    }
  }
  throw new ChoiceUnusableError(
    `dsh-orquestrator: the subagent model ${route.provider}/${route.model} cannot be used (${reason}). `
    + 'Open /orquestrar to pick another model, or cancel the dialog to run subagents as DSH does.',
  )
}

/** The error to raise for a cancelled call: always an Error, whatever the signal's reason was. */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  return new Error(typeof reason === 'string' && reason !== '' ? reason : 'the call was aborted')
}

/**
 * Wait for a lookup unless the caller cancels first. A lookup that ignores its signal (a custom adapter that does
 * IO) must not leave a cancelled start pending.
 * @param lookup - the pending lookup.
 * @param signal - the caller's cancellation.
 * @returns the lookup's value.
 * @throws the cancellation reason as an Error, or the lookup's own failure.
 */
function abortable<T>(lookup: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      lookup.catch(() => undefined)
      reject(abortReason(signal))
      return
    }
    const onAbort = (): void => { reject(abortReason(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    lookup.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

/**
 * Plan one child. Never throws, except for the caller's cancellation: when
 * the model cannot be described the plan degrades to the user's own pick,
 * which is what the plugin did before, and says why in `unresolved`.
 * @param input - the route, policy and LLM runtime.
 * @returns the plan.
 * @throws the cancellation reason when the caller cancelled while the model was being described.
 */
export async function planChild(input: PlanInput): Promise<ChildPlan> {
  const { source, parent, route, explicitEffort, policy, signal, logger } = input
  const inherited = parentOptionsOf(parent)
  // DSH clears the parent's effort only when the child's route CHANGES; a child on the parent's own route (picked or
  // not) inherits the parent's effort and token limit, so those, not the route's defaults, are what the ceiling sees.
  const unchanged = route === null || (inherited.provider === route.provider && inherited.model === route.model)
  const target = route !== null
    ? { provider: route.provider, model: route.model }
    : inherited.provider !== undefined && inherited.model !== undefined ? { provider: inherited.provider, model: inherited.model } : undefined

  const fallback = (why: string, unresolved?: string): ChildPlan => ({
    options: untouched(route, explicitEffort),
    route: target,
    ladder: undefined,
    effective: explicitEffort,
    ...unresolved === undefined ? {} : { unresolved },
    summary: `${target === undefined ? 'inherited route' : `${target.provider}/${target.model}`}, effort left as picked (${why})`,
  })
  if (!policy.enabled) return fallback('policy off')
  if (target === undefined || source === undefined) return fallback('route or runtime unknown')

  let info: ModelInfoLike
  try {
    if (signal.aborted) throw abortReason(signal)
    info = await abortable(source.resolveModelInfo(target.provider, target.model, signal), signal)
  } catch (error: unknown) {
    if (signal.aborted) throw abortReason(signal)
    const reason = error instanceof Error ? error.message : String(error)
    logger.warn(`dsh-orquestrator: cannot describe ${target.provider}/${target.model} (${reason}); its effort is left as picked`)
    return fallback('model not describable', reason)
  }

  const ladder = info.reasoning === undefined ? [] : info.reasoning.efforts.map(effort => effort.id)
  const current = unchanged ? inherited.reasoningEffort ?? info.reasoning?.defaultEffort : info.reasoning?.defaultEffort
  const cap = capFor(target, policy.cap)
  const choice = chooseEffort({ ladder, current, explicit: explicitEffort, cap })
  if (choice.dropped !== undefined) {
    logger.warn(`dsh-orquestrator: ${target.provider}/${target.model} does not offer reasoning effort "${choice.dropped}"; using the recommended level instead`)
  }

  const options: { provider?: string; model?: string; reasoningEffort?: string; maxTokens?: number } = {
    ...route === null ? {} : { provider: route.provider, model: route.model },
    ...choice.effort === undefined ? {} : { reasoningEffort: choice.effort },
  }
  // DSH hands a child the parent's creation token limit on EVERY route (only the effort is cleared on a route change),
  // so the limit the child would run with is the parent's when it has one, else the route's own ceiling.
  const limit = policy.maxTokens
  const ceiling = inherited.maxTokens ?? info.defaultMaxTokens
  // Never above what the model itself allows: a parent's larger limit would be refused by a smaller model.
  if (limit !== undefined && ceiling !== undefined && ceiling > limit) options.maxTokens = info.defaultMaxTokens === undefined ? limit : Math.min(limit, info.defaultMaxTokens)

  const effective = choice.effort ?? current
  return {
    options: Object.keys(options).length === 0 ? undefined : options,
    route: target,
    ladder,
    effective,
    summary: `${target.provider}/${target.model}, effort ${effective ?? 'route default'} (${choice.reason}, ceiling ${cap}), max output ${options.maxTokens === undefined ? 'unchanged' : String(options.maxTokens)}`,
  }
}
