/**
 * Dialog coordination: one modal at a time across the page, requests queued
 * FIFO, and a presenter registry so a request is only ever raised for a session
 * that has a composer mounted to render it. A request for a session with no
 * composer, or whose composer leaves while the request waits, is answered with
 * a cancel at once: a dialog nobody can show must never sit on screen (or at the
 * head of the queue) holding back every other conversation's sends.
 * @module dsh-orquestrator/client/dialogs
 */

import type { OrchestratorConfig, SkillOffer } from '../shared.ts'
import { createStore, type Observable } from './observable.ts'

/** Why the dialog is open. */
export type DialogMode =
  /** Raised by a task send; the send waits for the answer. */
  | 'gate'
  /** Raised by the `/orquestrar` command; nothing waits. */
  | 'configure'

/** How the dialog ended. */
export type DialogResult =
  | {
    readonly kind: 'confirm'
    readonly config: OrchestratorConfig
    /** Whether the message must go out carrying the skill's token. Always false when no skill was offered. */
    readonly applySkill: boolean
  }
  | { readonly kind: 'cancel' }

/** What a caller supplies to raise a dialog. */
export interface DialogInput {
  readonly sessionId: string
  readonly mode: DialogMode
  /** Single-line preview of the task being sent (gate mode). */
  readonly preview: string
  /**
   * Values the dialog opens with. A function is called when the dialog is put on screen, not when it is requested:
   * a dialog that waited behind another one then opens with what that one's answer left behind.
   */
  readonly initial: OrchestratorConfig | (() => OrchestratorConfig)
  /**
   * The skill the host offers and has registered (gate mode); the dialog shows
   * its checkbox only for a non-null value. Null shows no checkbox and a
   * confirm then answers `applySkill: false`.
   */
  readonly skill: SkillOffer | null
  /**
   * Whether the message being sent already carries the skill's token (typed, pasted or recalled). The skill then
   * applies whatever the box says, so the dialog shows the box ticked and locked. Ignored while `skill` is null.
   */
  readonly skillInMessage: boolean
  /** Whether the skill checkbox opens checked; a function is read when the dialog is put on screen, like `initial`. */
  readonly initialSkill: boolean | (() => boolean)
  /**
   * Persist the answer on the host: a configuration on confirm, null on a
   * gate-mode cancel (the stock behavior must win for this task).
   */
  readonly save: (config: OrchestratorConfig | null) => Promise<void>
  /**
   * Called once with the answer, synchronously, before the next dialog is put on screen and before the promise of
   * {@link DialogHost.request} resolves. Whatever the answer should leave behind for the next dialog (the choices the
   * caller remembers) is written here, so that the next dialog's `initial` and `initialSkill` functions see it.
   * A callback that throws is ignored.
   */
  readonly onAnswer?: (result: DialogResult) => void
}

/** A raised dialog as the renderer sees it: what was requested, with the pre-fill read. */
export interface DialogRequest {
  readonly id: number
  readonly sessionId: string
  readonly mode: DialogMode
  readonly preview: string
  readonly initial: OrchestratorConfig
  readonly skill: SkillOffer | null
  readonly skillInMessage: boolean
  readonly initialSkill: boolean
  readonly save: DialogInput['save']
  /** Finish the dialog with an answer (idempotent). */
  readonly resolve: (result: DialogResult) => void
}

/** A request waiting for its turn or its answer. */
interface Pending {
  readonly id: number
  readonly input: DialogInput
  /** The request as the renderer sees it, set when the dialog is put on screen. */
  shown: DialogRequest | undefined
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
   * resolves as a cancel (a superseded send must not leave a dialog behind), and
   * so does a session that has no composer mounted to render the dialog.
   * @param input - session, mode, preview, initial values, skill offer and persistence.
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
        try {
          input.onAnswer?.(result)
        } catch {
          // The caller's own bookkeeping must not keep the page's one modal from moving on.
        }
        resolvePromise(result)
      }
      const pending: Pending = { id: this.nextId++, input, shown: undefined, settle }
      const onAbort = (): void => { this.finish(pending, { kind: 'cancel' }) }
      if (signal?.aborted === true) {
        settle({ kind: 'cancel' })
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.queue.push(pending)
      // Puts it on screen when nothing is, or cancels it on the spot when its session has no composer.
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
      // A dialog whose last presenter left can no longer be answered, on screen or waiting: cancel it.
      this.advance()
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
   * The sessions that have a composer mounted right now: the conversations visible on this page.
   * @returns the session ids, in registration order.
   */
  presenterSessionIds(): string[] {
    return [...this.presenters.keys()]
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
    const index = this.queue.indexOf(pending)
    if (index >= 0) this.queue.splice(index, 1)
    if (pending.shown !== undefined && this.currentStore.getSnapshot() === pending.shown) this.currentStore.set(null)
    pending.settle(result)
    this.advance()
  }

  /**
   * Bring the queue up to date: cancel every request whose session has no composer left to render it (the one on
   * screen and the ones waiting alike), then put the head of the rest on screen when nothing is.
   */
  private advance(): void {
    const onScreen = this.currentStore.getSnapshot()
    for (const pending of [...this.queue]) {
      if (this.hasPresenter(pending.input.sessionId)) continue
      this.queue.splice(this.queue.indexOf(pending), 1)
      if (pending.shown !== undefined && pending.shown === onScreen) this.currentStore.set(null)
      pending.settle({ kind: 'cancel' })
    }
    while (this.currentStore.getSnapshot() === null) {
      const head = this.queue[0]
      if (head === undefined) return
      let request: DialogRequest
      try {
        request = this.render(head)
      } catch {
        // A pre-fill that cannot be read must not leave the head of the queue stuck with nothing on screen.
        this.queue.shift()
        head.settle({ kind: 'cancel' })
        continue
      }
      head.shown = request
      this.currentStore.set(request)
    }
  }

  /** The request as the renderer sees it, with the pre-fill read now. */
  private render(pending: Pending): DialogRequest {
    const { input } = pending
    return {
      id: pending.id,
      sessionId: input.sessionId,
      mode: input.mode,
      preview: input.preview,
      initial: typeof input.initial === 'function' ? input.initial() : input.initial,
      skill: input.skill,
      skillInMessage: input.skillInMessage,
      initialSkill: typeof input.initialSkill === 'function' ? input.initialSkill() : input.initialSkill,
      save: input.save,
      resolve: (result) => { this.finish(pending, result) },
    }
  }
}
