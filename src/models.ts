/**
 * Model knowledge shared by both bundles (host and browser): what reasoning
 * effort a subagent should run at on each model, and the short notes the
 * dialog shows next to a model. Pure data and pure functions, like
 * `shared.ts`, because both bundles inline this file.
 *
 * Every row of {@link MODEL_PROFILES} is dated and names the studies it comes
 * from (`docs/estudos/`). It is advice, never a block: the user's pick in the
 * dialog always wins over it, and an unknown model simply falls back to the
 * generic ceiling.
 * @module dsh-orquestrator/models
 */

/**
 * Reasoning levels in DSH's canonical escalation order (pi-ai's thinking
 * levels). A model's own ladder is a subset of these, in this order.
 */
export const EFFORT_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** One canonical reasoning level. */
export type EffortLevel = typeof EFFORT_ORDER[number]

/**
 * The ceiling used when neither the operator nor a model profile says
 * otherwise. `medium` is the level the studies' "30 to 50 on a 1-100 scale"
 * advice maps to, and no study recommends `max` for a subagent.
 */
export const DEFAULT_CAP: EffortLevel = 'medium'

/** Short advice the dialog can show next to a model (keys of the `note.*` dictionary entries). */
export type NoteId = 'redirected' | 'overthinks' | 'slowAtHighEffort' | 'premiumVariant' | 'textOnly' | 'reasoningAlwaysOn' | 'maxEffortRegresses'

/** Anything with a provider and a model id (a `ModelRoute` fits). */
export interface RouteLike {
  readonly provider: string
  readonly model: string
}

/** One dated row of model advice. */
export interface ModelProfile {
  /** Stable id of the row. */
  readonly id: string
  /** Whether the row describes this route. */
  readonly matches: (route: RouteLike) => boolean
  /** Reasoning-effort ceiling for a subagent on this model; absent means the generic ceiling. */
  readonly cap?: EffortLevel
  /** Notes to show next to the model. */
  readonly notes: readonly NoteId[]
  /** When the underlying facts were last checked (ISO date). */
  readonly verifiedAt: string
  /** Study ids (`docs/estudos/README.md`) and primary sources behind the row. */
  readonly sources: readonly string[]
}

/** The official DeepSeek route id in DSH (`llm-deepseek`). */
const OFFICIAL_DEEPSEEK = 'deepseek-official'

/** Model id lowercased, vendor prefix kept. */
function lowered(route: RouteLike): string {
  return route.model.trim().toLowerCase().replaceAll('_', '-')
}

/** Model id lowercased with any `vendor/` prefix removed. */
function bare(route: RouteLike): string {
  const id = lowered(route)
  const slash = id.lastIndexOf('/')
  return slash === -1 ? id : id.slice(slash + 1)
}

/** The V4.1 Flash line, under every spelling DSH catalogs carry. */
function isDeepSeekFlashLine(route: RouteLike): boolean {
  const id = bare(route)
  return /^deepseek-(v4(\.1)?-)?flash/.test(id) && !id.includes('vision')
}

/**
 * Dated model advice, most specific row first. Evidence behind each row is in
 * `docs/estudos/` (ids E01 to E16) and in the DeepSeek release notice of
 * 2026-09-10.
 */
export const MODEL_PROFILES: readonly ModelProfile[] = Object.freeze([
  {
    id: 'deepseek-v4-pro-official',
    matches: route => route.provider === OFFICIAL_DEEPSEEK && bare(route) === 'deepseek-v4-pro',
    cap: 'medium',
    notes: ['redirected', 'overthinks'],
    verifiedAt: '2026-10-03',
    sources: ['E05', 'E07', 'E08', 'E10', 'E11', 'api-docs.deepseek.com/news/news260910'],
  },
  {
    id: 'deepseek-flash',
    matches: isDeepSeekFlashLine,
    cap: 'medium',
    notes: ['overthinks'],
    verifiedAt: '2026-10-03',
    sources: ['E01', 'E03', 'E05', 'E07', 'E08', 'E10', 'E11', 'E12', 'E13'],
  },
  {
    id: 'mimo-ultraspeed',
    matches: route => /mimo.*ultraspeed/.test(lowered(route)),
    cap: 'low',
    notes: ['premiumVariant'],
    verifiedAt: '2026-10-03',
    sources: ['E01', 'E02', 'E13'],
  },
  {
    id: 'mimo',
    matches: route => /mimo/.test(lowered(route)),
    cap: 'low',
    notes: ['slowAtHighEffort'],
    verifiedAt: '2026-10-03',
    sources: ['E01', 'E02', 'E03', 'E05', 'E07', 'E08', 'E09', 'E11', 'E12', 'E13'],
  },
  {
    id: 'glm-flash',
    matches: route => /glm-5[.-]3-flash/.test(lowered(route)),
    cap: 'high',
    notes: ['reasoningAlwaysOn'],
    verifiedAt: '2026-10-03',
    sources: ['E01', 'E05', 'E11'],
  },
  {
    id: 'glm',
    matches: route => /glm-5[.-]3/.test(lowered(route)),
    cap: 'high',
    notes: ['textOnly', 'reasoningAlwaysOn'],
    verifiedAt: '2026-10-03',
    sources: ['E01', 'E02', 'E05', 'E06', 'E08'],
  },
  {
    id: 'claude-large',
    matches: route => /claude-(sonnet|opus)/.test(lowered(route)),
    cap: 'high',
    notes: ['maxEffortRegresses'],
    verifiedAt: '2026-10-03',
    sources: ['E02', 'E04', 'E09'],
  },
  {
    id: 'claude-haiku',
    matches: route => /claude-haiku/.test(lowered(route)),
    cap: 'medium',
    notes: [],
    verifiedAt: '2026-10-03',
    sources: ['E03', 'E07', 'E09', 'E10'],
  },
  {
    id: 'gemini-flash',
    matches: route => /gemini-.*flash/.test(lowered(route)),
    cap: 'medium',
    notes: [],
    verifiedAt: '2026-10-03',
    sources: ['E07', 'E10', 'E13'],
  },
] satisfies readonly ModelProfile[])

/**
 * The advice row for a route.
 * @param route - provider and model id.
 * @returns the first matching profile, or undefined for an unknown model.
 */
export function profileOf(route: RouteLike): ModelProfile | undefined {
  return MODEL_PROFILES.find(profile => profile.matches(route))
}

/**
 * Position of a level in the canonical order.
 * @param level - a reasoning level id.
 * @returns its rank, or -1 for an id DSH does not define.
 */
export function rankOf(level: string): number {
  return (EFFORT_ORDER as readonly string[]).indexOf(level)
}

/**
 * Whether a string is one of the canonical reasoning levels.
 * @param value - candidate.
 * @returns true for `off` through `max`.
 */
export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && rankOf(value) !== -1
}

/**
 * The ceiling for a subagent on one route.
 * @param route - the route the child will run on.
 * @param override - the operator's configured ceiling, which beats the profile.
 * @returns the highest level the plugin will pick on its own.
 */
export function capFor(route: RouteLike | undefined, override?: string): EffortLevel {
  if (override !== undefined && isEffortLevel(override)) return override
  return (route === undefined ? undefined : profileOf(route)?.cap) ?? DEFAULT_CAP
}

/**
 * Notes to show next to a route.
 * @param route - the route.
 * @returns the note ids, possibly none.
 */
export function notesFor(route: RouteLike): readonly NoteId[] {
  return profileOf(route)?.notes ?? []
}

/** Why {@link chooseEffort} decided what it did. */
export type EffortReason = 'explicit' | 'capped' | 'within-cap' | 'no-reasoning' | 'no-ladder'

/** The decision for one child. */
export interface EffortChoice {
  /** The level to send, or undefined to send nothing and keep what the route resolves by itself. */
  readonly effort: string | undefined
  readonly reason: EffortReason
  /** An explicit level the model does not offer, dropped in favor of the policy. */
  readonly dropped?: string
}

/** Inputs of {@link chooseEffort}. */
export interface EffortInput {
  /** The model's offered levels (`reasoning.efforts` ids): empty for a model without reasoning, undefined when unknown. */
  readonly ladder: readonly string[] | undefined
  /** The level the route would use on its own (route default, or the parent's level when inheriting). */
  readonly current: string | undefined
  /** A level the user or the operator asked for explicitly. */
  readonly explicit: string | undefined
  /** The ceiling for this route. */
  readonly cap: string
}

/**
 * Decide the reasoning effort for one child. An explicit, supported level wins
 * (the user chose it). Otherwise the level the route would use is kept when it
 * is within the ceiling, and lowered to the highest offered level not above
 * the ceiling when it is not; `off` is never picked on its own. A model's
 * ladder may skip rungs (GLM offers low, high and max), hence "highest not
 * above" instead of an exact match.
 * @param input - ladder, current level, explicit level and ceiling.
 * @returns the level to send (or undefined) and why.
 */
export function chooseEffort(input: EffortInput): EffortChoice {
  const { ladder, current, explicit, cap } = input
  if (ladder === undefined) return { effort: explicit, reason: explicit === undefined ? 'no-ladder' : 'explicit' }
  if (ladder.length === 0) return { effort: undefined, reason: 'no-reasoning', ...explicit === undefined ? {} : { dropped: explicit } }

  let dropped: string | undefined
  if (explicit !== undefined) {
    if (ladder.includes(explicit)) return { effort: explicit, reason: 'explicit' }
    dropped = explicit
  }
  const note = dropped === undefined ? {} : { dropped }

  const capRank = rankOf(cap)
  if (current !== undefined && rankOf(current) !== -1 && capRank !== -1 && rankOf(current) <= capRank) {
    return { effort: undefined, reason: 'within-cap', ...note }
  }
  const usable = ladder.filter(level => rankOf(level) > 0).sort((a, b) => rankOf(a) - rankOf(b))
  if (usable.length === 0) return { effort: undefined, reason: 'no-reasoning', ...note }
  const atOrBelow = capRank === -1 ? [] : usable.filter(level => rankOf(level) <= capRank)
  const picked = atOrBelow.length > 0 ? atOrBelow[atOrBelow.length - 1] : usable[0]
  return { effort: picked, reason: 'capped', ...note }
}
