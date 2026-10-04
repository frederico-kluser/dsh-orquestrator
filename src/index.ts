/**
 * dsh-orquestrator, host half.
 *
 * On a task send, the browser half asks the user (in a native-looking modal)
 * whether subagents should run on a different model and whether an
 * independent reviewer should validate each subagent's work. The answer is
 * stored per session through the route below; this half then applies it twice:
 * a `tools/execute` wrapper runs a `subagent` / `subagent_fork` delegation on
 * the chosen route and, with the reviewer on, hands the worker's report to a
 * reviewer that delivers the final result to the main agent; and the start
 * guard (`guard.ts`) puts every other child, such as the agents a `workflow`
 * starts, on the same model under the same ceilings. Cancelling the modal
 * stores nothing and the stock DSH behavior runs untouched.
 *
 * Routes run behind the composition's connection trust fence; trust is asked
 * first, wire validation second, business logic last.
 * @module dsh-orquestrator
 */

import type { Context } from '@deepseek-ai/cordis'
import { parsePluginConfig, unknownConfigFields, type Config } from './config.ts'
import type {
  AgentLike, ConnectionLike, LlmLike, ModelInfoSourceLike, SubagentsLike, WebServerLike,
} from './host-services.ts'
import { installGuard } from './guard.ts'
import { registerRoutes } from './routes.ts'
import { ConfigStore, defaultStateFile } from './store.ts'
import { createToolWrapper } from './tool-wrapper.ts'

export type { Config } from './config.ts'

/** Cordis plugin name; stable per composition. */
export const name = 'dsh-orquestrator'

/**
 * Required services: `tools` (owner of the `tools/execute` waterfall) and
 * `subagents` (child runs). The delegation wrapper therefore works in every
 * profile (web, headless, tui, sdk). The web-only pieces, the config route and
 * its trust fence, are attached through a nested `ctx.inject` and simply do
 * not exist where there is no web server. `logger` is deliberately absent: it
 * is not a Cordis Service, so injecting it would leave the fiber pending forever.
 */
export const inject = ['tools', 'subagents']

/** Registry slice used to walk a session's lineage. */
interface AgentsLike {
  get(id: string): AgentLike | undefined
}

/**
 * Plugin body: parse config fail-loud, then register the route and the
 * delegation wrapper as effects.
 * @param ctx - host context carrying the web composition.
 * @param config - deployment configuration; defaults live in the parser.
 */
export function apply(ctx: Context, config?: Config): void {
  const parsed = parsePluginConfig(config)
  for (const problem of unknownConfigFields(config)) ctx.logger.warn(`dsh-orquestrator: ${problem}`)
  const subagents = ctx.get('subagents') as unknown as SubagentsLike | undefined

  // Fail loud at load: an injected service that resolves to nothing means the
  // plugin mounted where it cannot be hosted.
  if (subagents === undefined) {
    throw new Error('dsh-orquestrator: the required `subagents` service is missing; this plugin needs a composition with delegation')
  }

  const store = new ConfigStore({
    ...parsed.persist ? { file: defaultStateFile(parsed.stateDir) } : {},
    maxSessions: parsed.maxSessions,
    logger: ctx.logger,
  })
  const targets = new Map(parsed.tools.map(tool => [tool.name, tool] as const))
  // A session's direct parent, for the lineage walk of a stored choice.
  const parentOf = (sessionId: string): string | undefined => {
    const agents = ctx.get('agents') as unknown as AgentsLike | undefined
    return agents?.get(sessionId)?.session.header.parentSession
  }
  // Resolved per delegation: the LLM runtime may appear after this plugin loads. Not injected on purpose:
  // without it children keep exactly the options the user picked.
  const models = (): ModelInfoSourceLike | undefined => ctx.get('llm') as unknown as ModelInfoSourceLike | undefined

  // The browser-facing route exists only where a web server does; a profile
  // without one still gets the delegation wrapper and the `defaults` config.
  ctx.inject(['webServer', 'connection'], (web: Context) => {
    const webServer = web.get('webServer') as unknown as WebServerLike
    const connection = web.get('connection') as unknown as ConnectionLike
    web.effect(
      () => registerRoutes(webServer, {
        store,
        connection,
        // Resolved per request: the LLM runtime may appear after this plugin loads.
        get llm() { return web.get('llm') as unknown as LlmLike | undefined },
      }),
      'dsh-orquestrator: routes',
    )
  })

  const wrapper = createToolWrapper({
    targets,
    store,
    defaults: parsed.defaults,
    parentOf,
    pipeline: () => ({ subagents, config: parsed, logger: ctx.logger, models }),
    logger: ctx.logger,
    guarded: parsed.guard.enabled,
  })
  ctx.effect(() => ctx.on('tools/execute', wrapper), 'dsh-orquestrator: delegation wrapper')

  // Every other way DSH starts a child (the workflow tool, ralph, a one-shot background job, agent teams) goes
  // through the service itself, not through a delegation tool: the guard stands in that door.
  if (parsed.guard.enabled) {
    ctx.effect(
      () => installGuard({ subagents, store, defaults: parsed.defaults, parentOf, config: parsed, models, logger: ctx.logger }),
      'dsh-orquestrator: start guard',
    )
  }

  ctx.logger.info(
    `dsh-orquestrator: ready (tools: ${[...targets.keys()].join(', ')}; persisted sessions: ${String(store.size)}; `
    + `effort ceilings: ${parsed.effort.enabled ? 'on' : 'off'}; reviewer context: ${parsed.reviewerContext}; `
    + `start guard: ${parsed.guard.enabled ? `on, explicit models ${parsed.guard.explicitModel}` : 'off'})`,
  )
}
