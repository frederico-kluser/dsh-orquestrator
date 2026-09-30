/**
 * The orchestrated delegation: run the worker subagent on the route the user
 * picked, then hand its report to an independent reviewer that validates the
 * work, fixes only real defects, and DELIVERS the final report. The worker's
 * own output never reaches the main agent in reviewed mode.
 *
 * Failure policy (fail toward the user's work, never toward silence):
 * - worker did not complete: the failure is reported exactly like the stock
 *   `subagent` tool would (partial output preserved), with no review;
 * - reviewer failed: the worker's report is delivered under an explicit
 *   UNREVIEWED banner so the main agent knows it was never verified;
 * - the caller cancelled: cancellation propagates, nothing is delivered.
 * @module dsh-orquestrator/pipeline
 */

import type {
  AgentLike, AgentOptionsLike, ContentBlockLike, LoggerLike,
  SubagentResultLike, SubagentRunLike, SubagentsLike,
} from './host-services.ts'
import type { DelegationTool, PluginConfig } from './config.ts'
import type { ModelRoute, OrchestratorConfig } from './shared.ts'
import { REVIEWER_PERSONA, buildReviewerPacket, normalizeReport, parseVerdict, withHandoffContract, type Verdict } from './reviewer-protocol.ts'

/** The parsed model-facing arguments of a delegation call. */
export interface DelegationArgs {
  readonly description: string
  readonly prompt: string
  /** Explicit scheduling request from the model, when it made one. */
  readonly runInBackground?: boolean | undefined
}

/** JSON-safe text block, the only block kind the plugin writes. */
export interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

/** The canonical value of the `subagent` tool's output schema this plugin produces. */
export type DelegationValue =
  | { readonly kind: 'foreground'; readonly runId: string; readonly output: readonly TextBlock[] }
  | { readonly kind: 'continuable'; readonly subagentId: string }

/** What the pipeline needs from the host. */
export interface PipelineDeps {
  readonly subagents: SubagentsLike
  readonly config: PluginConfig
  readonly logger: LoggerLike
}

/** One orchestrated delegation request. */
export interface PipelineInput {
  readonly tool: DelegationTool
  readonly args: DelegationArgs
  readonly parent: AgentLike
  readonly signal: AbortSignal
  readonly config: OrchestratorConfig
}

/**
 * Parse the model-facing arguments the same way the stock tool reads them.
 * @param raw - the call's parsed arguments.
 * @returns the normalized arguments.
 * @throws {Error} when the required fields are missing (the stock schema requires both).
 */
export function parseDelegationArgs(raw: unknown): DelegationArgs {
  const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const description = record['description']
  const prompt = record['prompt']
  if (typeof description !== 'string' || typeof prompt !== 'string') {
    throw new Error('subagent call needs string "description" and "prompt"')
  }
  const background = record['run_in_background']
  return { description, prompt, ...typeof background === 'boolean' ? { runInBackground: background } : {} }
}

/**
 * Convert a picked route to child Agent options.
 * @param route - the route the user picked.
 * @returns options that override the parent's route for one child.
 */
export function toAgentOptions(route: ModelRoute): AgentOptionsLike {
  return {
    provider: route.provider,
    model: route.model,
    ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
  }
}

/** Concatenate the text blocks of a result. */
export function flattenText(blocks: readonly ContentBlockLike[]): string {
  return blocks
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('')
}

/** Human-readable headline for a non-completed stop reason (mirrors the stock tool). */
function stopReasonHeadline(stopReason: string): string {
  switch (stopReason) {
    case 'aborted': return 'subagent run was cancelled'
    case 'error': return 'subagent run failed'
    case 'max-tokens': return 'subagent run hit its token limit before finishing'
    case 'refusal': return 'subagent declined the task'
    default: return `subagent run ended abnormally (${stopReason})`
  }
}

/** Failure message for a worker that did not complete, preserving diagnostic and partial output. */
export function failureMessage(result: SubagentResultLike): string {
  const diagnostic = result.diagnostic === undefined ? '' : `\nDiagnostic: ${result.diagnostic}`
  const partial = flattenText(result.output)
  return `${stopReasonHeadline(result.stopReason)}${diagnostic}${partial === '' ? '' : `\nPartial output before the run ended:\n${partial}`}`
}

/**
 * Await one run's result and always dispose it, without letting a disposal
 * failure replace an independent result failure.
 * @param run - the published run.
 * @returns the child's terminal result.
 * @throws the result's rejection, else the disposal's.
 */
export async function settle(run: SubagentRunLike): Promise<SubagentResultLike> {
  const [execution] = await Promise.allSettled([run.result])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError(
        [execution.reason, disposal.reason],
        `subagent run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`,
      )
    }
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return execution.value
}

/**
 * Whether the effective route of the worker can be overridden by its provider.
 * @param subagents - the delegation service.
 * @param providerName - provider the tool delegates to.
 * @param route - the route the user picked (null keeps the parent's route).
 * @throws {Error} when the provider cannot run a child on another route.
 */
function assertRouteSupported(subagents: SubagentsLike, providerName: string, route: ModelRoute | null): void {
  if (route === null) return
  const provider = subagents.getProvider(providerName)
  if (provider === undefined) throw new Error(`subagent provider "${providerName}" is not registered`)
  if (!provider.capabilities.agentOptions) {
    throw new Error(`subagent provider "${providerName}" cannot run a child on another model; pick "same model" for subagents`)
  }
}

/** The banner naming what happened, prepended to the delivery. */
function bannerFor(reviewed: boolean, workerId: string, reviewerId: string | undefined, verdict: Verdict | undefined, failure?: string): string {
  if (reviewed) {
    return `Reviewed delivery: a subagent (session ${workerId}) did the work and an independent reviewer (session ${reviewerId ?? 'n/a'}) verified it`
      + `${verdict === undefined ? '' : ` [verdict: ${verdict}]`}. The report below was written by the reviewer; treat it as the result of the delegated task.`
  }
  return `WARNING - UNREVIEWED: the independent review did not complete (${failure ?? 'unknown reason'}). Below is the raw report of the subagent `
    + `(session ${workerId}). Its claims were NOT verified; check the work yourself before relying on it.`
}

/**
 * Run one orchestrated delegation.
 * @param deps - host services, validated configuration and logger.
 * @param input - the tool, the call's arguments, the calling agent and the user's choice.
 * @returns the canonical value of the `subagent` tool's output schema.
 * @throws {Error} with the stock tool's wording when the worker fails or the call is cancelled.
 */
export async function orchestrate(deps: PipelineDeps, input: PipelineInput): Promise<DelegationValue> {
  const { subagents, config, logger } = deps
  const { tool, args, parent, signal } = input
  const choice = input.config
  assertRouteSupported(subagents, tool.provider, choice.subagentModel)

  const maxDepth = subagents.resolveMaxDepth(undefined)
  const workerRoute = choice.subagentModel
  const workerOptions = workerRoute === null ? undefined : toAgentOptions(workerRoute)
  const base = {
    parent,
    ...workerOptions === undefined ? {} : { agentOptions: workerOptions },
    ...maxDepth === undefined ? {} : { maxDepth },
  }

  // Model override only: keep the stock scheduling, change nothing but the route.
  if (!choice.reviewer.enabled) {
    const request = { ...base, prompt: [{ type: 'text', text: args.prompt }] satisfies ContentBlockLike[] }
    if (tool.mode === 'continuable' && args.runInBackground !== false) {
      const started = await subagents.startContinuable({ provider: tool.provider, label: args.description, request, signal })
      logger.info(`dsh-orquestrator: ${tool.name} -> continuable ${started.childId} on ${describeRoute(workerRoute)}`)
      return { kind: 'continuable', subagentId: started.childId }
    }
    const run = await subagents.start(tool.provider, { ...request, label: args.description, signal })
    const result = await settle(run)
    if (result.stopReason !== 'completed') throw new Error(failureMessage(result))
    return { kind: 'foreground', runId: run.id, output: [{ type: 'text', text: flattenText(result.output) }] }
  }

  // Reviewed mode: the worker's output is an internal artifact, not a delivery.
  const workerPrompt = config.workerHandoff ? withHandoffContract(args.prompt) : args.prompt
  const worker = await subagents.start(tool.provider, {
    ...base,
    label: args.description,
    prompt: [{ type: 'text', text: workerPrompt }],
    signal,
  })
  const workerResult = await settle(worker)
  signal.throwIfAborted()
  if (workerResult.stopReason !== 'completed') throw new Error(failureMessage(workerResult))
  const workerReport = flattenText(workerResult.output)

  const reviewerRoute = choice.reviewer.model ?? workerRoute
  logger.info(
    `dsh-orquestrator: ${tool.name} worker ${worker.id} (${describeRoute(workerRoute)}) done; `
    + `reviewing on ${describeRoute(reviewerRoute)}`,
  )
  let reviewerId: string | undefined
  let failure: string | undefined
  let reviewText = ''
  try {
    const reviewerProvider = subagents.getProvider(config.reviewerProvider)
    if (reviewerProvider === undefined) throw new Error(`reviewer provider "${config.reviewerProvider}" is not registered`)
    if (reviewerRoute !== null && !reviewerProvider.capabilities.agentOptions) {
      throw new Error(`reviewer provider "${config.reviewerProvider}" cannot run on another model`)
    }
    const reviewer = await subagents.start(config.reviewerProvider, {
      parent,
      label: `Review: ${args.description}`,
      prompt: [{
        type: 'text',
        text: buildReviewerPacket({
          description: args.description,
          task: args.prompt,
          workerReport,
          workerSessionId: worker.id,
          maxReportChars: config.maxWorkerReportChars,
        }),
      }],
      ...reviewerProvider.capabilities.persona ? { persona: REVIEWER_PERSONA } : {},
      ...reviewerRoute === null ? {} : { agentOptions: toAgentOptions(reviewerRoute) },
      ...maxDepth === undefined ? {} : { maxDepth },
      signal,
    })
    reviewerId = reviewer.id
    const reviewResult = await settle(reviewer)
    signal.throwIfAborted()
    reviewText = flattenText(reviewResult.output).trim()
    if (reviewResult.stopReason !== 'completed') failure = stopReasonHeadline(reviewResult.stopReason)
    else if (reviewText === '') failure = 'the reviewer left no report'
  } catch (error: unknown) {
    // A caller cancellation is not a review failure: it aborts the delivery.
    signal.throwIfAborted()
    failure = error instanceof Error ? error.message : String(error)
  }

  if (failure !== undefined) {
    logger.warn(`dsh-orquestrator: review of ${worker.id} failed: ${failure}`)
    const text = `${bannerFor(false, worker.id, reviewerId, undefined, failure)}\n\n${workerReport}`
    return { kind: 'foreground', runId: worker.id, output: [{ type: 'text', text }] }
  }
  const normalized = normalizeReport(reviewText)
  if (normalized.dropped > 0) {
    deps.logger.info(`dsh-orquestrator: dropped ${String(normalized.dropped)} characters of preamble before the reviewer's verdict (run ${reviewerId ?? 'n/a'})`)
  }
  const verdict = parseVerdict(normalized.text)
  const text = `${bannerFor(true, worker.id, reviewerId, verdict)}\n\n${normalized.text}`
  return { kind: 'foreground', runId: reviewerId ?? worker.id, output: [{ type: 'text', text }] }
}

/** Short, log-safe description of a route. */
export function describeRoute(route: ModelRoute | null): string {
  return route === null ? 'the main agent\'s model' : `${route.provider}/${route.model}${route.reasoningEffort === undefined ? '' : `@${route.reasoningEffort}`}`
}
