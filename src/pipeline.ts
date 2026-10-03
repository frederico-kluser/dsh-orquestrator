/**
 * The orchestrated delegation: run the worker subagent on the route the user
 * picked, then hand the review to an independent reviewer that validates the
 * work, fixes only real defects, and DELIVERS the final report. The worker's
 * own output never reaches the main agent in reviewed mode.
 *
 * What the plugin adds around DSH's own delegation:
 * - every child gets a reasoning-effort ceiling and an output-token cap
 *   (`effort.ts`), because DSH otherwise runs a re-routed child at the route's
 *   default (`max` on the deployments this targets);
 * - a worker that stops at its token limit is retried once, one level lower;
 * - the reviewer judges the workspace, not the worker's story, whenever the
 *   working tree changed (`workspace.ts`), and answers through DSH's
 *   structured-output tool when the provider has one;
 * - the report is checked against itself before it is delivered.
 *
 * Failure policy (fail toward the user's work, never toward silence):
 * - worker did not complete: the failure is reported exactly like the stock
 *   `subagent` tool would (partial output preserved), with no review;
 * - reviewer failed, or returned no valid verdict: the worker's report is
 *   delivered under an explicit UNREVIEWED banner so the main agent knows it
 *   was never verified;
 * - the caller cancelled: cancellation propagates, nothing is delivered.
 * @module dsh-orquestrator/pipeline
 */

import type {
  AgentLike, AgentOptionsLike, ContentBlockLike, LoggerLike, ModelInfoSourceLike,
  SubagentResultLike, SubagentRunLike, SubagentStartRequestLike, SubagentsLike,
} from './host-services.ts'
import type { DelegationTool, PluginConfig } from './config.ts'
import { planChild, type ChildPlan, type ChildPolicy } from './effort.ts'
import { lowerEffort } from './models.ts'
import type { ModelRoute, OrchestratorConfig } from './shared.ts'
import {
  REVIEW_SCHEMA, buildReviewerPacket, normalizeReport, parseReview, parseVerdict, reconcile, renderReview,
  reviewerPersona, sanitize, withHandoffContract, withRetryNote, type Reconciled, type Review, type Verdict,
} from './reviewer-protocol.ts'
import { defaultIo, describeFacts, diffSnapshots, snapshotWorkspace, type WorkspaceFacts, type WorkspaceIo } from './workspace.ts'

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
  /** The LLM runtime, resolved per delegation (it may appear after the plugin loads). Without it children keep the user's pick untouched. */
  readonly models?: (() => ModelInfoSourceLike | undefined) | undefined
  /** Git and file-system access for the workspace fingerprints; defaults to the real ones. */
  readonly workspaceIo?: WorkspaceIo | undefined
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

/** The effort and token policy of a configuration. */
function policyOf(config: PluginConfig): ChildPolicy {
  return { enabled: config.effort.enabled, caps: config.effort.caps, maxTokens: { worker: config.limits.worker, reviewer: config.limits.reviewer } }
}

/** A route without the effort the user picked for another role. */
function bareRoute(route: ModelRoute | null): ModelRoute | null {
  return route === null ? null : { provider: route.provider, model: route.model }
}

/** One finished child run. */
interface Finished {
  readonly id: string
  readonly result: SubagentResultLike
}

/** Start one child and wait for it, always disposing it. */
async function runToEnd(subagents: SubagentsLike, provider: string, request: SubagentStartRequestLike): Promise<Finished> {
  const run = await subagents.start(provider, request)
  return { id: run.id, result: await settle(run) }
}

/** The worker's outcome. */
interface WorkerOutcome extends Finished {
  /** Whether the first attempt ran out of tokens and a second ran one level lower. */
  readonly retried: boolean
}

/**
 * Run the worker, once, and once more one reasoning level lower when it ran
 * out of tokens while thinking (the failure a ceiling on the effort cannot
 * always prevent). A retry needs a ladder to step down, so it only happens
 * when the model was described.
 * @param deps - host services and configuration.
 * @param tool - the delegation tool.
 * @param plan - the worker's plan.
 * @param request - the request of the first attempt.
 * @param signal - cancellation.
 * @returns the last attempt.
 */
async function runWorker(
  deps: PipelineDeps,
  tool: DelegationTool,
  plan: ChildPlan,
  request: SubagentStartRequestLike,
  signal: AbortSignal,
): Promise<WorkerOutcome> {
  const first = await runToEnd(deps.subagents, tool.provider, request)
  if (first.result.stopReason !== 'max-tokens' || !deps.config.retryOnTokenLimit || signal.aborted) return { ...first, retried: false }
  const lower = plan.ladder === undefined ? undefined : lowerEffort(plan.ladder, plan.effective)
  if (lower === undefined) return { ...first, retried: false }
  deps.logger.warn(`dsh-orquestrator: worker ${first.id} hit its token limit at effort ${plan.effective ?? 'default'}; retrying once at ${lower}`)
  const retry: SubagentStartRequestLike = {
    ...request,
    prompt: [{ type: 'text', text: withRetryNote(flattenText(request.prompt)) }],
    agentOptions: { ...request.agentOptions, reasoningEffort: lower },
  }
  const second = await runToEnd(deps.subagents, tool.provider, retry)
  return { ...second, retried: true }
}

/** What the reviewer left, once interpreted. */
type ReviewOutcome =
  | { readonly kind: 'structured'; readonly review: Review; readonly reconciled: Reconciled }
  | { readonly kind: 'text'; readonly text: string; readonly verdict: Verdict; readonly dropped: number }
  | { readonly kind: 'failed'; readonly reason: string; readonly notes?: string }

/**
 * Interpret the reviewer's result. A structured report is the preferred path;
 * a model that ignored the tool and wrote a verdict-first text report is read
 * as text; anything else is a failed review.
 * @param result - the reviewer's terminal result.
 * @param structuredRequested - whether the request carried the report schema.
 * @returns the interpreted outcome.
 */
function interpretReview(result: SubagentResultLike, structuredRequested: boolean): ReviewOutcome {
  if (structuredRequested && result.structured !== undefined) {
    const review = parseReview(result.structured)
    if (review !== undefined) return { kind: 'structured', review, reconciled: reconcile(review) }
  }
  const text = flattenText(result.output).trim()
  // DSH settles a structured run that ended in plain text as `error`; the text may still be a good report.
  const textMayStand = result.stopReason === 'completed' || (structuredRequested && result.structured === undefined && result.stopReason === 'error' && text !== '')
  if (!textMayStand) return { kind: 'failed', reason: stopReasonHeadline(result.stopReason) }
  if (text === '') return { kind: 'failed', reason: 'the reviewer left no report' }
  const normalized = normalizeReport(text)
  const verdict = parseVerdict(normalized.text)
  if (verdict === undefined) return { kind: 'failed', reason: 'the reviewer returned no valid verdict', notes: normalized.text }
  return { kind: 'text', text: normalized.text, verdict, dropped: normalized.dropped }
}

/** The banner naming what happened, prepended to the delivery. */
function reviewedBanner(workerId: string, reviewerId: string | undefined, verdict: Verdict, extra: readonly string[]): string {
  return `Reviewed delivery: a subagent (session ${workerId}) did the work and an independent reviewer (session ${reviewerId ?? 'n/a'}) verified it`
    + ` [verdict: ${verdict}]. The report below was written by the reviewer; treat it as the result of the delegated task.`
    + `${extra.length === 0 ? '' : ` ${extra.join(' ')}`}`
}

/** The banner of a delivery nobody verified. */
function unreviewedBanner(workerId: string, failure: string): string {
  return `WARNING - UNREVIEWED: the independent review did not complete (${failure}). Below is the raw report of the subagent `
    + `(session ${workerId}). Its claims were NOT verified; check the work yourself before relying on it.`
}

/**
 * Decide whether the reviewer gets the worker's report.
 * @param mode - the configured mode.
 * @param facts - what the working tree did while the worker ran, when it could be measured.
 * @returns `withheld` for a clean-context review, `claims` to hand the report over as untrusted data.
 */
export function decideReportMode(mode: PluginConfig['reviewerContext'], facts: WorkspaceFacts | undefined): 'claims' | 'withheld' {
  if (mode === 'claims') return 'claims'
  if (mode === 'isolated') return 'withheld'
  return facts !== undefined && facts.changed.length > 0 ? 'withheld' : 'claims'
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
  const source = deps.models?.()
  const policy = policyOf(config)
  const workerPlan = await planChild({
    source, parent, route: workerRoute, role: 'worker', policy, signal, logger,
    explicitEffort: choice.workerEffort ?? workerRoute?.reasoningEffort,
  })
  logger.info(`dsh-orquestrator: ${workerPlan.summary}`)
  // A provider that cannot take agent options keeps the user's pick (rejected above) and nothing else.
  const workerOptions = subagents.getProvider(tool.provider)?.capabilities.agentOptions === true ? workerPlan.options : undefined
  const base = {
    parent,
    ...workerOptions === undefined ? {} : { agentOptions: workerOptions },
    ...maxDepth === undefined ? {} : { maxDepth },
  }

  // Model override only: keep the stock scheduling, change nothing but the route and its ceilings.
  if (!choice.reviewer.enabled) {
    const request = { ...base, prompt: [{ type: 'text', text: args.prompt }] satisfies ContentBlockLike[] }
    if (tool.mode === 'continuable' && args.runInBackground !== false) {
      const started = await subagents.startContinuable({ provider: tool.provider, label: args.description, request, signal })
      logger.info(`dsh-orquestrator: ${tool.name} -> continuable ${started.childId} on ${describeRoute(workerRoute)}`)
      return { kind: 'continuable', subagentId: started.childId }
    }
    const worker = await runWorker(deps, tool, workerPlan, { ...request, label: args.description, signal }, signal)
    if (worker.result.stopReason !== 'completed') throw new Error(failureMessage(worker.result))
    return { kind: 'foreground', runId: worker.id, output: [{ type: 'text', text: flattenText(worker.result.output) }] }
  }

  // Reviewed mode: the worker's output is an internal artifact, not a delivery.
  const workerPrompt = config.workerHandoff ? withHandoffContract(args.prompt) : args.prompt
  const io = deps.workspaceIo ?? defaultIo
  const cwd = parent.session.header.cwd
  const measure = config.workspaceChecks && config.reviewerContext !== 'claims'
  const before = measure ? await snapshotWorkspace(cwd, io, signal) : undefined

  const worker = await runWorker(deps, tool, workerPlan, {
    ...base,
    label: args.description,
    prompt: [{ type: 'text', text: workerPrompt }],
    signal,
  }, signal)
  signal.throwIfAborted()
  if (worker.result.stopReason !== 'completed') throw new Error(failureMessage(worker.result))
  const workerReport = sanitize(flattenText(worker.result.output))

  const after = before === undefined ? undefined : await snapshotWorkspace(cwd, io, signal)
  if (before !== undefined && !before.ok) logger.info(`dsh-orquestrator: workspace not measured (${before.reason}); the reviewer gets the worker's report`)
  const facts = before === undefined || after === undefined ? undefined : diffSnapshots(before, after, config.sensitivePaths)
  const report = decideReportMode(config.reviewerContext, facts)

  const reviewerRoute = bareRoute(choice.reviewer.model ?? workerRoute)
  logger.info(
    `dsh-orquestrator: ${tool.name} worker ${worker.id} (${describeRoute(workerRoute)}) done${worker.retried ? ' after one retry' : ''}; `
    + `reviewing on ${describeRoute(reviewerRoute)} with ${report === 'withheld' ? 'a clean context' : 'the worker report as claims'}`,
  )

  let reviewerId: string | undefined
  let outcome: ReviewOutcome
  try {
    const reviewerProvider = subagents.getProvider(config.reviewerProvider)
    if (reviewerProvider === undefined) throw new Error(`reviewer provider "${config.reviewerProvider}" is not registered`)
    if (reviewerRoute !== null && !reviewerProvider.capabilities.agentOptions) {
      throw new Error(`reviewer provider "${config.reviewerProvider}" cannot run on another model`)
    }
    const structured = config.structuredVerdict && reviewerProvider.capabilities.outputSchema === true
    const reviewerPlan = await planChild({
      source, parent, route: reviewerRoute, role: 'reviewer', policy, signal, logger,
      explicitEffort: choice.reviewer.effort ?? choice.reviewer.model?.reasoningEffort,
    })
    logger.info(`dsh-orquestrator: ${reviewerPlan.summary}`)
    const reviewerOptions = reviewerProvider.capabilities.agentOptions ? reviewerPlan.options : undefined
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
          report,
          facts: facts === undefined ? undefined : describeFacts(facts),
        }),
      }],
      ...reviewerProvider.capabilities.persona ? { persona: reviewerPersona(structured) } : {},
      ...reviewerOptions === undefined ? {} : { agentOptions: reviewerOptions },
      ...structured ? { outputSchema: REVIEW_SCHEMA } : {},
      ...maxDepth === undefined ? {} : { maxDepth },
      signal,
    })
    reviewerId = reviewer.id
    const reviewResult = await settle(reviewer)
    signal.throwIfAborted()
    outcome = interpretReview(reviewResult, structured)
  } catch (error: unknown) {
    // A caller cancellation is not a review failure: it aborts the delivery.
    signal.throwIfAborted()
    outcome = { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }

  const retried = worker.retried ? ['The worker ran out of tokens once and was restarted one reasoning level lower.'] : []
  if (outcome.kind === 'failed') {
    logger.warn(`dsh-orquestrator: review of ${worker.id} failed: ${outcome.reason}`)
    const notes = outcome.notes === undefined ? '' : `\n\nThe reviewer's own text, without a valid verdict (treat as unverified notes):\n${outcome.notes}`
    const text = `${unreviewedBanner(worker.id, outcome.reason)}\n\n${workerReport}${notes}`
    return { kind: 'foreground', runId: worker.id, output: [{ type: 'text', text }] }
  }
  if (outcome.kind === 'text') {
    if (outcome.dropped > 0) {
      logger.info(`dsh-orquestrator: dropped ${String(outcome.dropped)} characters of preamble before the reviewer's verdict (run ${reviewerId ?? 'n/a'})`)
    }
    const text = `${reviewedBanner(worker.id, reviewerId, outcome.verdict, retried)}\n\n${outcome.text}`
    return { kind: 'foreground', runId: reviewerId ?? worker.id, output: [{ type: 'text', text }] }
  }
  const { reconciled, review } = outcome
  const notes = [
    ...reconciled.original === undefined ? [] : [`The orchestrator corrected the verdict from ${reconciled.original} to ${reconciled.verdict}.`],
    ...reconciled.cautions.map(caution => `Caution: ${caution}.`),
    ...retried,
  ]
  if (reconciled.original !== undefined || reconciled.cautions.length > 0) {
    logger.warn(`dsh-orquestrator: review ${reviewerId ?? 'n/a'} ${reconciled.original === undefined ? 'carries cautions' : `verdict corrected from ${reconciled.original}`}: ${reconciled.cautions.join('; ')}`)
  }
  const text = `${reviewedBanner(worker.id, reviewerId, reconciled.verdict, notes)}\n\n${renderReview(review, reconciled.verdict)}`
  return { kind: 'foreground', runId: reviewerId ?? worker.id, output: [{ type: 'text', text }] }
}

/** Short, log-safe description of a route. */
export function describeRoute(route: ModelRoute | null): string {
  return route === null ? 'the main agent\'s model' : `${route.provider}/${route.model}${route.reasoningEffort === undefined ? '' : `@${route.reasoningEffort}`}`
}
