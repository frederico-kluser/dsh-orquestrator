/**
 * Dialog coordination: one modal at a time across the page, requests queued
 * FIFO, and a presenter registry so a request is only raised when some
 * composer for that session is mounted to render it (otherwise the gate fails
 * open instead of waiting for a dialog nobody can show).
 * @module dsh-orquestrator/client/dialogs
 */

import type { OrchestratorConfig } from '../shared.ts'
import { createStore, type Observable } from './observable.ts'

/** Why the dialog is open. */
export type DialogMode =
  /** Raised by a task send; the send waits for the answer. */
  | 'gate'
  /** Raised by the `/orquestrar` command; nothing waits. */
  | 'configure'

/** How the dialog ended. */
export type DialogResult =
  | { readonly kind: 'confirm'; readonly config: OrchestratorConfig }
  | { readonly kind: 'cancel' }

/** What a caller supplies to raise a dialog. */
export interface DialogInput {
  readonly sessionId: string
  readonly mode: DialogMode
  /** Single-line preview of the task being sent (gate mode). */
  readonly preview: string
  /** Values the dialog opens with. */
  readonly initial: OrchestratorConfig
  /**
   * Persist the answer on the host: a configuration on confirm, null on a
   * gate-mode cancel (the stock behavior must win for this task).
   */
  readonly save: (config: OrchestratorConfig | null) => Promise<void>
}

/** A raised dialog as the renderer sees it. */
export interface DialogRequest extends DialogInput {
  readonly id: number
  /** Finish the dialog with an answer (idempotent). */
  readonly resolve: (result: DialogResult) => void
}

/** A request waiting for its turn or its answer. */
interface Pending {
  readonly request: DialogRequest
  readonly settle: (result: DialogResult) => void
}

/** Coordinates the page's single modal. */
export class DialogHost {
  /** The dialog on screen, or null. */
  readonly current: Observable<DialogRequest | null>
  /** Bumps whenever a presenter registers or leaves, so mounted composers re-check who presents. */
  readonly presence: Observable<number>
  private readonly currentStore = createStore<DialogRequest | null>(null)
  private readonly presenceStore = createStore(0)
  private readonly queue: Pending[] = []
  private readonly presenters = new Map<string, Set<symbol>>()
  private nextId = 1

  constructor() {
    this.current = this.currentStore
    this.presence = this.presenceStore
  }

  /**
   * Raise a dialog. Resolves with the user's answer; an aborted signal
   * resolves as a cancel (a superseded send must not leave a dialog behind).
   * @param input - session, mode, preview, initial values and persistence.
   * @param signal - optional cancellation of the surrounding operation.
   * @returns the answer.
   */
  request(input: DialogInput, signal?: AbortSignal): Promise<DialogResult> {
    return new Promise<DialogResult>((resolvePromise) => {
      let done = false
      const settle = (result: DialogResult): void => {
        if (done) return
        done = true
        signal?.removeEventListener('abort', onAbort)
        resolvePromise(result)
      }
      const request: DialogRequest = {
        ...input,
        id: this.nextId++,
        resolve: (result) => { this.finish(pending, result) },
      }
      const pending: Pending = { request, settle }
      const onAbort = (): void => { this.finish(pending, { kind: 'cancel' }) }
      if (signal?.aborted === true) {
        settle({ kind: 'cancel' })
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.queue.push(pending)
      this.advance()
    })
  }

  /**
   * Register a mounted composer as able to render dialogs for a session.
   * @param sessionId - the composer's session.
   * @param token - a unique token identifying the mount.
   * @returns the unregister function.
   */
  registerPresenter(sessionId: string, token: symbol): () => void {
    const tokens = this.presenters.get(sessionId) ?? new Set<symbol>()
    tokens.add(token)
    this.presenters.set(sessionId, tokens)
    this.presenceStore.set(this.presenceStore.getSnapshot() + 1)
    return () => {
      const set = this.presenters.get(sessionId)
      if (set === undefined) return
      set.delete(token)
      if (set.size === 0) this.presenters.delete(sessionId)
      this.presenceStore.set(this.presenceStore.getSnapshot() + 1)
      // A dialog whose last presenter left can no longer be answered: cancel it.
      const active = this.currentStore.getSnapshot()
      if (active?.sessionId === sessionId && !this.presenters.has(sessionId)) active.resolve({ kind: 'cancel' })
    }
  }

  /**
   * Whether any mounted composer can render a dialog for the session.
   * @param sessionId - the session.
   * @returns true when at least one presenter is registered.
   */
  hasPresenter(sessionId: string): boolean {
    return (this.presenters.get(sessionId)?.size ?? 0) > 0
  }

  /**
   * Whether a given mount is THE presenter of the session (the first one
   * registered renders; later mounts of the same session stay silent so the
   * dialog never doubles).
   * @param sessionId - the session.
   * @param token - the mount's token.
   * @returns true when the token is the session's presenter.
   */
  isPresenter(sessionId: string, token: symbol): boolean {
    const first = this.presenters.get(sessionId)?.values().next()
    return first?.done === false && first.value === token
  }

  /** Finish one request and start the next queued one. */
  private finish(pending: Pending, result: DialogResult): void {
    const active = this.currentStore.getSnapshot()
    if (active === pending.request) this.currentStore.set(null)
    const index = this.queue.indexOf(pending)
    if (index >= 0) this.queue.splice(index, 1)
    pending.settle(result)
    this.advance()
  }

  /** Put the head of the queue on screen when nothing is. */
  private advance(): void {
    if (this.currentStore.getSnapshot() !== null) return
    const head = this.queue[0]
    if (head !== undefined) this.currentStore.set(head.request)
  }
}
