/**
 * The prompt gate: the seam between "the user pressed send" and "the prompt
 * reaches the host". Every browser-authored message goes through
 * `SessionFace.prompt`, so the gate wraps that one method on the mounted
 * session face. Before EVERY message the user sends from the composer it
 * raises the modal and waits for the answer — plain text, `@file` references
 * or `/skill` invocations, in any conversation, however the send is labelled
 * (queue or steer). The operator's rule (0.6.0): the modal always asks, and
 * only an empty send passes straight through. Early builds skipped `/` lines,
 * running turns and subagent conversations, so every task that began with a
 * skill invocation never saw the dialog.
 *
 * The gate is fail-open by construction: any problem (no composer mounted to
 * show the dialog, an exception here) sends the prompt exactly as stock DSH
 * would. It can delay a send, never lose one. A missing or unreadable host
 * route still asks: a dialog whose save fails out loud beats a modal that
 * never appears.
 * @module dsh-orquestrator/client/gate
 */

import { OFF_CONFIG, isActive, parseConfig, type OrchestratorConfig } from '../shared.ts'
import type { ConfigClient } from './config-client.ts'
import type { DialogHost } from './dialogs.ts'
import type { PromptPartLike, SessionFaceLike } from './host-types.ts'

/** Longest task preview shown in the dialog. */
const PREVIEW_CHARS = 240

/** How often {@link attachWhenAvailable} looks for a session face that is not there yet. */
const ATTACH_POLL_MS = 500

/** Persistence of the most recent confirmed choice (a convenience for the next dialog, in any conversation). */
export interface LastChoiceMemory {
  read(): OrchestratorConfig | null
  write(config: OrchestratorConfig): void
}

/** Dependencies of the gate. */
export interface GateDeps {
  readonly client: ConfigClient
  readonly dialogs: DialogHost
  readonly memory: LastChoiceMemory
  /** Diagnostics sink (never user-visible). */
  readonly warn: (message: string, error?: unknown) => void
}

/**
 * Join the text parts of a prompt.
 * @param content - the prompt parts.
 * @returns the concatenated text.
 */
export function textOf(content: readonly PromptPartLike[]): string {
  return content
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text as string)
    .join('\n')
}

/**
 * Collapse a task into a one-line preview.
 * @param text - the prompt text.
 * @returns whitespace-collapsed, bounded text.
 */
export function previewOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= PREVIEW_CHARS ? flat : `${flat.slice(0, PREVIEW_CHARS - 1)}\u2026`
}

/**
 * Choose where the wrapper goes: the prototype that owns `prompt` when the
 * face is an instance of a real class, else the face itself. Never
 * `Object.prototype` or a prototype without an own function `prompt`.
 * @param face - a session face.
 * @returns the object to patch.
 */
export function patchTargetOf(face: SessionFaceLike): object {
  const proto: unknown = Object.getPrototypeOf(face)
  if (
    typeof proto === 'object' && proto !== null && proto !== Object.prototype
    && Object.prototype.hasOwnProperty.call(proto, 'prompt')
    && typeof (proto as { prompt?: unknown }).prompt === 'function'
    && !Object.prototype.hasOwnProperty.call(face, 'prompt')
  ) return proto
  return face
}

/** The gate. */
export class PromptGate {
  /** Patched objects (a session class prototype, or a single face) with their attach counts. */
  private readonly patched = new Map<object, { count: number; restore: () => void }>()
  private readonly deps: GateDeps

  /**
   * @param deps - HTTP client, dialog host, last-choice memory and diagnostics.
   */
  constructor(deps: GateDeps) {
    this.deps = deps
  }

  /**
   * Wrap `prompt` for as long as the returned disposer is not called. The
   * wrapper goes on the session class prototype when the face inherits
   * `prompt` from one (so a re-created face after a reconnect is covered too),
   * and on the single face otherwise. Attachments are reference-counted, so
   * two composers never stack wrappers and the last detach restores the
   * original method exactly.
   * @param face - the session face of a mounted composer.
   * @returns the detach function.
   */
  attach(face: SessionFaceLike): () => void {
    const target = patchTargetOf(face)
    const existing = this.patched.get(target)
    if (existing !== undefined) {
      existing.count += 1
      return () => { this.release(target) }
    }
    const holder = target as { prompt: SessionFaceLike['prompt'] }
    const original = holder.prompt
    const gate = this
    const wrapper: SessionFaceLike['prompt'] = async function wrapped(this: SessionFaceLike, content, mode, signal, requestId) {
      try {
        await gate.beforePrompt(this, content, mode, signal)
      } catch (error: unknown) {
        gate.deps.warn('gate failed; sending as stock DSH would', error)
      }
      return original.call(this, content, mode, signal, requestId)
    }
    const hadOwn = Object.prototype.hasOwnProperty.call(target, 'prompt')
    holder.prompt = wrapper
    const restore = (): void => {
      if (holder.prompt !== wrapper) return
      if (hadOwn) holder.prompt = original
      else delete (holder as { prompt?: unknown }).prompt
    }
    this.patched.set(target, { count: 1, restore })
    return () => { this.release(target) }
  }

  /** Drop one attachment; the last one restores the patched object. */
  private release(target: object): void {
    const entry = this.patched.get(target)
    if (entry === undefined) return
    entry.count -= 1
    if (entry.count > 0) return
    entry.restore()
    this.patched.delete(target)
  }

  /**
   * Ask before this message goes out. Every message the user sends from the
   * composer is worth asking about: a task that begins with a `/skill`
   * invocation is a task, and so is a follow-up typed while a turn runs. The
   * only thing that passes straight through is a send with no content at all.
   * @param face - the session face sending the prompt.
   * @param content - the prompt parts.
   * @param _mode - the delivery mode the composer chose (no longer a reason to stay silent).
   * @param signal - cancellation of the surrounding send.
   * @returns when the prompt may proceed.
   */
  async beforePrompt(
    face: SessionFaceLike,
    content: readonly PromptPartLike[],
    _mode: 'queue' | 'steer',
    signal?: AbortSignal,
  ): Promise<void> {
    const text = textOf(content).trim()
    if (text === '' && content.length === 0) return

    const sessionId = face.sessionId
    const { client, dialogs, memory } = this.deps
    let stored: OrchestratorConfig | null = null
    try {
      stored = await client.load(sessionId)
    } catch (error: unknown) {
      // The host half is absent or unreachable. The modal still asks — the
      // operator's rule is that it always appears — pre-filled from the last
      // choice; a confirm then says out loud that the choice could not be
      // stored. Silently sending the task without asking is what hid the
      // dialog in the first place.
      this.deps.warn('configuration route unavailable; asking with defaults', error)
    }
    // The modal always asks. There is no "do not ask again": one answer may not
    // silence the next task, this conversation, or the next one the DSH web
    // client opens in this workspace (it reuses a workspace's blank session for
    // every "new session", so any remembered silence would spread). The stored
    // choice only pre-fills the dialog.


    if (!dialogs.hasPresenter(sessionId)) {
      // Nobody can render the dialog. A previous one-task choice must not leak
      // into a task the user was never asked about.
      if (isActive(stored)) await client.save(sessionId, null).catch((error: unknown) => { this.deps.warn('could not clear a stale choice', error) })
      return
    }

    const initial = stored ?? memory.read() ?? OFF_CONFIG
    const result = await dialogs.request({
      sessionId,
      mode: 'gate',
      preview: previewOf(text),
      initial,
      save: async (config) => { await client.save(sessionId, config) },
    }, signal)
    if (result.kind === 'confirm') memory.write(result.config)
  }
}

/**
 * Attach the gate to a session face as soon as one exists, and keep looking
 * for as long as the composer lives. A session's binding can materialize
 * seconds after the composer mounts (a cold session, a heavy workspace, a
 * reconnect), and an attach that gave up quietly sent every task of that
 * conversation as stock DSH — the modal simply never appeared there. The poll
 * is cheap and stops the moment the gate is attached or the composer unmounts.
 * @param resolveFace - resolves the mounted session face, or undefined while it is not there yet.
 * @param gate - the gate to attach.
 * @param warn - diagnostics sink (never user-visible).
 * @param schedule - timer scheduler (injectable for tests).
 * @param cancel - timer cancellation (injectable for tests).
 * @returns the detach function.
 */
export function attachWhenAvailable(
  resolveFace: () => SessionFaceLike | undefined,
  gate: PromptGate,
  warn: (message: string, error?: unknown) => void,
  schedule: (callback: () => void, ms: number) => unknown = (callback, ms) => setTimeout(callback, ms),
  cancel: (handle: unknown) => void = (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
): () => void {
  let detach: (() => void) | undefined
  let handle: unknown
  let disposed = false
  const tryAttach = (): void => {
    handle = undefined
    if (disposed || detach !== undefined) return
    let face: SessionFaceLike | undefined
    try {
      face = resolveFace()
    } catch (error: unknown) {
      warn('could not look up the session face; will keep trying', error)
    }
    if (face !== undefined) {
      try {
        detach = gate.attach(face)
      } catch (error: unknown) {
        warn('could not attach the prompt gate; will keep trying', error)
      }
      if (detach !== undefined) return
    }
    handle = schedule(tryAttach, ATTACH_POLL_MS)
  }
  tryAttach()
  return () => {
    disposed = true
    if (handle !== undefined) cancel(handle)
    detach?.()
  }
}

/**
 * Memory of the last confirmed choice, kept in `localStorage` (best effort).
 * @param storage - a Storage-like object, or undefined when unavailable.
 * @returns the memory.
 */
export function createLastChoiceMemory(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined): LastChoiceMemory {
  const KEY = 'dsh-orquestrator:last:v1'
  return {
    read() {
      try {
        const raw = storage?.getItem(KEY)
        if (raw == null) return null
        const parsed = parseConfig(JSON.parse(raw))
        return parsed === undefined ? null : parsed
      } catch {
        return null
      }
    },
    write(config) {
      try {
        storage?.setItem(KEY, JSON.stringify(config))
      } catch {
        // Storage may be full or blocked: the memory is a convenience only.
      }
    },
  }
}
