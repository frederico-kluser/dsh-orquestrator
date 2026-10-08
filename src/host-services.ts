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

/** One content block of a model-visible message (the guard only passes prompts through). */
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

/** A published one-shot child run (the guard hands it back to the caller untouched). */
export interface SubagentRunLike {
  /** The child session id. */
  readonly id: string
  readonly result: Promise<unknown>
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

/** Invocation controls of a registered skill (`SkillInvocationPolicy`). */
export interface SkillInvocationLike {
  /** Whether the model's skill catalog and `skill` tool include it. */
  readonly modelInvocable: boolean
  /** Whether a `/name` token in the user's message loads it. */
  readonly userInvocable: boolean
}

/** What `ctx.skills.register()` accepts (`SkillRegistration`), narrowed to the fields this plugin sets. */
export interface SkillRegistrationLike {
  /** Kebab-case identifier, also the `/name` token. */
  readonly name: string
  /** Short routing description shown in the model's catalog (it is capped there). */
  readonly description: string
  /** Optional extra routing guidance. */
  readonly whenToUse?: string
  /** The full Markdown instructions: what a load injects. */
  readonly content: string
  /** Origin bucket label. */
  readonly source: string
  /** Invocation controls; omission allows both the model and the user. */
  readonly invocation?: SkillInvocationLike
  /** Absolute path of a SKILL.md on disk, when one exists (it lets the transcript open the file). */
  readonly path?: string
}

/** The `ctx.skills` registry slice (`SkillRegistry`). */
export interface SkillsLike {
  /**
   * Register a runtime skill into the calling context's layer. A duplicate name in one layer is ignored with a warning
   * and gets a no-op disposer, so it cannot remove the winner.
   * @param skill - the skill definition.
   * @returns the disposer that unregisters it.
   */
  register(skill: SkillRegistrationLike): () => void
}

/** Payload of the `subagent/start` event (`SubagentRunInfo`). */
export interface SubagentRunInfoLike {
  /** Identity shared with the paired end event. */
  readonly runId: string
  /** The subagent backend that established the child (`spawn`, `fork`, `acp`, ...). */
  readonly provider: string
  /** The child agent's session id. */
  readonly id: string
  /** Whether the child is an in-process agent with a session of its own (remote backends are not). */
  readonly local: boolean
}

/** Payload of the `subagent/end` event (`SubagentRunEndInfo`). */
export interface SubagentRunEndInfoLike extends SubagentRunInfoLike {
  /** Why the run ended: `completed`, `aborted`, `error`, `max-tokens`, `refusal`, or a reason a backend added. */
  readonly stopReason: string
}

/** The agent registry slice (`ctx.agents`): resolves a live in-process agent by session id. */
export interface AgentRegistryLike {
  get(id: string): AgentLike | undefined
}

/** The Cordis logger slice. */
export interface LoggerLike {
  info(message: string): void
  warn(message: string): void
  debug?(message: string): void
}
