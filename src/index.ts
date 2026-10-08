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
 * Two more things ride on the same half. The global agent skill
 * `orchestrate-subagents` is registered with DSH's skill registry (`skill.ts`),
 * so a `/orchestrate-subagents` token in a message loads its instructions and
 * the dialog's checkbox can offer it. And a tracker (`subagents.ts`) turns
 * DSH's `subagent/start` and `subagent/end` events into a small ledger (model,
 * state, stop reason per child) that the browser reads to mark the rows of the
 * subagent dropdown.
 *
 * Routes run behind the composition's connection trust fence; trust is asked
 * first, wire validation second, business logic last.
 * @module dsh-orquestrator
 */

import type { Context } from '@deepseek-ai/cordis'
import { parsePluginConfig, removedConfigFields, unknownConfigFields, type Config } from './config.ts'
import type {
  AgentLike, AgentRegistryLike, ConnectionLike, LlmLike, ModelInfoSourceLike, SkillsLike, SubagentsLike, WebServerLike,
} from './host-services.ts'
import { installGuard } from './guard.ts'
import { registerRoutes } from './routes.ts'
import { SKILL_NAME, type SkillOffer } from './shared.ts'
import { registerOrchestrationSkill } from './skill.ts'
import { ConfigStore, defaultStateFile } from './store.ts'
import { SubagentLedger, defaultLedgerFile, installSubagentTracker, type TrackerDeps } from './subagents.ts'

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

/** The slice of the tools registry the skill offer reads: a tool as one agent sees it, or `undefined` when it does not. */
interface ToolsLike {
  get(name: string, scope?: object): unknown
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
  // What the host knows about the children DSH ran: their model and how each run ended (DSH keeps no outcome).
  const ledger = new SubagentLedger({
    ...parsed.persist ? { file: defaultLedgerFile(parsed.stateDir) } : {},
    logger: ctx.logger,
  })
  // Whether the global skill is registered right now; the config route reports it, so the dialog offers the checkbox
  // only when a `/orchestrate-subagents` token would be expanded.
  let skillAvailable = false
  // The registry only holds the skill. The token is expanded by DSH's `tool-skill`, which a composition may mount per
  // agent preset (the web profile does): a lookup of its `skill` tool without the agent finds nothing there, so it is
  // asked about the conversation's own agent. When it cannot be answered (no tools service, an agent that is not
  // loaded, a lookup that throws) the answer is yes: an offer that does nothing costs less than one never made.
  const loaderMounted = (sessionId: string): boolean => {
    try {
      const tools = ctx.get('tools') as unknown as ToolsLike | undefined
      if (tools === undefined || typeof tools.get !== 'function') return true
      const agent = (ctx.get('agents') as unknown as AgentsLike | undefined)?.get(sessionId)
      return agent === undefined ? true : tools.get('skill', agent) !== undefined
    } catch {
      return true
    }
  }
  const skillOffer = (sessionId: string): SkillOffer | undefined => (
    parsed.skill.enabled ? { name: SKILL_NAME, available: skillAvailable && loaderMounted(sessionId) } : undefined
  )
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
        ledger,
        skill: skillOffer,
        // Resolved per request: the LLM runtime may appear after this plugin loads.
        get llm() { return web.get('llm') as unknown as LlmLike | undefined },
      }),
      'dsh-orquestrator: routes',
    )
  })

  // The global skill goes into the registry wherever there is one (it is not a reason to refuse to load without one).
  if (parsed.skill.enabled) {
    ctx.inject(['skills'], (scope: Context) => {
      const skills = scope.get('skills') as unknown as SkillsLike
      scope.effect(() => {
        const registration = registerOrchestrationSkill(skills, { modelInvocable: parsed.skill.modelInvocable }, ctx.logger)
        skillAvailable = registration.available
        return () => {
          skillAvailable = false
          registration.dispose()
        }
      }, 'dsh-orquestrator: skill')
    })
  }

  // Every child DSH starts, whichever tool asked for it, goes through the service itself: the guard stands in that door.
  // It is installed before the optional parts below, so that nothing which can fail there ever leaves it out.
  if (parsed.guard.enabled) {
    ctx.effect(
      () => installGuard({ subagents, store, defaults: parsed.defaults, parentOf, config: parsed, models, logger: ctx.logger }),
      'dsh-orquestrator: start guard',
    )
  }

  // Every in-process child announces itself and its end with `subagent/start` and `subagent/end`, whichever tool started it.
  // Showing the model and state of subagents is a convenience: if the listeners cannot be installed, say so and go on.
  try {
    ctx.effect(
      () => installSubagentTracker({
        ctx: ctx as unknown as TrackerDeps['ctx'],
        agents: () => ctx.get('agents') as unknown as AgentRegistryLike | undefined,
        ledger,
        logger: ctx.logger,
      }),
      'dsh-orquestrator: subagent tracker',
    )
  } catch (error: unknown) {
    ctx.logger.warn(`dsh-orquestrator: could not install the subagent tracker (${error instanceof Error ? error.message : String(error)}); the model and state of subagents will not be shown, nothing else is affected`)
  }

  ctx.logger.info(
    `dsh-orquestrator: ready (persisted sessions: ${String(store.size)}; effort ceilings: ${parsed.effort.enabled ? 'on' : 'off'}; `
    + `start guard: ${parsed.guard.enabled ? `on, explicit models ${parsed.guard.explicitModel}` : 'off'}; `
    + `skill: ${parsed.skill.enabled ? `on, ${parsed.skill.modelInvocable ? 'in the model catalog' : 'token only'}` : 'off'}; `
    + `tracked subagents: ${String(ledger.size)})`,
  )
}
