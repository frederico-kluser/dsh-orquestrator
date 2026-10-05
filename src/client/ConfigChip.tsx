/**
 * The dock chip: one ambient line under the composer that always says how
 * subagents are configured in this conversation — whether they run on a model
 * of their own, which model, and which reasoning effort — and opens the
 * orchestration dialog on click. It re-reads the stored choice whenever a
 * dialog (the gate's or `/orquestrar`) settles, so it never shows a stale
 * answer. Mounted on `conversation.composer.dock`, next to the host's own
 * ambient pills.
 * @module dsh-orquestrator/client/ConfigChip
 */

import { useCallback, useEffect, useState, useSyncExternalStore, type JSX } from 'react'
import { IconAgentPresetOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OrchestratorConfig } from '../shared.ts'
import type { CatalogState } from './catalog.ts'
import { LOADING_CATALOG } from './catalog.ts'
import type { DialogHost } from './dialogs.ts'
import type { LocaleLike } from './host-types.ts'
import type { OrchestratorKey } from './locales.ts'
import { NS } from './locales.ts'
import { describeConfig } from './status.ts'

/** The bound translate function of this plugin's namespace. */
type Translate = (key: OrchestratorKey, params?: Record<string, unknown>) => string

/** What the chip reaches through: the dialog host plus load/open entry points. */
export interface ConfigChipHost {
  readonly dialogs: DialogHost
  readonly locale: LocaleLike
  /** Read the session's stored choice; null when none (or unreadable). */
  loadStored(sessionId: string): Promise<OrchestratorConfig | null>
  /** Load the model catalog for a session. */
  loadCatalog(sessionId: string): Promise<CatalogState>
  /** Open the dialog in configure mode (nothing waits on it). */
  openConfigure(sessionId: string): Promise<void>
}

/** Props the slot renderer passes (its own standard kit plus the inject face below). */
export interface ConfigChipProps {
  readonly sessionId: string
  readonly host: ConfigChipHost
}

/**
 * The chip.
 * @param props - the composer's session id and the plugin host face.
 * @returns one clickable status line.
 */
export function ConfigChip({ sessionId, host }: ConfigChipProps): JSX.Element {
  const [state, setState] = useState<{ config: OrchestratorConfig | null; catalog: CatalogState } | null>(null)
  // Re-render while a dialog is open (so the click target stays coherent) and,
  // above all, when one settles: the answer may have changed the configuration.
  const dialogEpoch = useSyncExternalStore(
    listener => host.dialogs.current.subscribe(listener),
    () => (host.dialogs.current.getSnapshot() === null ? 0 : 1),
  )
  // Re-render on a language switch (the translate function reads the active locale at call time).
  useSyncExternalStore(
    listener => host.locale.subscribe(listener),
    () => host.locale.getSnapshot(),
  )

  useEffect(() => {
    let alive = true
    void Promise.all([
      host.loadStored(sessionId).catch(() => null),
      host.loadCatalog(sessionId).catch(() => LOADING_CATALOG),
    ]).then(([config, catalog]) => {
      if (alive) setState({ config, catalog })
    })
    return () => { alive = false }
  }, [host, sessionId, dialogEpoch])

  const onClick = useCallback(() => { void host.openConfigure(sessionId) }, [host, sessionId])
  const t = host.locale.bind(NS) as Translate

  if (state === null) {
    return (
      <button type="button" className="dsh-orq-chip" aria-label={t('dock.title', { summary: t('dock.loading') })} onClick={onClick}>
        <IconAgentPresetOutline16 size={12} />
        <span className="dsh-orq-chip-text">{t('dock.loading')}</span>
      </button>
    )
  }

  const status = describeConfig(state.config, state.catalog.groups, state.catalog.current)
  const summary = status.ownModel
    ? t('dock.model', { model: status.model, effort: status.explicitEffort ? status.effort : t('dock.recommended') })
    : status.explicitEffort
      ? t('dock.sameEffort', { effort: status.effort })
      : t('dock.off')
  const active = status.ownModel || status.explicitEffort
  return (
    <button
      type="button"
      className={active ? 'dsh-orq-chip dsh-orq-chip-on' : 'dsh-orq-chip'}
      title={t('dock.title', { summary })}
      aria-label={t('dock.title', { summary })}
      onClick={onClick}
    >
      <IconAgentPresetOutline16 size={12} />
      <span className="dsh-orq-chip-text">{summary}</span>
    </button>
  )
}
