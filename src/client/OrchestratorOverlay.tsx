/**
 * The composer overlay: a slot occupant with no visual of its own. Mounted
 * next to every resident composer it (1) registers itself as a presenter for
 * its session so the gate knows a dialog can be shown, (2) attaches the prompt
 * gate to the session face for as long as the composer lives, and (3) renders
 * the dialog when the page's single pending request belongs to its session.
 * @module dsh-orquestrator/client/OrchestratorOverlay
 */

import { useCallback, useEffect, useState, useSyncExternalStore, type JSX } from 'react'
import { LOADING_CATALOG, type CatalogState } from './catalog.ts'
import type { DialogHost } from './dialogs.ts'
import type { LocaleLike } from './host-types.ts'
import { OrchestratorDialog, type Translate } from './OrchestratorDialog.tsx'
import { NS } from './locales.ts'

/** What the plugin entry hands to every overlay mount. */
export interface OverlayHost {
  readonly dialogs: DialogHost
  readonly locale: LocaleLike
  /**
   * Attach the prompt gate to a session (retrying while its binding settles).
   * @param sessionId - the composer's session.
   * @returns the detach function.
   */
  attachGate(sessionId: string): () => void
  /**
   * Load the model catalog for a session.
   * @param sessionId - the session whose current route to report.
   */
  loadCatalog(sessionId: string): Promise<CatalogState>
}

/** Props the slot renderer passes (its own standard kit plus the inject face below). */
export interface OverlayProps {
  readonly sessionId: string
  readonly host: OverlayHost
}

/**
 * The overlay component.
 * @param props - the composer's session id and the plugin host face.
 * @returns the dialog while a request for this session is on screen, else null.
 */
export function OrchestratorOverlay({ sessionId, host }: OverlayProps): JSX.Element | null {
  const [token] = useState(() => Symbol('dsh-orquestrator'))
  const request = useSyncExternalStore(
    listener => host.dialogs.current.subscribe(listener),
    () => host.dialogs.current.getSnapshot(),
  )
  // Re-render when a sibling composer of this session mounts or leaves, so the
  // "who presents" decision below always reflects the live roster.
  useSyncExternalStore(
    listener => host.dialogs.presence.subscribe(listener),
    () => host.dialogs.presence.getSnapshot(),
  )
  // Re-render on a language switch (the translate function reads the active locale at call time).
  useSyncExternalStore(
    listener => host.locale.subscribe(listener),
    () => host.locale.getSnapshot(),
  )
  const t = host.locale.bind(NS) as Translate

  useEffect(() => host.dialogs.registerPresenter(sessionId, token), [host, sessionId, token])
  useEffect(() => host.attachGate(sessionId), [host, sessionId])

  const [catalog, setCatalog] = useState<CatalogState>(LOADING_CATALOG)
  const presenting = request !== null && request.sessionId === sessionId && host.dialogs.isPresenter(sessionId, token)
  const requestId = presenting ? request.id : undefined

  const load = useCallback(() => {
    setCatalog(LOADING_CATALOG)
    let alive = true
    void host.loadCatalog(sessionId).then((state) => { if (alive) setCatalog(state) })
    return () => { alive = false }
  }, [host, sessionId])

  useEffect(() => (requestId === undefined ? undefined : load()), [requestId, load])

  if (!presenting) return null
  return <OrchestratorDialog key={request.id} request={request} catalog={catalog} reloadCatalog={() => { void load() }} t={t} />
}
