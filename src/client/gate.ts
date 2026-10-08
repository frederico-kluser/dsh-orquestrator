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
 *
 * The answer can also change what is sent. When the host offers the global
 * orchestration skill and the user leaves its checkbox ticked, the prompt goes
 * out carrying the skill's `/name` token, which is what makes the host load the
 * skill for that message. Unticked, cancelled, or with no skill on offer, the
 * prompt goes out untouched. A message that already carries the token keeps it
 * (the host loads the skill whatever the box says), so the dialog shows the box
 * ticked and locked for it.
 *
 * Sends of one conversation pass the gate one at a time, in the order they were
 * made: a second send waits for the first to be answered, so the dialogs come up
 * in that order and each opens with what the one before it left behind.
 * @module dsh-orquestrator/client/gate
 */

import { OFF_CONFIG, isActive, parseConfig, type OrchestratorConfig, type SkillOffer } from '../shared.ts'
import type { ConfigClient } from './config-client.ts'
import type { DialogHost, DialogResult } from './dialogs.ts'
import type { PromptPartLike, SessionFaceLike } from './host-types.ts'
import { hasSkillToken, withSkillToken } from './skill-token.ts'

/** Longest task preview shown in the dialog. */
const PREVIEW_CHARS = 240

/** How often {@link attachWhenAvailable} looks for a session face that is not there yet. */
const ATTACH_POLL_MS = 500

/** Persistence of the most recent confirmed choice (a convenience for the next dialog, in any conversation). */
export interface LastChoiceMemory {
  read(): OrchestratorConfig | null
  write(config: OrchestratorConfig): void
}

/** Persistence of the last answer to the skill checkbox (it only pre-fills the next dialog, in any conversation). */
export interface SkillChoiceMemory {
  /** The last answer: true when the skill was applied, false when it was declined, null when there is none. */
  read(): boolean | null
  /** Remember an answer. Never throws. */
  write(on: boolean): void
}

/** Dependencies of the gate. */
export interface GateDeps {
  readonly client: ConfigClient
  readonly dialogs: DialogHost
  readonly memory: LastChoiceMemory
  /** The last answer to the skill checkbox; the checkbox opens ticked until the user has answered once. */
  readonly skillMemory: SkillChoiceMemory
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

/**
 * Whether the face is an addressed subagent conversation: the user is typing to a child, not to the agent that
 * coordinates. The orchestration skill is for the coordinator (it says so itself), so it is never offered there.
 * @param face - the session face sending the prompt.
 * @returns true for a subagent conversation; false for anything else, including a face that cannot say.
 */
export function isSubagentConversation(face: SessionFaceLike): boolean {
  try {
    const subagent = face.getSnapshot().subagent
    return subagent !== null && subagent !== undefined
  } catch {
    return false
  }
}

/**
 * Wait until the sends ahead of this one have been answered. A send that is aborted stops waiting: it has nothing
 * left to ask, and it must not sit behind another message's dialog.
 * @param turn - settles when everything ahead is done.
 * @param signal - cancellation of the surrounding send.
 */
async function untilTurn(turn: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    await turn
    return
  }
  if (signal.aborted) return
  let stop: () => void = () => {}
  const aborted = new Promise<void>((resolve) => {
    stop = resolve
    signal.addEventListener('abort', stop, { once: true })
  })
  try {
    await Promise.race([turn, aborted])
  } finally {
    signal.removeEventListener('abort', stop)
  }
}

/** The gate. */
export class PromptGate {
  /** Patched objects (a session class prototype, or a single face) with their attach counts. */
  private readonly patched = new Map<object, { count: number; restore: () => void }>()
  /** The end of each conversation's line of sends: what the next send has to wait for. Never rejects. */
  private readonly lines = new Map<string, Promise<void>>()
  /** What the host said about the skill the last time it was read; undefined until a read has succeeded. */
  private lastSkill: SkillOffer | null | undefined
  private readonly deps: GateDeps

  /**
   * @param deps - HTTP client, dialog host, last-choice and skill-choice memories, and diagnostics.
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
   * original method exactly. The wrapper sends the content {@link beforePrompt}
   * returns (the original content when the gate fails), after the earlier sends
   * of the same conversation have been answered.
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
      let sent = content
      let release = (): void => {}
      try {
        const place = gate.joinLine(this.sessionId)
        release = place.release
        await untilTurn(place.turn, signal)
        sent = await gate.beforePrompt(this, content, mode, signal)
      } catch (error: unknown) {
        // Fail open: the original content goes out, as stock DSH would send it.
        sent = content
        gate.deps.warn('gate failed; sending as stock DSH would', error)
      }
      try {
        return original.call(this, sent, mode, signal, requestId)
      } finally {
        // The send is on its way (the host's answer is not waited for): the next send of this conversation may be asked.
        release()
      }
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
   * Take a place in a conversation's line of sends. `turn` settles when every send ahead has been released; the
   * caller must call `release` once its own send is on its way, whatever happened, or the line stops.
   */
  private joinLine(sessionId: string): { readonly turn: Promise<void>; readonly release: () => void } {
    const before = this.lines.get(sessionId)
    let release: () => void = () => {}
    const mine = new Promise<void>((resolve) => { release = resolve })
    const end = before === undefined ? mine : before.then(() => mine)
    this.lines.set(sessionId, end)
    void end.then(() => { if (this.lines.get(sessionId) === end) this.lines.delete(sessionId) })
    return { turn: before ?? Promise.resolve(), release }
  }

  /** Run one of the remembered-choice reads: a memory that breaks costs the pre-fill, never the dialog. */
  private recall<T>(read: () => T, fallback: T): T {
    try {
      return read()
    } catch (error: unknown) {
      this.deps.warn('could not read a remembered choice', error)
      return fallback
    }
  }

  /**
   * Remember an answer for the next dialog. Each memory is written on its own and a failure only costs the
   * convenience: what is sent never depends on it. Both choices are real answers: the subagent-model one even
   * with the switch off (an off choice is what the user chose), and the skill one whatever the switch says,
   * because the checkbox is interactive either way.
   * @param answer - how the dialog ended.
   * @param skillAsked - whether the skill question was offered and not forced by a typed token. Only then is
   * there an answer to remember: a box locked by a token in the message, or no box at all, was not a question,
   * and writing its forced `applySkill` would reset the user's preference.
   */
  private remember(answer: DialogResult, skillAsked: boolean): void {
    if (answer.kind !== 'confirm') return
    try {
      this.deps.memory.write(answer.config)
    } catch (error: unknown) {
      this.deps.warn('could not remember the choice', error)
    }
    if (!skillAsked) return
    try {
      this.deps.skillMemory.write(answer.applySkill)
    } catch (error: unknown) {
      this.deps.warn('could not remember the skill answer', error)
    }
  }

  /**
   * Ask before this message goes out. Every message the user sends from the
   * composer is worth asking about: a task that begins with a `/skill`
   * invocation is a task, and so is a follow-up typed while a turn runs. The
   * only thing that passes straight through is a send with no content at all.
   * @param face - the session face sending the prompt.
   * @param content - the prompt parts; never modified.
   * @param _mode - the delivery mode the composer chose (no longer a reason to stay silent).
   * @param signal - cancellation of the surrounding send.
   * @returns the content to send, once the answer is in: the same parts, plus
   * the skill's token when the host offered the skill and the user left it
   * ticked. The content comes back as it was for a cancel, an unticked skill,
   * a skill the host did not offer, a message that already carries the token,
   * an empty or already aborted send, and a dialog nobody can show.
   */
  async beforePrompt(
    face: SessionFaceLike,
    content: readonly PromptPartLike[],
    _mode: 'queue' | 'steer',
    signal?: AbortSignal,
  ): Promise<readonly PromptPartLike[]> {
    const text = textOf(content).trim()
    if (text === '' && content.length === 0) return content
    // A send that was abandoned while it waited has nothing to ask about.
    if (signal?.aborted === true) return content

    const sessionId = face.sessionId
    const { client, dialogs, memory, skillMemory } = this.deps
    let stored: OrchestratorConfig | null = null
    let skill: SkillOffer | null
    try {
      const state = await client.loadState(sessionId)
      stored = state.config
      skill = state.skill
      this.lastSkill = skill
    } catch (error: unknown) {
      // The host half is absent or unreachable. The modal still asks — the
      // operator's rule is that it always appears — pre-filled from the last
      // choice; a confirm then says out loud that the choice could not be
      // stored. Silently sending the task without asking is what hid the
      // dialog in the first place. The skill on offer is the one the host
      // named the last time it answered: a slow or failed read must not make
      // the checkbox vanish. A page that never heard from the host offers none.
      skill = this.lastSkill ?? null
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
      return content
    }

    // The skill is offered only when the host says it is registered right now:
    // a token the host cannot expand would reach the model as plain text. Not
    // in a subagent conversation either: the skill teaches the agent that
    // coordinates, and a child that received it would try to coordinate.
    const offer = skill !== null && skill.available && !isSubagentConversation(face) ? skill : null
    // A token already in the message (typed, pasted, recalled) wins over the box: the host loads the skill for it
    // whatever the user answers, so the dialog does not pretend to ask.
    const typed = offer !== null && hasSkillToken(content, offer.name)
    const result = await dialogs.request({
      sessionId,
      mode: 'gate',
      preview: previewOf(text),
      // Read when the dialog goes on screen, not now: one that waited behind another dialog opens with that one's answer.
      initial: () => stored ?? this.recall(() => memory.read(), null) ?? OFF_CONFIG,
      skill: offer,
      skillInMessage: typed,
      // Ticked until the user has answered once, then whatever they chose last.
      initialSkill: () => this.recall(() => skillMemory.read(), null) ?? true,
      save: async (config) => { await client.save(sessionId, config) },
      onAnswer: (answer) => { this.remember(answer, offer !== null && !typed) },
    }, signal)
    if (result.kind !== 'confirm' || offer === null || typed) return content
    return result.applySkill ? withSkillToken(content, offer.name) : content
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

/**
 * Memory of the last answer to the skill checkbox, kept in `localStorage`
 * (best effort): `'on'` or `'off'`. Anything else, a missing storage and a
 * storage that throws all read as "no answer yet".
 * @param storage - a Storage-like object, or undefined when unavailable.
 * @returns the memory.
 */
export function createSkillChoiceMemory(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined): SkillChoiceMemory {
  const KEY = 'dsh-orquestrator:skill:v1'
  return {
    read() {
      try {
        const raw = storage?.getItem(KEY)
        if (raw === 'on') return true
        if (raw === 'off') return false
        return null
      } catch {
        return null
      }
    },
    write(on) {
      try {
        storage?.setItem(KEY, on ? 'on' : 'off')
      } catch {
        // Storage may be full or blocked: the memory is a convenience only.
      }
    },
  }
}
