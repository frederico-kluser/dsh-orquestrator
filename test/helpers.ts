import type { AgentLike, ContentBlockLike, SubagentRunLike, SubagentStartRequestLike, SubagentsLike } from '../src/host-services.ts'

/** A minimal agent double. */
export function fakeAgent(id = 'parent-1', parentSession?: string): AgentLike {
  return {
    id,
    session: { id, header: { ...parentSession === undefined ? {} : { parentSession } } },
    options: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  }
}

/** What a scripted run settles with (the guard hands runs back untouched; the doubles keep the shape DSH uses). */
export interface FakeResult {
  readonly output: readonly ContentBlockLike[]
  readonly stopReason: string
  readonly diagnostic?: string
}

/** A text result. */
export function textResult(text: string, stopReason = 'completed', diagnostic?: string): FakeResult {
  return { output: [{ type: 'text', text }], stopReason, ...diagnostic === undefined ? {} : { diagnostic } }
}

/** One recorded one-shot start. */
export interface RecordedStart {
  readonly provider: string
  readonly request: SubagentStartRequestLike
  readonly run: FakeRun
}

/** A run double: settles with the scripted result and records disposal. */
export class FakeRun implements SubagentRunLike {
  disposed = 0
  readonly id: string
  readonly result: Promise<FakeResult>

  constructor(id: string, result: FakeResult | Error) {
    this.id = id
    this.result = result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
    this.result.catch(() => undefined)
  }

  dispose(): Promise<void> {
    this.disposed += 1
    return Promise.resolve()
  }
}

/** Options of the subagents double. */
export interface FakeSubagentsOptions {
  /** Scripted results, consumed in start order; each may inspect the request. */
  readonly results: (FakeResult | Error | ((request: SubagentStartRequestLike, provider: string) => FakeResult | Error))[]
  /** Provider capabilities; defaults to a spawn-like provider that supports everything. */
  readonly capabilities?: Record<string, { agentOptions: boolean; persona: boolean; outputSchema?: boolean } | undefined>
  /** Providers that run on a route of their own (the SDK provider), by name. */
  readonly routeDefaults?: Record<string, { provider: string; model: string }>
  /** Throw this on `start` number N (0-based) instead of returning a run. */
  readonly failStartAt?: { readonly index: number; readonly error: Error }
}

/** A `SubagentsLike` double that records every call. */
export class FakeSubagents implements SubagentsLike {
  readonly starts: RecordedStart[] = []
  readonly continuables: { provider: string; label: string; request: unknown; signal: AbortSignal }[] = []
  private nextChild = 1
  private readonly options: FakeSubagentsOptions

  constructor(options: FakeSubagentsOptions) {
    this.options = options
  }

  start(provider: string, request: SubagentStartRequestLike): Promise<SubagentRunLike> {
    const index = this.starts.length
    if (this.options.failStartAt?.index === index) return Promise.reject(this.options.failStartAt.error)
    const scripted = this.options.results[index]
    if (scripted === undefined) return Promise.reject(new Error(`no scripted result for start #${String(index)}`))
    const outcome = typeof scripted === 'function' ? scripted(request, provider) : scripted
    const run = new FakeRun(`run-${String(index + 1)}`, outcome)
    this.starts.push({ provider, request, run })
    return Promise.resolve(run)
  }

  startContinuable(spec: { provider: string; label: string; request: Omit<SubagentStartRequestLike, 'label' | 'signal'>; signal: AbortSignal }): Promise<{ childId: string }> {
    this.continuables.push(spec)
    const childId = `child-${String(this.nextChild)}`
    this.nextChild += 1
    return Promise.resolve({ childId })
  }

  getProvider(name: string): { capabilities: { agentOptions: boolean; persona: boolean; outputSchema?: boolean }; agentRouteDefaults?: { provider: string; model: string } } | undefined {
    const configured = this.options.capabilities
    const routeDefaults = this.options.routeDefaults?.[name]
    const route = routeDefaults === undefined ? {} : { agentRouteDefaults: routeDefaults }
    if (configured !== undefined && name in configured) {
      const capabilities = configured[name]
      return capabilities === undefined ? undefined : { capabilities, ...route }
    }
    return { capabilities: { agentOptions: true, persona: true }, ...route }
  }
}

/** Collect the text of a request prompt. */
export function promptText(blocks: readonly ContentBlockLike[]): string {
  return blocks.map(block => block.text ?? '').join('')
}
