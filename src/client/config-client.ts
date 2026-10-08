/**
 * Browser HTTP carrier for the per-session configuration route. The browser's
 * same-origin session (cookies, Host/Origin) is what the host's connection
 * trust fence authenticates, exactly like the built-in `/api` traffic.
 * @module dsh-orquestrator/client/config-client
 */

import {
  CONFIG_ROUTE, parseConfig, parseSkillOffer, toWireConfig,
  type ConfigStatePayload, type ConfigWritePayload, type ErrorPayload, type OrchestratorConfig, type SkillOffer,
} from '../shared.ts'

/** The fetch surface the client needs (injectable for tests). */
export type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>

/** Per-request deadline: the route is local, so a slow answer means it is not there. */
const REQUEST_TIMEOUT_MS = 8_000

/** Resolve the browser's Host base with the connection carrier's null-origin fallback. */
export function hostBase(): string {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin
  return origin !== undefined && origin !== 'null' ? origin : 'http://dsh.internal'
}

/** One failed call: the HTTP status plus the server's structured code. */
export class ConfigHttpError extends Error {
  /** HTTP status of the failed call (0 for a network failure). */
  readonly status: number
  /** The server's structured error code, when present. */
  readonly code: ErrorPayload['code'] | undefined

  /**
   * @param status - HTTP status of the failed call (0 for a network failure).
   * @param code - the server's structured error code, when present.
   * @param message - server message, when present.
   */
  constructor(status: number, code: ErrorPayload['code'] | undefined, message: string | undefined) {
    super(message ?? `HTTP ${String(status)}`)
    this.name = 'ConfigHttpError'
    this.status = status
    this.code = code
  }
}

/** What one read of the configuration route tells the browser about a session. */
export interface HostState {
  /** The session's stored configuration; null when none. */
  readonly config: OrchestratorConfig | null
  /** The skill the host offers; null when the host does not say (a host older than the skill), which means "do not offer it". */
  readonly skill: SkillOffer | null
}

/** HTTP carrier of the per-session configuration. */
export class ConfigClient {
  private readonly fetcher: Fetch
  private readonly base: () => string

  /**
   * @param fetcher - HTTP carrier; defaults to the global `fetch`.
   * @param base - resolver of the host base URL.
   */
  constructor(fetcher: Fetch = (input, init) => fetch(input, init), base: () => string = hostBase) {
    this.fetcher = fetcher
    this.base = base
  }

  /**
   * Read a session's stored configuration.
   * @param sessionId - the session.
   * @returns the stored configuration, or null when none.
   * @throws {ConfigHttpError} when the route is unreachable or refuses.
   */
  async load(sessionId: string): Promise<OrchestratorConfig | null> {
    return (await this.loadState(sessionId)).config
  }

  /**
   * Read what the host says about a session in one request: its stored
   * configuration and the skill the host offers.
   * @param sessionId - the session.
   * @returns the stored configuration (null when none) and the skill offer (null when the host does not say).
   * @throws {ConfigHttpError} when the route is unreachable or refuses.
   */
  async loadState(sessionId: string): Promise<HostState> {
    const url = new URL(CONFIG_ROUTE, this.base())
    url.searchParams.set('sessionId', sessionId)
    const payload = await this.call(url, { headers: { accept: 'application/json' } })
    return { config: payload.config, skill: payload.skill }
  }

  /**
   * Store (or clear, with null) a session's configuration.
   * @param sessionId - the session.
   * @param config - the configuration, or null to clear.
   * @returns the configuration as the host stored it.
   * @throws {ConfigHttpError} when the route is unreachable or refuses.
   */
  async save(sessionId: string, config: OrchestratorConfig | null): Promise<OrchestratorConfig | null> {
    // The wire shape every version accepts: a host that was started before this page's plugin update still runs the old
    // half and refuses a configuration without the legacy reviewer block (see `LEGACY_REVIEWER`).
    const body: ConfigWritePayload = { sessionId, config: config === null ? null : toWireConfig(config) }
    const payload = await this.call(new URL(CONFIG_ROUTE, this.base()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return payload.config
  }

  /** One request: bounded time, structured failure, validated success body. */
  private async call(url: URL, init: RequestInit): Promise<ConfigStatePayload> {
    let response: Response
    try {
      response = await this.fetcher(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    } catch (cause: unknown) {
      throw new ConfigHttpError(0, undefined, cause instanceof Error ? cause.message : String(cause))
    }
    const body = (await response.json().catch(() => undefined)) as
      | { sessionId?: unknown; config?: unknown; skill?: unknown; code?: ErrorPayload['code']; message?: string }
      | undefined
    if (!response.ok || body === undefined || !('config' in body)) {
      throw new ConfigHttpError(response.status, body?.code, body?.message)
    }
    const config = body.config === null ? null : parseConfig(body.config)
    if (config === undefined) throw new ConfigHttpError(response.status, 'internal', 'the host answered a malformed configuration')
    return { sessionId: String(body.sessionId ?? ''), config, skill: parseSkillOffer(body.skill) }
  }
}
