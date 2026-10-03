/**
 * Narrowed browser-side service contracts the client half reads. Types only:
 * the real declarations live in the DSH client packages
 * (`dsh-api-session-controller`, `dsh-client-ui-slots`, `dsh-client-locale`,
 * `dsh-client-ui-commands`, `dsh-client-ui-model-selection`). Shapes are
 * mirrored from DSH 0.1.6-alpha.2 and only ever narrowed.
 * @module dsh-orquestrator/client/host-types
 */

import type { ComponentType } from 'react'

/** One part of a prompt: text, an image, or a staged file receipt. */
export interface PromptPartLike {
  readonly type: string
  readonly text?: string
}

/** The slice of the client Session snapshot the gate reads. */
export interface SessionSnapshotLike {
  /** Whether the addressed agent has a turn in flight. */
  readonly running: boolean
  /** Non-null for an addressed (continuable) subagent conversation. */
  readonly subagent: unknown
  /**
   * Whether this conversation has had no turn yet (DSH's own `SessionSnapshot.blank`).
   * Absent means "unknown", and the gate then keeps the plain per-session rule.
   */
  readonly blank?: boolean
}

/** The outward Session face (`SessionFace`), narrowed to what the gate touches. */
export interface SessionFaceLike {
  readonly sessionId: string
  getSnapshot(): SessionSnapshotLike
  prompt(
    content: readonly PromptPartLike[],
    mode: 'queue' | 'steer',
    signal?: AbortSignal,
    requestId?: unknown,
  ): Promise<unknown>
}

/** `ctx.sessions`, narrowed. */
export interface SessionsLike {
  binding(id: string): { readonly session: SessionFaceLike } | undefined
}

/** The reasoning levels one exact route offers, in escalation order, and the one it uses by default. */
export interface CatalogReasoningLike {
  readonly efforts: readonly { readonly id: string; readonly name: string }[]
  readonly defaultEffort?: string
}

/** A model row of the catalog. */
export interface CatalogModelLike {
  readonly id: string
  readonly name: string
  readonly description?: string
  /** Absent for a model without reasoning levels. */
  readonly reasoning?: CatalogReasoningLike
}

/** A provider group of the catalog. */
export interface CatalogGroupLike {
  readonly id: string
  readonly name: string
  readonly models: readonly CatalogModelLike[]
}

/** The current route of a session, as the model directory reports it. */
export interface CurrentSelectionLike {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Snapshot of one session's model directory. */
export interface ModelDirectoryStateLike {
  readonly current: CurrentSelectionLike | null
  readonly groups: readonly CatalogGroupLike[]
  readonly status: string
  readonly error: string | null
}

/** `ctx.modelDirectories`, narrowed. */
export interface ModelDirectoriesLike {
  directoryFor(sessionId: string): {
    load(): Promise<ModelDirectoryStateLike>
    readonly store: { getSnapshot(): ModelDirectoryStateLike }
  }
}

/** `ctx.remote.session`, narrowed to the global catalog call. */
export interface RemoteSessionLike {
  modelCatalog(): Promise<
    | { readonly ok: true; readonly value: { readonly default: CurrentSelectionLike; readonly groups: readonly CatalogGroupLike[] } }
    | { readonly ok: false; readonly error: { readonly message: string } }
  >
}

/** The registration spec of one slot occupant. */
export interface SlotSpecLike {
  readonly name: string
  readonly id: string
  readonly order?: number
  readonly locale?: string
  readonly inject?: (sessionId: string) => Record<string, unknown>
}

/** `ctx.slots`, narrowed. */
export interface SlotsLike {
  /**
   * Run a registration once the slot's owner is mounted and again after it remounts.
   * @param name - slot name.
   * @param factory - performs the registration and returns its disposer.
   * @returns a disposer for the whole binding.
   */
  inject(name: string, factory: () => () => void): () => void
  /**
   * Register one occupant component.
   * @param spec - slot name, id, order, locale namespace and inject face.
   * @param component - the React component to render.
   * @returns the registration disposer.
   */
  register(spec: SlotSpecLike, component: ComponentType<never>): () => void
}

/** A locale dictionary. */
export type LocaleDict = Readonly<Record<string, string>>

/** `ctx.locale`, narrowed. */
export interface LocaleLike {
  addLanguage(input: { id: string; label: string; fallback: string }): () => void
  register(ns: string, locale: string, dict: LocaleDict): () => void
  bind(ns: string): (key: string, params?: Record<string, unknown>) => string
  getSnapshot(): { readonly active: string; readonly locales: readonly { readonly id: string }[] }
  subscribe(listener: () => void): () => void
}

/** A slash command contribution (client-only action kind). */
export interface CommandContributionLike {
  readonly name: string
  label?(): string
  description?(): string
  readonly icon?: unknown
  available(session: { readonly sessionId: string }): boolean
  readonly ui: { readonly kind: 'action'; run(session: { readonly sessionId: string }): void }
}

/** `ctx.commandUi`, narrowed. */
export interface CommandUiLike {
  register(contribution: CommandContributionLike): () => void
}
