/**
 * What 0.2 to 0.4 accepted on the wire, kept as a fixture: the strict `parseConfig` of those versions, used by the host
 * to read a posted configuration and by the browser to read an answer. A half of the plugin that is one version behind
 * its other half (the page refreshed before `dsh` restarted, or a tab opened before a restart) runs exactly this, and a
 * configuration it refuses cannot be saved ("config does not match the expected shape"). The tests below assert that
 * everything the current halves put on the wire still passes it.
 */

const MAX_ID_LENGTH = 256
const CONTROL = /[\u0000-\u001f\u007f]/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseId(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && value.length <= MAX_ID_LENGTH && !CONTROL.test(value) ? value : undefined
}

function parseRoute(value: unknown): { provider: string; model: string; reasoningEffort?: string } | undefined {
  if (!isRecord(value)) return undefined
  const provider = parseId(value['provider'])
  const model = parseId(value['model'])
  if (provider === undefined || model === undefined) return undefined
  if (value['reasoningEffort'] === undefined) return { provider, model }
  const effort = parseId(value['reasoningEffort'])
  return effort === undefined ? undefined : { provider, model, reasoningEffort: effort }
}

/** `null` and `undefined` mean "recommended"; anything else must be a plain id. `undefined` result = malformed. */
function parseEffort(value: unknown): { value: string | null } | undefined {
  if (value === null || value === undefined) return { value: null }
  const id = parseId(value)
  return id === undefined ? undefined : { value: id }
}

/**
 * The 0.4.0 `parseConfig`, rule for rule: version 1, an optional subagent route, an optional effort, and a `reviewer`
 * block that MUST be there with a boolean `enabled`, an optional route and an optional effort.
 * @param value - candidate value.
 * @returns the old shape, or undefined when 0.2 to 0.4 would have refused it.
 */
export function legacyParseConfig(value: unknown): { version: 1; subagentModel: unknown; workerEffort: string | null; reviewer: { enabled: boolean; model: unknown; effort: string | null } } | undefined {
  if (!isRecord(value) || value['version'] !== 1) return undefined
  const rawSubagent = value['subagentModel']
  const subagentModel = rawSubagent === null || rawSubagent === undefined ? null : parseRoute(rawSubagent)
  if (subagentModel === undefined) return undefined
  const workerEffort = parseEffort(value['workerEffort'])
  if (workerEffort === undefined) return undefined
  const reviewer = value['reviewer']
  if (!isRecord(reviewer) || typeof reviewer['enabled'] !== 'boolean') return undefined
  const rawReviewerModel = reviewer['model']
  const reviewerModel = rawReviewerModel === null || rawReviewerModel === undefined ? null : parseRoute(rawReviewerModel)
  if (reviewerModel === undefined) return undefined
  const reviewerEffort = parseEffort(reviewer['effort'])
  if (reviewerEffort === undefined) return undefined
  return { version: 1, subagentModel, workerEffort: workerEffort.value, reviewer: { enabled: reviewer['enabled'], model: reviewerModel, effort: reviewerEffort.value } }
}
