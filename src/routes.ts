/**
 * HTTP surface of the plugin: one route behind the composition's connection
 * trust fence (Host/Origin fence + browser authentication), with wire-level
 * body validation. Trust is asked first, wire validation second, business
 * logic last.
 *
 * - `GET  /dsh-orquestrator/config?sessionId=<id>` reads the stored choice.
 * - `POST /dsh-orquestrator/config` `{ sessionId, config }` stores it, or
 *   clears it when `config` is null.
 * @module dsh-orquestrator/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ConnectionLike, LlmLike, WebServerLike } from './host-services.ts'
import type { ConfigStore } from './store.ts'
import {
  CONFIG_ROUTE, parseConfig,
  type ConfigStatePayload, type ErrorPayload, type ModelRoute, type OrchestratorConfig,
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
  if (config.reviewer.model !== null) routes.push(config.reviewer.model)
  return routes
}

/**
 * Register the configuration route as an effect-ready registration on the
 * composition's web server. Every request passes the trust fence before any
 * logic runs, and the fence's 401/403 is answered without a body, like the
 * host's own denials.
 * @param webServer - the composition's web-server service.
 * @param deps - store, trust fence and optional LLM runtime.
 * @returns a disposer that removes the route.
 */
export function registerRoutes(webServer: WebServerLike, deps: RouteDeps): () => void {
  const timeoutSignal = deps.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms))

  return webServer.register({
    kind: 'exact',
    path: CONFIG_ROUTE,
    handler: async (req, res) => {
      const rejection = deps.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }

      if (req.method === 'GET') {
        const sessionId = parseSessionId(new URL(String(req.url), 'http://localhost').searchParams.get('sessionId'))
        if (sessionId === undefined) {
          sendError(res, 400, { code: 'bad-request', message: 'sessionId query parameter is required' })
          return
        }
        const payload: ConfigStatePayload = { sessionId, config: deps.store.get(sessionId) ?? null }
        sendJson(res, 200, payload)
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
        const payload: ConfigStatePayload = { sessionId, config: null }
        sendJson(res, 200, payload)
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
      const payload: ConfigStatePayload = { sessionId, config }
      sendJson(res, 200, payload)
    },
  })
}
