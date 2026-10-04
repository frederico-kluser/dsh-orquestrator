/**
 * Narrowed host service contracts the plugin reads across package boundaries.
 * Types only: the real declarations live in the corresponding
 * `@deepseek-ai/dsh-*` packages (tools, subagent, host-webserver, llm), which
 * this plugin never imports at runtime (it loads from an arbitrary directory
 * with no `@deepseek-ai` node_modules of its own). Shapes are mirrored from
 * DSH 0.1.6-alpha.2 and only ever narrowed, never widened.
 * @module dsh-orquestrator/host-services
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** One content block of a model-visible message (text is all this plugin reads or writes). */
export interface ContentBlockLike {
  readonly type: string
  readonly text?: string
}

/** The slice of an LLM route the child creation reads (`AgentOptions`). */
export interface AgentOptionsLike {
  provider?: string
  model?: string
  reasoningEffort?: string
  maxTokens?: number
}

/** The slice of a Session the plugin reads. */
export interface SessionLike {
  readonly id: string
  readonly header: {
    /** Direct parent session id when this session is a subagent child. */
    readonly parentSession?: string
    /** Product origin marker (`subagent` for delegated children). */
    readonly origin?: string
    /** The workspace directory of the session. */
    readonly cwd?: string
  }
  /** Latest logged model request header, when one exists. */
  requestHeader?(): { readonly config?: AgentOptionsLike } | undefined
}

/** The slice of an Agent the plugin reads. */
export interface AgentLike {
  readonly id: string
  readonly session: SessionLike
  /** Creation options; the request header owns the live route once a request ran. */
  readonly options: AgentOptionsLike
}

/** One dispatched tool call as seen by a `tools/execute` around-wrapper. */
export interface ToolDispatchExecutionLike {
  readonly callId: string
  readonly name: string
  /** Losslessly JSON-serializable parsed arguments (each tool validates its own schema). */
  readonly arguments: unknown
  /** The calling agent (absent for non-agent callers). */
  readonly agent?: AgentLike
  /** Cancellation signal: the caller's, fused with any wrapper replacement. */
  signal: AbortSignal
}

/** The normalized outcome a `tools/execute` wrapper returns (the registry re-validates it). */
export type ToolExecutionResultLike =
  | {
    readonly isError: false
    readonly value: unknown
    readonly content: readonly ContentBlockLike[]
  }
  | {
    readonly isError: true
    readonly error: { readonly message: string }
    readonly content: readonly ContentBlockLike[]
  }

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Around-dispatch waterfall of the tool registry: `next()` runs the real
     * tool body; returning without it substitutes the outcome.
     * @param exec - the allowed call about to dispatch.
     * @param next - the rest of the chain, ending in the tool body.
     */
    'tools/execute'(
      exec: ToolDispatchExecutionLike,
      next: () => Promise<ToolExecutionResultLike>,
    ): Promise<ToolExecutionResultLike>
  }
}

/** Terminal outcome of a subagent run. */
export interface SubagentResultLike {
  readonly output: readonly ContentBlockLike[]
  /** `completed`, `aborted`, `error`, `max-tokens`, `refusal`, or a backend-added reason. */
  readonly stopReason: string
  /** Provider-authored, non-assistant failure detail. */
  readonly diagnostic?: string
  /** The value the child reported through the structured-output tool, when the request carried an `outputSchema`. */
  readonly structured?: unknown
}

/** A published one-shot child run. */
export interface SubagentRunLike {
  /** The child session id. */
  readonly id: string
  readonly result: Promise<SubagentResultLike>
  /** Cancel remaining work, reach quiescence, release resources (idempotent). */
  dispose(): Promise<void>
}

/** What a caller asks for when starting a one-shot child. */
export interface SubagentStartRequestLike {
  readonly label?: string
  readonly prompt: readonly ContentBlockLike[]
  readonly parent: AgentLike
  readonly signal: AbortSignal
  readonly agentOptions?: AgentOptionsLike
  readonly maxDepth?: number
  readonly persona?: string
  /** Object-rooted JSON Schema the child must answer through the structured-output tool (DSH `SubagentStartRequest.outputSchema`). */
  readonly outputSchema?: Readonly<Record<string, unknown>>
}

/** Identities returned once a continuable child accepted its first prompt. */
export interface ContinuableStartLike {
  readonly childId: string
}

/** What a caller asks for when starting a continuable child (`ContinuableStartSpec`). */
export interface ContinuableStartSpecLike {
  readonly provider: string
  readonly label: string
  /** Optional caller-reserved child identity. */
  readonly childId?: string
  readonly request: Omit<SubagentStartRequestLike, 'label' | 'signal'>
  readonly signal: AbortSignal
}

/** The `ctx.subagents` service slice (`SubagentRuntime`). */
export interface SubagentsLike {
  /**
   * Establish a published one-shot child on the named provider.
   * @param provider - registered provider name (`spawn`, `fork`, ...).
   * @param request - label, prompt, parent, signal and optional capabilities.
   * @returns the holder-owned run; the caller must dispose it.
   */
  start(provider: string, request: SubagentStartRequestLike): Promise<SubagentRunLike>
  /**
   * Establish a durable continuable child and deliver its first prompt.
   * @param spec - provider, label, delegation request and caller cancellation.
   * @returns the child id once the child's inbox accepted the prompt.
   */
  startContinuable(spec: ContinuableStartSpecLike): Promise<ContinuableStartLike>
  /**
   * Resolve a delegation tool's depth policy against the current user setting.
   * @param configured - explicit tool limit, or provider-managed.
   * @returns the numeric cap, or undefined when the provider owns depth.
   */
  resolveMaxDepth(configured?: number | 'provider-managed'): number | undefined
  /**
   * Look up a provider by name.
   * @param name - provider name.
   * @returns the provider, or undefined when absent.
   */
  getProvider(name: string): {
    readonly capabilities: { readonly agentOptions: boolean; readonly persona: boolean; readonly outputSchema?: boolean }
    /** The provider's own static route, when its children do not run on the parent's (the SDK provider). */
    readonly agentRouteDefaults?: { readonly provider: string; readonly model: string }
  } | undefined
}

/** The web-server slice the plugin registers routes on. */
export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** The connection service's trust-fence slice: every route asks for a rejection first. */
export interface ConnectionLike {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/** The LLM runtime slice used to validate a chosen route before it is stored. */
export interface LlmLike {
  /**
   * Resolve a call configuration through its live adapter; rejects for an
   * unknown provider, model or unsupported effort.
   * @param config - provider, model and optional effort.
   * @param signal - cancellation.
   */
  resolveCallConfig(config: AgentOptionsLike, signal?: AbortSignal): Promise<unknown>
}

/** What `ctx.llm.resolveModelInfo` reports for one exact route (the slice the effort policy reads). */
export interface ModelInfoLike {
  readonly inputModalities?: readonly string[]
  /** The route's configured output-token ceiling per request (reasoning included). */
  readonly defaultMaxTokens?: number
  /** Present only for a model with reasoning levels; `efforts` is in escalation order. */
  readonly reasoning?: {
    readonly efforts: readonly { readonly id: string; readonly name?: string }[]
    readonly defaultEffort?: string
  }
}

/** The LLM runtime slice used to learn a route's reasoning ladder and token ceiling. */
export interface ModelInfoSourceLike {
  /**
   * Resolve one exact route through its live adapter; rejects for an unknown provider or model.
   * @param provider - registered provider id.
   * @param model - exact model id.
   * @param signal - cancellation.
   */
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<ModelInfoLike>
  /**
   * The check that gates storing a route (`LlmLike.resolveCallConfig`): rejects for a route the runtime cannot call.
   * Optional here because the planner does not need it; the confirmed-choice check uses it when it is there.
   * @param config - provider, model and optional effort.
   * @param signal - cancellation.
   */
  resolveCallConfig?(config: AgentOptionsLike, signal?: AbortSignal): Promise<unknown>
}

/** The Cordis logger slice. */
export interface LoggerLike {
  info(message: string): void
  warn(message: string): void
  debug?(message: string): void
}
