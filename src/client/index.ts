/**
 * dsh-orquestrator, browser half.
 *
 * Wires five things into the stock DSH web client:
 * - the dialog stylesheet (DSH tokens only);
 * - the `orquestrator` dictionaries (English, Portuguese, Chinese);
 * - a composer overlay occupant that hosts the dialog and attaches the prompt
 *   gate, so a task send raises the modal before the prompt is admitted;
 * - a dock chip under the composer that always shows how subagents are
 *   configured in this conversation (own model? which? which effort?) and
 *   opens the dialog on click;
 * - a `/orquestrar` slash command that opens the same dialog on demand (the
 *   manual path, and the way to change or clear the stored choice).
 *
 * Everything here is fail-open: if any piece cannot mount, sends behave
 * exactly as stock DSH.
 * @module dsh-orquestrator/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ComponentType } from 'react'
import { IconAgentPresetOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { OFF_CONFIG } from '../shared.ts'
import { loadCatalog, type CatalogState } from './catalog.ts'
import { ConfigClient } from './config-client.ts'
import { DialogHost } from './dialogs.ts'
import { createLastChoiceMemory, PromptGate, attachWhenAvailable } from './gate.ts'
import type {
  CommandUiLike, LocaleLike, ModelDirectoriesLike, RemoteSessionLike, SessionsLike, SlotsLike,
} from './host-types.ts'
import { NS, en, pt, zh } from './locales.ts'
import { ConfigChip, type ConfigChipHost } from './ConfigChip.tsx'
import { OrchestratorOverlay, type OverlayHost } from './OrchestratorOverlay.tsx'
import { installStyles } from './styles.ts'

/** Required services: the session registry, the slot registry and the locale runtime. */
export const inject = ['sessions', 'slots', 'locale']

/** The page's `localStorage`, or undefined when the browser blocks it. */
function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

/**
 * Client plugin body.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const sessions = ctx.get('sessions') as unknown as SessionsLike
  const slots = ctx.get('slots') as unknown as SlotsLike
  const locale = ctx.get('locale') as unknown as LocaleLike

  ctx.effect(() => installStyles(document), 'dsh-orquestrator: styles')
  ctx.effect(() => locale.register(NS, 'en', en), 'dsh-orquestrator: dictionary (en)')
  // Portuguese registers as a dictionary only. Adding the LANGUAGE is left to
  // whoever owns it (DSH or another plugin): a second addLanguage('pt') throws
  // in the plugin that loads last, so this plugin must never race for it.
  ctx.effect(() => locale.register(NS, 'pt', pt), 'dsh-orquestrator: dictionary (pt)')
  ctx.effect(() => locale.register(NS, 'zh', zh), 'dsh-orquestrator: dictionary (zh)')

  const client = new ConfigClient()
  const dialogs = new DialogHost()
  const memory = createLastChoiceMemory(safeStorage())
  const gate = new PromptGate({
    client,
    dialogs,
    memory,
    warn: (message, error) => { console.warn(`dsh-orquestrator: ${message}`, error) },
  })

  const host: OverlayHost & ConfigChipHost = {
    dialogs,
    locale,
    attachGate(sessionId) {
      return attachWhenAvailable(
        () => sessions.binding(sessionId)?.session,
        gate,
        (message, error) => { console.warn(`dsh-orquestrator: ${message}`, error) },
      )
    },
    loadStored(sessionId) {
      return client.load(sessionId)
    },
    loadCatalog(sessionId): Promise<CatalogState> {
      return loadCatalog({
        modelDirectories: () => ctx.get('modelDirectories') as unknown as ModelDirectoriesLike | undefined,
        // `ctx.remote` would throw for a plugin that did not inject it; `get` does not.
        remoteSession: () => (ctx.get('remote') as unknown as { session?: RemoteSessionLike } | undefined)?.session,
      }, sessionId)
    },
    openConfigure: (sessionId) => openConfigure(sessionId),
  }

  ctx.effect(
    () => slots.inject('conversation.input.overlay', () => slots.register({
      name: 'conversation.input.overlay',
      id: 'dsh-orquestrator',
      order: 20,
      inject: () => ({ host }),
    }, OrchestratorOverlay as unknown as ComponentType<never>)),
    'dsh-orquestrator: composer overlay',
  )

  // The status chip under the composer: what subagents run on in this
  // conversation, clickable to change it. Ambient entries share the row with
  // the host's own pills (`StatsPills`), so it stays one quiet line.
  ctx.effect(
    () => slots.inject('conversation.composer.dock', () => slots.register({
      name: 'conversation.composer.dock',
      id: 'dsh-orquestrator',
      order: 10,
      inject: () => ({ host }),
    }, ConfigChip as unknown as ComponentType<never>)),
    'dsh-orquestrator: config chip',
  )

  // The `/orquestrar` command exists only while the command UI is mounted.
  ctx.inject(['commandUi'], (scope: ClientContext) => {
    const commandUi = scope.get('commandUi') as unknown as CommandUiLike
    const t = locale.bind(NS)
    scope.effect(() => commandUi.register({
      name: 'orquestrar',
      label: () => t('command.label'),
      description: () => t('command.description'),
      icon: IconAgentPresetOutline16,
      available: () => true,
      ui: {
        kind: 'action',
        run(session) {
          void openConfigure(session.sessionId)
        },
      },
    }), 'dsh-orquestrator: /orquestrar command')
  })

  /** Open the dialog in configure mode (nothing waits on it). */
  async function openConfigure(sessionId: string): Promise<void> {
    if (!dialogs.hasPresenter(sessionId)) return
    let stored = null
    try {
      stored = await client.load(sessionId)
    } catch (error: unknown) {
      console.warn('dsh-orquestrator: could not read the stored choice; opening with defaults', error)
    }
    await dialogs.request({
      sessionId,
      mode: 'configure',
      preview: '',
      initial: stored ?? memory.read() ?? OFF_CONFIG,
      save: async (config) => { await client.save(sessionId, config) },
    })
  }
}
