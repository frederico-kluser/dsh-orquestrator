/**
 * What the dock chip says about a session's orchestration choice: whether
 * subagents run on their own model, which model, and which reasoning effort.
 * Pure display logic over the stored configuration and the model catalog, so
 * the chip stays a dumb renderer and this stays testable.
 * @module dsh-orquestrator/client/status
 */

import type { OrchestratorConfig } from '../shared.ts'
import type { CatalogGroupLike, CurrentSelectionLike } from './host-types.ts'
import { ladderOf, modelName } from './catalog.ts'

/** What the chip shows about one session's stored choice. */
export interface ConfigStatus {
  /** Whether subagents run on a model of their own. */
  readonly ownModel: boolean
  /** Whether an explicit reasoning effort is stored (instead of the recommended level). */
  readonly explicitEffort: boolean
  /** Display label of the subagent model (meaningful when `ownModel`); the raw id when the catalog lacks it. */
  readonly model: string
  /** Display label of the stored effort (meaningful when `explicitEffort`); the raw id when the catalog lacks it. */
  readonly effort: string
}

/** The inert status: no subagent model and no explicit level. */
const OFF_STATUS: ConfigStatus = Object.freeze({ ownModel: false, explicitEffort: false, model: '', effort: '' })

/**
 * Resolve a reasoning level id to the name the catalog gives it, else the id.
 * @param groups - the catalog groups.
 * @param route - the route whose ladder owns the level (the subagent's, or the main agent's for an effort-only choice).
 * @param effort - the stored level id.
 * @returns the display label.
 */
function effortLabel(groups: readonly CatalogGroupLike[], route: CurrentSelectionLike | null, effort: string): string {
  if (route === null) return effort
  return ladderOf(groups, route)?.efforts.find(level => level.id === effort)?.name ?? effort
}

/**
 * Summarize one session's stored choice for display.
 * @param config - the stored configuration, or null when none.
 * @param groups - the catalog groups (for model and level names).
 * @param current - the session's current route; an effort-only choice resolves its level against it.
 * @returns what the chip shows.
 */
export function describeConfig(
  config: OrchestratorConfig | null,
  groups: readonly CatalogGroupLike[],
  current: CurrentSelectionLike | null,
): ConfigStatus {
  if (config === null) return OFF_STATUS
  const hasModel = config.subagentModel !== null
  const hasEffort = config.workerEffort !== null
  if (!hasModel && !hasEffort) return OFF_STATUS
  return {
    ownModel: hasModel,
    explicitEffort: hasEffort,
    model: hasModel ? modelName(groups, config.subagentModel) : '',
    effort: hasEffort ? effortLabel(groups, hasModel ? config.subagentModel : current, config.workerEffort) : '',
  }
}
