/**
 * Model catalog for the pickers: the SAME provider-grouped directory the
 * composer's model seat shows, so the dialog offers exactly the models the
 * user can already pick there. It prefers the per-session `modelDirectories`
 * service (which also knows the session's current route) and falls back to the
 * global `session.modelCatalog` remote when that service is not mounted.
 * @module dsh-orquestrator/client/catalog
 */

import type {
  CatalogGroupLike, CurrentSelectionLike, ModelDirectoriesLike, RemoteSessionLike,
} from './host-types.ts'

/** What the pickers render from. */
export interface CatalogState {
  readonly status: 'loading' | 'ready' | 'error'
  readonly groups: readonly CatalogGroupLike[]
  /** The session's current route (the main agent's model), when known. */
  readonly current: CurrentSelectionLike | null
  readonly error: string | null
}

/** The initial, empty state. */
export const LOADING_CATALOG: CatalogState = { status: 'loading', groups: [], current: null, error: null }

/** The services the loader may use (each optional: the composition decides). */
export interface CatalogServices {
  readonly modelDirectories?: ModelDirectoriesLike | undefined
  readonly remoteSession?: RemoteSessionLike | undefined
}

/**
 * Load the catalog for one session.
 * @param services - the model-directory service and/or the remote catalog call.
 * @param sessionId - the session whose current route to report.
 * @returns a ready state, or an error state when no source could answer.
 */
export async function loadCatalog(services: CatalogServices, sessionId: string): Promise<CatalogState> {
  let failure: string | null = null
  if (services.modelDirectories !== undefined) {
    try {
      const state = await services.modelDirectories.directoryFor(sessionId).load()
      if (state.status !== 'error' && state.groups.length > 0) {
        return { status: 'ready', groups: state.groups, current: state.current, error: null }
      }
      failure = state.error
    } catch (error: unknown) {
      failure = error instanceof Error ? error.message : String(error)
    }
  }
  if (services.remoteSession !== undefined) {
    try {
      const response = await services.remoteSession.modelCatalog()
      if (response.ok) {
        return { status: 'ready', groups: response.value.groups, current: response.value.default, error: null }
      }
      failure = response.error.message
    } catch (error: unknown) {
      failure = error instanceof Error ? error.message : String(error)
    }
  }
  return { status: 'error', groups: [], current: null, error: failure ?? 'no model catalog is available' }
}

/**
 * Human-readable name of a route, as the catalog names it.
 * @param groups - the catalog groups.
 * @param route - a provider/model pair.
 * @returns the model's display name, or the raw model id when the catalog lacks it.
 */
export function modelName(groups: readonly CatalogGroupLike[], route: { readonly provider: string; readonly model: string }): string {
  const group = groups.find(candidate => candidate.id === route.provider)
  return group?.models.find(model => model.id === route.model)?.name ?? route.model
}
