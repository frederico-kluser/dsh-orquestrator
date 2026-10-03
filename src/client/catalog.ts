/**
 * Model catalog for the pickers: the SAME provider-grouped directory the
 * composer's model seat shows, so the dialog offers exactly the models the
 * user can already pick there. It prefers the per-session `modelDirectories`
 * service (which also knows the session's current route) and falls back to the
 * global `session.modelCatalog` remote when that service is not mounted.
 * @module dsh-orquestrator/client/catalog
 */

import type {
  CatalogGroupLike, CatalogReasoningLike, CurrentSelectionLike, ModelDirectoriesLike, RemoteSessionLike,
} from './host-types.ts'
import { capFor, chooseEffort, type Role } from '../models.ts'

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

/**
 * Where the loader may look. Each source is a RESOLVER, evaluated inside the
 * loader's own error handling: Cordis refuses to hand out a service the plugin
 * did not `inject` (it throws on access), and that must degrade to "no such
 * source", never crash the dialog.
 */
export interface CatalogSources {
  readonly modelDirectories?: (() => ModelDirectoriesLike | undefined) | undefined
  readonly remoteSession?: (() => RemoteSessionLike | undefined) | undefined
}

/**
 * Load the catalog for one session.
 * @param sources - resolvers for the model-directory service and the remote catalog call.
 * @param sessionId - the session whose current route to report.
 * @returns a ready state, or an error state when no source could answer. Never throws.
 */
export async function loadCatalog(sources: CatalogSources, sessionId: string): Promise<CatalogState> {
  let failure: string | null = null
  const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

  try {
    const directories = sources.modelDirectories?.()
    if (directories !== undefined) {
      const state = await directories.directoryFor(sessionId).load()
      if (state.status !== 'error' && state.groups.length > 0) {
        return { status: 'ready', groups: state.groups, current: state.current, error: null }
      }
      failure = state.error
    }
  } catch (error: unknown) {
    failure = describe(error)
  }

  try {
    const remote = sources.remoteSession?.()
    if (remote !== undefined) {
      const response = await remote.modelCatalog()
      if (response.ok) {
        return { status: 'ready', groups: response.value.groups, current: response.value.default, error: null }
      }
      failure = response.error.message
    }
  } catch (error: unknown) {
    failure = describe(error)
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

/**
 * The reasoning levels one route offers.
 * @param groups - the catalog groups.
 * @param route - a provider/model pair.
 * @returns the ladder, or undefined when the route is unknown or has no reasoning levels.
 */
export function ladderOf(groups: readonly CatalogGroupLike[], route: { readonly provider: string; readonly model: string }): CatalogReasoningLike | undefined {
  return groups.find(candidate => candidate.id === route.provider)?.models.find(model => model.id === route.model)?.reasoning
}

/** What the dialog shows for the "recommended" choice of one role. */
export interface EffortAdvice {
  /** The route's reasoning ladder; undefined means the model has no reasoning levels (or is unknown). */
  readonly ladder: CatalogReasoningLike | undefined
  /** The level the recommended choice resolves to, when known. */
  readonly level: { readonly id: string; readonly name: string } | undefined
}

/**
 * Compute what "recommended" means for a role on a route, with the same
 * policy the host applies (`chooseEffort`, `capFor`), so the dialog never
 * promises a level the host will not use.
 * @param groups - the catalog groups.
 * @param route - the route the child will run on.
 * @param role - worker or reviewer.
 * @param inherited - the main agent's level when the child inherits its route.
 * @returns the ladder and the recommended level.
 */
export function adviseEffort(
  groups: readonly CatalogGroupLike[],
  route: { readonly provider: string; readonly model: string },
  role: Role,
  inherited?: string,
): EffortAdvice {
  const ladder = ladderOf(groups, route)
  if (ladder === undefined) return { ladder: undefined, level: undefined }
  const ids = ladder.efforts.map(effort => effort.id)
  const choice = chooseEffort({ ladder: ids, current: inherited ?? ladder.defaultEffort, explicit: undefined, cap: capFor(route, role) })
  const id = choice.effort ?? inherited ?? ladder.defaultEffort
  const level = id === undefined ? undefined : ladder.efforts.find(effort => effort.id === id)
  return { ladder, level }
}
