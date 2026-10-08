/**
 * Browser HTTP carrier of the host's subagent ledger: which model each
 * subagent runs on and how it ended. The marks on DSH's subagent menu are an
 * extra, so this carrier never raises: a host that predates the route answers
 * 404, a host that is restarting does not answer, and either way the menu just
 * keeps the marks it can draw without the ledger.
 * @module dsh-orquestrator/client/subagents-client
 */

import { SUBAGENTS_ROUTE, parseSubagentsPayload, type SubagentsPayload } from '../shared.ts'
import { hostBase, type Fetch } from './config-client.ts'

/** Per-request deadline: the route is local, so a slow answer means it is not there. */
const REQUEST_TIMEOUT_MS = 5_000

/**
 * A signal that aborts when the caller's signal does or after the deadline, whichever comes first, and a promise
 * that settles at that moment. The promise is what keeps a request from hanging: a `fetch` that ignores its
 * signal never settles, and `abort()` alone cannot make it.
 * @param parent - the caller's signal, if any.
 * @param ms - the deadline in milliseconds.
 * @returns the combined signal, the promise that resolves (to undefined) when it aborts, and the function that releases the timer and the listener.
 */
function withDeadline(parent: AbortSignal | undefined, ms: number): {
  readonly signal: AbortSignal
  readonly expired: Promise<undefined>
  release(): void
} {
  const controller = new AbortController()
  const expired = new Promise<undefined>((resolve) => {
    controller.signal.addEventListener('abort', () => { resolve(undefined) }, { once: true })
  })
  const onParentAbort = (): void => { controller.abort(parent?.reason) }
  const timer = setTimeout(() => { controller.abort(new DOMException('the subagent ledger did not answer in time', 'TimeoutError')) }, ms)
  if (parent?.aborted === true) onParentAbort()
  else parent?.addEventListener('abort', onParentAbort, { once: true })
  return {
    signal: controller.signal,
    expired,
    release() {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onParentAbort)
    },
  }
}

/** HTTP carrier of the host's subagent ledger. */
export class SubagentsClient {
  private readonly fetcher: Fetch
  private readonly base: () => string
  private readonly timeoutMs: number
  private routeMissing = false

  /**
   * @param fetcher - HTTP carrier; defaults to the global `fetch`.
   * @param base - resolver of the host base URL.
   * @param timeoutMs - per-request deadline.
   */
  constructor(
    fetcher: Fetch = (input, init) => fetch(input, init),
    base: () => string = hostBase,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ) {
    this.fetcher = fetcher
    this.base = base
    this.timeoutMs = timeoutMs
  }

  /**
   * Whether the host answered 404: it predates the ledger route (a host older than 0.8). That is remembered for the
   * life of this client, which is the life of the page: the route is not asked for again, because nothing a poll
   * could find out would change. A host that gains the route is picked up by reloading the page, like every
   * other update of this plugin.
   */
  get missing(): boolean {
    return this.routeMissing
  }

  /**
   * Read the subagents started under a session, with their model and outcome.
   * @param sessionId - the session whose subagents (direct and deeper) to list.
   * @param signal - cancellation of the call; the request also has a deadline of its own, which holds even for a `fetch` that ignores its signal.
   * @returns the ledger answer (with the host's clock in `now` when the host sends it), or undefined when it could not be read: a network error, a status that is not OK, an answer that is not JSON, a malformed body, a deadline that passed, or a host that predates the route. Never throws.
   */
  async list(sessionId: string, signal?: AbortSignal): Promise<SubagentsPayload | undefined> {
    if (this.routeMissing || signal?.aborted === true) return undefined
    const deadline = withDeadline(signal, this.timeoutMs)
    try {
      // `race` handles the request's own rejection, early or late, so a request that fails after the deadline is not unhandled.
      return await Promise.race([this.read(sessionId, deadline.signal), deadline.expired])
    } catch {
      return undefined
    } finally {
      deadline.release()
    }
  }

  /** One request and its answer; failures reject, and {@link list} turns them into undefined. */
  private async read(sessionId: string, signal: AbortSignal): Promise<SubagentsPayload | undefined> {
    const url = new URL(SUBAGENTS_ROUTE, this.base())
    url.searchParams.set('sessionId', sessionId)
    const response = await this.fetcher(url, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal,
    })
    if (response.status === 404) {
      this.routeMissing = true
      return undefined
    }
    if (!response.ok) return undefined
    return parseSubagentsPayload(await response.json())
  }
}
