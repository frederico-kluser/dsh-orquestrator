/**
 * dsh-orquestrator, host half.
 *
 * On a task send, the browser half asks the user (in a native-looking modal)
 * whether subagents should run on a different model, and at which reasoning
 * effort. The answer is stored per session through the route below; this half
 * then enforces it in code: the start guard (`guard.ts`) stands in the doors
 * every child DSH starts goes through, whichever tool asked for it (the
 * `subagent` tools, the `workflow` tool, `ralph`, a one-shot background job),
 * and gives the child the chosen model under an effort ceiling and an
 * output-token cap. Cancelling the modal stores nothing and the stock DSH
 * behavior runs untouched.
 *
 * Routes run behind the composition's connection trust fence; trust is asked
 * first, wire validation second, business logic last.
 * @module dsh-orquestrator
 */

import type { Context } from '@deepseek-ai/cordis'
import { parsePluginConfig, removedConfigFields, unknownConfigFields, type Config } from './config.ts'
import type {
  AgentLike, ConnectionLike, LlmLike, ModelInfoSourceLike, SubagentsLike, WebServerLike,
} from './host-services.ts'
import { installGuard } from './guard.ts'
import { registerRoutes } from './routes.ts'
import { ConfigStore, defaultStateFile } from './store.ts'

export type { Config } from './config.ts'

/** Cordis plugin name; stable per composition. */
export const name = 'dsh-orquestrator'

/**
 * Required service: `subagents` (child runs), the one the guard stands in. It
 * therefore works in every profile (web, headless, tui, sdk). The web-only
 * pieces, the config route and its trust fence, are attached through a nested
 * `ctx.inject` and simply do not exist where there is no web server. `logger`
 * is deliberately absent: it is not a Cordis Service, so injecting it would
 * leave the fiber pending forever.
 */
export const inject = ['subagents']

/** Registry slice used to walk a session's lineage. */
interface AgentsLike {
  get(id: string): AgentLike | undefined
}

/**
 * Plugin body: parse config fail-loud, then register the route and the start guard as effects.
 * @param ctx - host context carrying the web composition.
 * @param config - deployment configuration; defaults live in the parser.
 */
export function apply(ctx: Context, config?: Config): void {
  const parsed = parsePluginConfig(config)
  for (const problem of removedConfigFields(config)) ctx.logger.warn(`dsh-orquestrator: ${problem}`)
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
  // A session's direct parent, for the lineage walk of a stored choice.
  const parentOf = (sessionId: string): string | undefined => {
    const agents = ctx.get('agents') as unknown as AgentsLike | undefined
    return agents?.get(sessionId)?.session.header.parentSession
  }
  // Resolved per child start: the LLM runtime may appear after this plugin loads. Not injected on purpose:
  // without it children keep exactly the options the user picked.
  const models = (): ModelInfoSourceLike | undefined => ctx.get('llm') as unknown as ModelInfoSourceLike | undefined

  // The browser-facing route exists only where a web server does; a profile
  // without one still gets the start guard and the `defaults` config.
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

  // Every child DSH starts, whichever tool asked for it, goes through the service itself: the guard stands in that door.
  if (parsed.guard.enabled) {
    ctx.effect(
      () => installGuard({ subagents, store, defaults: parsed.defaults, parentOf, config: parsed, models, logger: ctx.logger }),
      'dsh-orquestrator: start guard',
    )
  }

  ctx.logger.info(
    `dsh-orquestrator: ready (persisted sessions: ${String(store.size)}; effort ceilings: ${parsed.effort.enabled ? 'on' : 'off'}; `
    + `start guard: ${parsed.guard.enabled ? `on, explicit models ${parsed.guard.explicitModel}` : 'off'})`,
  )
}
