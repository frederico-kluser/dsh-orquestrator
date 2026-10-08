/**
 * HTTP surface of the plugin: routes behind the composition's connection
 * trust fence (Host/Origin fence + browser authentication), with wire-level
 * body validation. Trust is asked first, wire validation second, business
 * logic last.
 *
 * - `GET  /dsh-orquestrator/config?sessionId=<id>` reads the stored choice.
 * - `POST /dsh-orquestrator/config` `{ sessionId, config }` stores it, or
 *   clears it when `config` is null. Every success answer also carries the
 *   skill the host offers, when it offers one.
 * - `GET  /dsh-orquestrator/subagents?sessionId=<id>` lists the subagents
 *   started under that session, direct and deeper, with their model and
 *   outcome, and the host's clock. Registered only when a ledger is given.
 * @module dsh-orquestrator/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ConnectionLike, LlmLike, WebServerLike } from './host-services.ts'
import type { ConfigStore } from './store.ts'
import type { SubagentLedger } from './subagents.ts'
import {
  CONFIG_ROUTE, SUBAGENTS_ROUTE, parseConfig, toWireConfig,
  type ConfigWirePayload, type ErrorPayload, type ModelRoute, type OrchestratorConfig, type SkillOffer, type SubagentsPayload,
} from './shared.ts'

/** POST bodies are tiny JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024

/** Longest session id the routes admit. */
const MAX_SESSION_ID_LENGTH = 256

/** Dependencies the routes read through, already resolved from the context. */
export interface RouteDeps {
  readonly store: ConfigStore
  /** The connection trust fence. */
  readonly connection: ConnectionLike
  /** Live LLM runtime, used to reject an unroutable model before storing it. */
  readonly llm?: LlmLike | undefined
  /** Abort signal factory for route validation (injectable for tests). */
  readonly timeoutSignal?: (ms: number) => AbortSignal
  /** The subagent ledger behind the subagents route; without it that route is not registered. */
  readonly ledger?: SubagentLedger
  /**
   * The host's clock, in epoch milliseconds (default `Date.now`). The subagents answer carries it, because the times
   * of its records are this host's: the page judges how long ago a child started against the clock that wrote the
   * time, not against its own.
   */
  readonly now?: () => number
  /**
   * What the host says about the global skill for one conversation, read for every config answer (the registry, and
   * the loader that expands the `/name` token, can change while the plugin runs, and a loader may be mounted for
   * some conversations only). Without it, or when it returns undefined, the answers carry no `skill` at all, exactly
   * as hosts older than the skill wrote them.
   */
  readonly skill?: (sessionId: string) => SkillOffer | undefined
}

/** Uniform JSON answer; state is live (no-store). */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** Structured error answer. */
function sendError(res: ServerResponse, status: number, payload: ErrorPayload): void {
  sendJson(res, status, payload)
}

/** Collect a bounded request body as UTF-8 text; null past the ceiling (stream drained). */
async function readBoundedBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      // Drain the remainder so the refusal is a readable response, not a socket cut.
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/** Parse a `sessionId` value; undefined when absent or unusable. */
function parseSessionId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '' || value.length > MAX_SESSION_ID_LENGTH) return undefined
  return value
}

/** The distinct routes a configuration names (each validated once). */
function routesOf(config: OrchestratorConfig): ModelRoute[] {
  const routes: ModelRoute[] = []
  if (config.subagentModel !== null) routes.push(config.subagentModel)
  return routes
}

/**
 * Ask the trust fence about a request; a rejection is answered with its 401/403 and no body, like the host's own
 * denials.
 * @returns true when the request was refused and answered, so the caller must stop.
 */
function refusedByFence(deps: RouteDeps, req: IncomingMessage, res: ServerResponse): boolean {
  const rejection = deps.connection.requestRejection(req)
  if (rejection === undefined) return false
  res.statusCode = rejection
  res.end()
  return true
}

/**
 * Register the plugin's routes as effect-ready registrations on the
 * composition's web server: the configuration route and, when a ledger is
 * given, the subagents route. Every request passes the trust fence before any
 * logic runs, and the fence's 401/403 is answered without a body, like the
 * host's own denials.
 * @param webServer - the composition's web-server service.
 * @param deps - store, trust fence, optional LLM runtime, optional subagent ledger and optional skill offer.
 * @returns one disposer that removes every route that was registered. When the
 *   second registration throws, the first is removed again and the error is
 *   rethrown: no half-registered state.
 */
export function registerRoutes(webServer: WebServerLike, deps: RouteDeps): () => void {
  const timeoutSignal = deps.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms))
  const now = deps.now ?? Date.now
  /** A config answer plus the skill the host offers for its conversation, when it offers one; otherwise the answer exactly as older hosts wrote it. */
  const withSkill = (payload: ConfigWirePayload): ConfigWirePayload => {
    const offer = deps.skill?.(payload.sessionId)
    return offer === undefined ? payload : { ...payload, skill: offer }
  }

  const disposeConfig = webServer.register({
    kind: 'exact',
    path: CONFIG_ROUTE,
    handler: async (req, res) => {
      if (refusedByFence(deps, req, res)) return

      if (req.method === 'GET') {
        const sessionId = parseSessionId(new URL(String(req.url), 'http://localhost').searchParams.get('sessionId'))
        if (sessionId === undefined) {
          sendError(res, 400, { code: 'bad-request', message: 'sessionId query parameter is required' })
          return
        }
        const stored = deps.store.get(sessionId)
        const payload: ConfigWirePayload = { sessionId, config: stored === undefined ? null : toWireConfig(stored) }
        sendJson(res, 200, withSkill(payload))
        return
      }

      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'GET, POST')
        res.end()
        return
      }

      // Body-format validation at the wire: exactly application/json.
      // String(undefined) is 'undefined', which never matches.
      const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
      if (essence !== 'application/json') {
        sendError(res, 415, { code: 'bad-request', message: 'content-type must be application/json' })
        return
      }
      let text: string | null
      try {
        text = await readBoundedBody(req)
      } catch {
        sendError(res, 400, { code: 'bad-request', message: 'request body unreadable' })
        return
      }
      if (text === null) {
        sendError(res, 413, { code: 'bad-request', message: 'request body is too large' })
        return
      }
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        sendError(res, 400, { code: 'bad-request', message: 'request body must be JSON' })
        return
      }
      const record = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>
      const sessionId = parseSessionId(record['sessionId'])
      if (sessionId === undefined) {
        sendError(res, 400, { code: 'bad-request', message: 'body needs a string "sessionId"' })
        return
      }
      if (!('config' in record)) {
        sendError(res, 400, { code: 'bad-request', message: 'body needs "config" (an object, or null to clear)' })
        return
      }

      if (record['config'] === null) {
        deps.store.clear(sessionId)
        const payload: ConfigWirePayload = { sessionId, config: null }
        sendJson(res, 200, withSkill(payload))
        return
      }

      const config = parseConfig(record['config'])
      if (config === undefined) {
        sendError(res, 422, { code: 'invalid-config', message: 'config does not match the expected shape' })
        return
      }

      // Defense in depth: the modal only offers catalog models, but a stale
      // tab or a hand-written request must not store an unroutable model.
      if (deps.llm !== undefined) {
        for (const route of routesOf(config)) {
          try {
            await deps.llm.resolveCallConfig({
              provider: route.provider,
              model: route.model,
              ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
            }, timeoutSignal(15_000))
          } catch (error: unknown) {
            const detail = error instanceof Error ? error.message : String(error)
            sendError(res, 422, { code: 'invalid-model', message: `${route.provider}/${route.model}: ${detail}` })
            return
          }
        }
      }

      deps.store.set(sessionId, config)
      const payload: ConfigWirePayload = { sessionId, config: toWireConfig(config) }
      sendJson(res, 200, withSkill(payload))
    },
  })

  const ledger = deps.ledger
  if (ledger === undefined) return disposeConfig

  let disposeSubagents: () => void
  try {
    disposeSubagents = webServer.register({
      kind: 'exact',
      path: SUBAGENTS_ROUTE,
      handler: (req, res) => {
        if (refusedByFence(deps, req, res)) return

        if (req.method !== 'GET') {
          res.statusCode = 405
          res.setHeader('allow', 'GET')
          res.end()
          return
        }

        const sessionId = parseSessionId(new URL(String(req.url), 'http://localhost').searchParams.get('sessionId'))
        if (sessionId === undefined) {
          sendError(res, 400, { code: 'bad-request', message: 'sessionId query parameter is required' })
          return
        }
        const payload: SubagentsPayload = { sessionId, subagents: ledger.descendantsOf(sessionId), now: now() }
        sendJson(res, 200, payload)
      },
    })
  } catch (error: unknown) {
    // No half-registered state: the first route must not outlive a failed second registration.
    try {
      disposeConfig()
    } catch {
      // The registration error below is the one to report.
    }
    throw error
  }

  return () => {
    try {
      disposeSubagents()
    } finally {
      disposeConfig()
    }
  }
}
