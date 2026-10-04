/**
 * The `tools/execute` around-wrapper that turns a delegation call into an
 * orchestrated one when the user opted in for the calling session.
 *
 * Why this seam: a tool's arguments are immutable once logged, and the stock
 * `subagent` tool runs children in the background (its `continuable` mode
 * hands the result to the parent through the child's own message and a
 * settlement notice). To gate delivery behind a reviewer the wrapper
 * substitutes the tool body's outcome: it returns a value that conforms to the
 * tool's own output schema, and the registry re-validates and renders it, so
 * the model sees an ordinary `subagent` result. Calls with no active choice
 * (the modal was cancelled, or never answered) delegate to `next()` untouched.
 * @module dsh-orquestrator/tool-wrapper
 */

import type {
  LoggerLike, ToolDispatchExecutionLike, ToolExecutionResultLike,
} from './host-services.ts'
import type { DelegationTool } from './config.ts'
import { orchestrate, parseDelegationArgs, type PipelineDeps } from './pipeline.ts'
import { isActive, type OrchestratorConfig } from './shared.ts'
import type { ConfigStore } from './store.ts'

/** Dependencies of the wrapper, resolved once at plugin load. */
export interface WrapperDeps {
  /** Delegation tools to orchestrate, by model-facing tool name. */
  readonly targets: ReadonlyMap<string, DelegationTool>
  /** Per-session choices. */
  readonly store: ConfigStore
  /** Deployment default for sessions with no stored choice (headless), or null. */
  readonly defaults: OrchestratorConfig | null
  /**
   * Resolve a session's direct parent id (lineage walk).
   * @param sessionId - a session id.
   * @returns the parent session id, or undefined for a top-level session.
   */
  readonly parentOf: (sessionId: string) => string | undefined
  /** Pipeline dependencies; resolved lazily so a late service does not fail the plugin. */
  readonly pipeline: () => PipelineDeps
  readonly logger: LoggerLike
  /** Whether the start guard is installed: a one-shot background job is then still governed (the confirmed model and the ceilings), just not reviewed. */
  readonly guarded?: boolean | undefined
}

/**
 * Build the `tools/execute` listener.
 * @param deps - targets, store, lineage resolver and pipeline dependencies.
 * @returns the listener to register on `tools/execute`.
 */
export function createToolWrapper(
  deps: WrapperDeps,
): (exec: ToolDispatchExecutionLike, next: () => Promise<ToolExecutionResultLike>) => Promise<ToolExecutionResultLike> {
  let warnedBackgroundJob = false
  return async (exec, next) => {
    const tool = deps.targets.get(exec.name)
    const agent = exec.agent
    if (tool === undefined || agent === undefined) return next()

    const choice = deps.store.resolve(agent.session.id, deps.parentOf, deps.defaults)
    if (!isActive(choice)) return next()

    let args
    try {
      args = parseDelegationArgs(exec.arguments)
    } catch {
      // Malformed arguments: let the stock tool produce its native validation error.
      return next()
    }

    // A one-shot tool's background JOB path delivers through the job store, so it cannot be reviewed (documented
    // limitation); with the start guard its child is still governed: the confirmed model, if one was picked, and the ceilings.
    if (tool.mode === 'one-shot' && args.runInBackground === true) {
      if (!warnedBackgroundJob) {
        warnedBackgroundJob = true
        deps.logger.warn(deps.guarded === true
          ? `dsh-orquestrator: ${tool.name} with run_in_background on a one-shot tool is not reviewed; its child is still governed by the start guard (the confirmed subagent model, if one was picked, and the ceilings)`
          : `dsh-orquestrator: ${tool.name} with run_in_background on a one-shot tool is not orchestrated; the stock behavior runs`)
      }
      return next()
    }

    const value = await orchestrate(deps.pipeline(), { tool, args, parent: agent, signal: exec.signal, config: choice })
    return { isError: false, value, content: [] }
  }
}
