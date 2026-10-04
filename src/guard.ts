/**
 * The start guard: the one place every child of every delegation passes through,
 * and the plugin's only mechanism.
 *
 * Why it exists. DSH has several ways to start a child: the `subagent` and
 * `subagent_fork` tools, the `workflow` tool (and `ralph`, which runs on the same
 * engine), a one-shot background `subagent` job and the experimental agent team.
 * Only the first two are tools a plugin can wrap, and wrapping tools is the wrong
 * place to enforce anything: the workflow engine starts its agents through
 * `ctx.subagents.start()` itself, so a user who had confirmed "subagents run on
 * DeepSeek V4.1 Flash" got every workflow agent on the main agent's model at the
 * main agent's effort (34 Sonnet 5.5 agents at `max` in the session that exposed it).
 *
 * `SubagentRuntime.start` (one-shot) and `SubagentRuntime.startContinuable` are
 * the only doors: providers are called from `start` alone, and a child agent is
 * created from those two paths alone (`test/contract/dsh-source.test.ts` pins
 * both facts). The guard stands in them. For a session with a confirmed choice
 * it plans the child (the picked route, the effort the user asked for or the
 * model's ceiling, the output-token cap) and hands the plan to DSH as the child's
 * `agentOptions`. It is code acting on the harness, not a request to the model:
 * the main agent cannot talk its way around it, and a workflow script that names
 * another model is overruled (`children.explicitModel`).
 *
 * The seam. DSH offers no hook around a child start (`subagent/start` is a
 * notification that fires after the child exists), so the guard installs an own
 * `start` and `startContinuable` on the service instance. A Cordis service is
 * reached through a per-context proxy; the instance behind it is what every
 * proxy reads, and the proxy hands it out under the registered symbol
 * `Symbol.for('cordis.original')`. Where there is no proxy (a plain object, as in
 * unit tests) the object itself is wrapped. The wrapper is removed with the
 * plugin and turns inert, in place, if something else wrapped on top of it.
 *
 * Failure policy. The guard never breaks a delegation because of its own
 * trouble: when it cannot plan a child it says so in the log and lets DSH start
 * the child as it would have. Two things are not its trouble and propagate: a
 * caller's cancellation, and a confirmed model the LLM runtime no longer knows
 * (`ChoiceUnusableError`): running the child on the main agent's model instead
 * is the original bug, and forcing the dead route fails every workflow agent
 * into a silent null, so the start is rejected with a message that says what to
 * do. Installing the guard is stricter still: a service that cannot be wrapped
 * fails the plugin at load, because a half-working guard is how the workflow
 * bypass went unnoticed.
 * @module dsh-orquestrator/guard
 */

import type { PluginConfig } from './config.ts'
import { ChoiceUnusableError, assertChoiceUsable, childPolicyOf, parentOptionsOf, planChild } from './effort.ts'
import type {
  AgentLike, AgentOptionsLike, ContinuableStartLike, ContinuableStartSpecLike, LoggerLike,
  ModelInfoSourceLike, SubagentRunLike, SubagentStartRequestLike, SubagentsLike,
} from './host-services.ts'
import { isActive, type ModelRoute, type OrchestratorConfig } from './shared.ts'
import type { ConfigStore } from './store.ts'

export { ChoiceUnusableError }

/** Cordis' registered symbol under which a service proxy yields the instance behind it. */
const CORDIS_ORIGINAL = Symbol.for('cordis.original')

/**
 * Registered key of the own, enumerable property that marks a request the guard already planned. Object spread copies
 * enumerable own symbols, so a wrapper stacked above the guard that normalizes the request with `{ ...request }` cannot
 * strip the mark. It is put on the copy the guard hands to DSH, never on the caller's own object, so a second live guard
 * (another copy of the plugin) plans each child once and the newer configuration wins.
 */
const GOVERNED_KEY = Symbol.for('dsh-orquestrator.governed')

/**
 * Whether the guard already planned a start request, or the one it was copied from.
 * @param request - a request or continuable spec.
 * @returns true for a request the guard produced.
 */
export function isGoverned(request: object): boolean {
  return (request as Record<symbol, unknown>)[GOVERNED_KEY] === true
}

/** Mark the guard's own copy as planned (the copy is always extensible). */
function markGoverned<T extends object>(request: T): T {
  Object.defineProperty(request, GOVERNED_KEY, { value: true, enumerable: true, configurable: true })
  return request
}

/** What the guard reads from the host and the plugin. */
export interface GuardDeps {
  /** The delegation service (a Cordis proxy in production, any object with the same methods in tests). */
  readonly subagents: SubagentsLike
  /** Per-session choices. */
  readonly store: ConfigStore
  /** Deployment default for sessions with no stored choice (headless), or null. */
  readonly defaults: OrchestratorConfig | null
  /** Resolver of a session's direct parent id (lineage walk). */
  readonly parentOf: (sessionId: string) => string | undefined
  readonly config: PluginConfig
  /** The LLM runtime, resolved per start (it may appear after the plugin loads). */
  readonly models: () => ModelInfoSourceLike | undefined
  readonly logger: LoggerLike
  /** Providers already warned about, so a workflow of thirty agents on one such provider logs once. Created by {@link installGuard} when absent. */
  readonly warned?: Set<string>
}

/** The parts of a start request the guard reads. */
export interface GovernInput {
  readonly parent: AgentLike | undefined
  readonly agentOptions: AgentOptionsLike | undefined
  readonly signal: AbortSignal
}

/**
 * The route a caller named for one child through `agentOptions`, completed from the route the child would otherwise
 * have: the provider's own when it declares one (the SDK provider), else the parent's.
 */
function namedRoute(requested: AgentOptionsLike | undefined, parent: AgentLike, providerRoute: { readonly provider: string; readonly model: string } | undefined): ModelRoute | undefined {
  if (requested === undefined || (requested.provider === undefined && requested.model === undefined)) return undefined
  const inherited = providerRoute ?? parentOptionsOf(parent)
  const provider = requested.provider ?? inherited.provider
  const model = requested.model ?? inherited.model
  if (provider === undefined || model === undefined) return undefined
  return { provider, model, ...requested.reasoningEffort === undefined ? {} : { reasoningEffort: requested.reasoningEffort } }
}

/** Never raise a token limit the caller (an operator's tool row, a team roster) set: the smaller of the caller's and the plan's stands. */
function keepSmallerLimit(requested: AgentOptionsLike | undefined, options: AgentOptionsLike): AgentOptionsLike {
  if (requested?.maxTokens === undefined) return options
  return { ...options, maxTokens: options.maxTokens === undefined ? requested.maxTokens : Math.min(requested.maxTokens, options.maxTokens) }
}

/**
 * The caller's own options with the plan on top; a smaller token limit the caller asked for stands.
 * The effort comes from the plan alone: the planner already took the caller's level as the explicit one,
 * kept it when the model offers it and dropped it when it does not, so spreading the caller's level back in
 * would resurrect exactly the level the planner refused, and the child would fail its first model call.
 */
function mergeCaller(requested: AgentOptionsLike | undefined, planned: AgentOptionsLike): AgentOptionsLike {
  const { reasoningEffort: _callerEffort, ...rest } = requested ?? {}
  return keepSmallerLimit(requested, { ...rest, ...planned })
}

/**
 * Decide the `agentOptions` of a child.
 *
 * Three cases, by who named the route:
 * - the user picked a subagent model and the caller named none (or `explicitModel` is `override`): the child gets the
 *   user's route and effort, and the caller's route-specific options are dropped (an effort chosen for another model
 *   must not travel to this one);
 * - the caller named a model and the user picked none (or `explicitModel` is `keep`): the caller's model stands and
 *   gets the same effort ceiling and token cap;
 * - nobody named a route (an effort-only choice, such as `defaults.workerEffort` alone): the child stays on the
 *   parent's route, under the ceilings.
 * @param deps - host services and configuration.
 * @param providerName - the provider the child will run on.
 * @param input - parent, the caller's `agentOptions` and cancellation.
 * @returns the options to start the child with, or undefined to leave the request exactly as it is.
 * @throws when the call was cancelled while the model was being described.
 */
export async function governedOptions(deps: GuardDeps, providerName: string, input: GovernInput): Promise<AgentOptionsLike | undefined> {
  const { parent, agentOptions, signal } = input
  const sessionId = parent?.session?.id
  if (parent === undefined || typeof sessionId !== 'string') return undefined
  const choice = deps.store.resolve(sessionId, deps.parentOf, deps.defaults)
  if (!isActive(choice)) return undefined

  const provider = deps.subagents.getProvider(providerName)
  // A missing provider is the real start's error to report.
  if (provider === undefined) return undefined
  if (!provider.capabilities.agentOptions) {
    if (deps.warned === undefined || !deps.warned.has(providerName)) {
      deps.warned?.add(providerName)
      deps.logger.warn(`dsh-orquestrator: provider "${providerName}" cannot run a child on another model or effort; its children keep the options DSH gives them`)
    }
    return undefined
  }

  const named = namedRoute(agentOptions, parent, provider.agentRouteDefaults)
  const keepNamed = named !== undefined && (choice.subagentModel === null || deps.config.guard.explicitModel === 'keep')
  const userRoute = !keepNamed && choice.subagentModel !== null
  const route: ModelRoute | null = keepNamed ? named : choice.subagentModel
  // With no route to plan against, the baseline is the parent's route; a provider that runs its own default route
  // (the SDK provider) has none the plugin can know, so its children are left to the provider.
  if (route === null && provider.agentRouteDefaults !== undefined) return undefined
  // An effort the user chose belongs to the route the user chose; the one exception is an effort-only choice (no model
  // picked, such as `defaults.workerEffort` alone), whose level reaches a caller's model if it offers it.
  const explicitEffort = keepNamed
    ? named.reasoningEffort ?? (choice.subagentModel === null ? choice.workerEffort ?? undefined : undefined)
    : route === null ? choice.workerEffort ?? agentOptions?.reasoningEffort : choice.workerEffort ?? route.reasoningEffort

  const source = deps.models()
  const plan = await planChild({
    source, parent, route, policy: childPolicyOf(deps.config), signal, logger: deps.logger, explicitEffort,
  })
  // A confirmed model the LLM runtime no longer knows (renamed, removed) would fail every child at its first request,
  // and a workflow turns that into a null per agent: say so now, once, to the caller, instead.
  if (userRoute && route !== null) await assertChoiceUsable(source, route, plan, signal)
  if (plan.options === undefined) {
    // Nothing to override; but a level the caller named and the planner dropped (a model with no reasoning levels) must not stay.
    return agentOptions?.reasoningEffort === undefined ? undefined : mergeCaller(agentOptions, {})
  }
  deps.logger.info(`dsh-orquestrator: child of session ${sessionId} on provider ${providerName}: ${plan.summary}`)
  return userRoute ? keepSmallerLimit(agentOptions, plan.options) : mergeCaller(agentOptions, plan.options)
}

/** Whether a value has the shape of a start request the guard can read. */
function isRequestLike(value: unknown): value is { readonly parent?: AgentLike; readonly agentOptions?: AgentOptionsLike } {
  return typeof value === 'object' && value !== null
}

/**
 * Apply {@link governedOptions} to a start request, without failing the start because of the guard's own trouble.
 * @param deps - host services and configuration.
 * @param providerName - the provider the child will run on.
 * @param request - the request (or continuable request) as the caller built it.
 * @param signal - the caller's cancellation.
 * @returns a marked copy with the planned `agentOptions`, or undefined when nothing changes.
 * @throws when the caller cancelled, or when the confirmed subagent model cannot be used ({@link ChoiceUnusableError}).
 */
async function governRequest<T extends { readonly parent?: AgentLike; readonly agentOptions?: AgentOptionsLike }>(
  deps: GuardDeps,
  providerName: string,
  request: T,
  signal: AbortSignal | undefined,
): Promise<T | undefined> {
  try {
    const options = await governedOptions(deps, providerName, {
      parent: request.parent, agentOptions: request.agentOptions, signal: signal ?? new AbortController().signal,
    })
    // Marked: a second live guard (another copy of the plugin) must not plan the same child again.
    return options === undefined ? undefined : markGoverned({ ...request, agentOptions: options })
  } catch (error: unknown) {
    if (error instanceof ChoiceUnusableError) throw error
    if (signal?.aborted === true) throw error instanceof Error ? error : new Error(String(error))
    deps.logger.warn(`dsh-orquestrator: could not apply the confirmed choice to a child (${error instanceof Error ? error.message : String(error)}); DSH starts it with its own options`)
    return undefined
  }
}

/** A method the guard wraps. */
type Method = (this: unknown, ...args: never[]) => unknown

/**
 * Put an own wrapper over one method of the service instance.
 * @param target - the service instance.
 * @param name - the method to wrap.
 * @param make - builds the wrapper from the original method and a liveness probe.
 * @returns the restorer: puts the previous method back, or, when something else wrapped on top, leaves the chain and turns this wrapper inert.
 */
function wrapMethod(
  target: Record<string, unknown>,
  name: 'start' | 'startContinuable',
  make: (original: Method, live: () => boolean) => Method,
): () => void {
  const original = target[name]
  if (typeof original !== 'function') throw new Error(`dsh-orquestrator: the subagents service has no ${name}() to guard`)
  const previous = Object.getOwnPropertyDescriptor(target, name)
  let live = true
  const wrapper = make(original as Method, () => live)
  Object.defineProperty(wrapper, 'name', { value: name, configurable: true })
  Object.defineProperty(target, name, { value: wrapper, writable: true, configurable: true, enumerable: previous?.enumerable ?? false })
  return () => {
    live = false
    if (target[name] !== wrapper) return
    if (previous === undefined) delete target[name]
    else Object.defineProperty(target, name, previous)
  }
}

/**
 * The instance behind a service proxy.
 * @param service - what `ctx.get('subagents')` returned.
 * @returns the instance every proxy reads, or the object itself when it is not a proxy.
 */
function serviceInstance(service: object): object {
  const instance = (service as Record<symbol, unknown>)[CORDIS_ORIGINAL]
  return typeof instance === 'object' && instance !== null ? instance : service
}

/**
 * Stand the guard in the doors of the delegation service.
 * @param deps - host services and configuration.
 * @returns the disposer that takes the guard out (idempotent).
 * @throws {Error} when the service has no `start()` or `startContinuable()` or refuses an own property.
 */
export function installGuard(given: GuardDeps): () => void {
  const deps: GuardDeps = given.warned === undefined ? { ...given, warned: new Set<string>() } : given
  const target = serviceInstance(deps.subagents) as unknown as Record<string, unknown>
  const restorers: (() => void)[] = []
  const restoreAll = (): void => {
    for (const restore of [...restorers].reverse()) restore()
    restorers.length = 0
  }
  try {
    restorers.push(wrapMethod(target, 'start', (original, live) => async function start(this: unknown, providerName: string, request: SubagentStartRequestLike) {
      if (!live() || !isRequestLike(request) || isGoverned(request)) return Reflect.apply(original, this, [providerName, request]) as Promise<SubagentRunLike>
      const governed = await governRequest(deps, providerName, request, request.signal)
      return Reflect.apply(original, this, [providerName, governed ?? request]) as Promise<SubagentRunLike>
    } as Method))
    restorers.push(wrapMethod(target, 'startContinuable', (original, live) => async function startContinuable(this: unknown, spec: ContinuableStartSpecLike) {
      if (!live() || !isRequestLike(spec) || !isRequestLike(spec.request) || isGoverned(spec) || isGoverned(spec.request)) {
        return Reflect.apply(original, this, [spec]) as Promise<ContinuableStartLike>
      }
      const governed = await governRequest(deps, spec.provider, spec.request, spec.signal)
      return Reflect.apply(original, this, [governed === undefined ? spec : { ...spec, request: governed }]) as Promise<ContinuableStartLike>
    } as Method))
  } catch (error: unknown) {
    restoreAll()
    throw error
  }
  deps.logger.info(`dsh-orquestrator: start guard on (every child of a session with a confirmed choice; a model the caller names itself: ${deps.config.guard.explicitModel})`)
  return restoreAll
}
