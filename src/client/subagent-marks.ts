/**
 * What the marks on DSH's subagent menu say, decided without a DOM: which
 * catalog entry each row of the menu is, which state a row is in, and which
 * model label it shows. The controller (`subagent-menu.ts`) only feeds this
 * module what it read from the page and draws what comes back, so every rule
 * here is testable on plain data.
 * @module dsh-orquestrator/client/subagent-marks
 */

import type { ModelRoute, SubagentRecord, SubagentState } from '../shared.ts'
import { ladderOf, modelName } from './catalog.ts'
import type {
  CatalogGroupLike, SessionSummaryLike, SubagentCatalogEntryLike, SubagentCatalogLike,
} from './host-types.ts'

/** One row of the catalog that is a real child session (a diagnostic row is never marked). */
export type ChildEntry = Extract<SubagentCatalogEntryLike, { readonly kind: 'child' }>

/** What the controller read from one `[role="treeitem"]` row of the menu, in DOM order. */
export interface DomRow {
  /** The row's `aria-level` (1 for the first level). A missing, non-finite or non-positive level counts as 1. */
  readonly level: number
  /**
   * The row's `aria-label`. DSH builds it as `label title · mode · activity metrics` (the title only when the session
   * list has one; a diagnostic row is `id reason`).
   */
  readonly label: string
  /** Whether the row is `aria-disabled` (loading placeholders and diagnostics): never marked. */
  readonly disabled: boolean
  /** Whether the row carries `aria-current`: DSH sets it, in a switcher menu only, on the row of the conversation the page shows. */
  readonly current?: boolean
}

/** What the page tells about the rows beyond their labels; both parts are optional and only ever narrow the match. */
export interface RowContext {
  /** The title the session list holds for a session; DSH puts it right after the label in the row's `aria-label`. */
  readonly titleOf?: (id: string) => string | undefined
  /** The sessions the page shows (the visible conversations and their ancestors): the row marked `aria-current` is one of them. */
  readonly onPage?: readonly string[]
}

/** The catalog entry a DOM row stands for. */
export interface ResolvedRow {
  /** The session whose catalog lists the entry (the menu's root for the first level). */
  readonly parentId: string
  /** The child entry. */
  readonly entry: ChildEntry
}

/** What the marks can show: a state from the host ledger, or `unknown` when the outcome is not recorded. */
export type MarkState = SubagentState | 'unknown'

/** What one row shows. */
export interface RowMark {
  /** The state the status icon draws. */
  readonly state: MarkState
  /** The terminal stop reason of the latest run, when the ledger knows it. */
  readonly stopReason: string | null
  /** The model route the child runs on, when known. */
  readonly route: ModelRoute | null
}

/** A model label: the display name of the model and of the reasoning effort. */
export interface RouteLabel {
  /** The model's display name (the raw id when the catalog does not know it). */
  readonly model: string
  /** The reasoning effort's display name (the raw id when the ladder does not know it); null when the route carries none. */
  readonly effort: string | null
}

/**
 * How long a ledger `running` record is believed while the catalog already says the child is not live. The host
 * records the end of a run within milliseconds of the child's last turn, so a record still `running` this long after
 * the catalog went quiet means the end event was missed, and a spinner that could spin forever is worse than a
 * neutral mark.
 */
export const STALE_RUNNING_MS = 5_000

/** The deepest nesting resolved; the menu is a tree of sessions, so anything deeper is not a real menu. */
const MAX_LEVEL = 64

/**
 * Read an own property of a table keyed by session id. A plain index would answer for `constructor` or `__proto__`.
 * @param table - the table, or undefined.
 * @param key - the key.
 * @returns the value, or undefined when the table has no own entry for the key.
 */
export function ownValue<T>(table: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  if (table === undefined || table === null || typeof table !== 'object') return undefined
  return Object.hasOwn(table, key) ? table[key] : undefined
}

/**
 * The label DSH renders for a child entry: the creation label, or the session id when it has none.
 * @param entry - a child entry.
 * @returns the text the row's label element holds.
 */
export function entryLabel(entry: ChildEntry): string {
  return entry.label ?? entry.id
}

/** The catalog of one parent, or undefined when it is missing or malformed. */
function catalogOf(catalogs: Readonly<Record<string, SubagentCatalogLike>>, id: string): SubagentCatalogLike | undefined {
  const catalog = ownValue(catalogs, id)
  return catalog !== undefined && catalog !== null && Array.isArray(catalog.entries) ? catalog : undefined
}

/** Normalize an `aria-level`: a missing, NaN, infinite or non-positive level counts as the first level. */
function levelOf(raw: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) return 1
  return Math.floor(raw)
}

/**
 * Whether a row can be the row of an entry. DSH builds a child row's `aria-label` as
 * `[label, [title, mode, activity].join(' · '), metrics]` joined by spaces, with the title only when the session
 * list has one, so with a title the label must be followed by it and a middle dot, and without one by a space (or
 * nothing). A label that merely begins the same way (`Review` and `Review the auth module`) is another row. An empty
 * label fits nothing: DSH drops it from the row, so there is nothing to compare. A diagnostic row is `id reason`.
 */
function fits(entry: SubagentCatalogEntryLike, label: string, titleOf: ((id: string) => string | undefined) | undefined): boolean {
  if (entry === null || typeof entry !== 'object') return false
  const expected = entry.kind === 'child' ? entry.label ?? entry.id : entry.id
  if (typeof label !== 'string' || typeof expected !== 'string' || expected === '') return false
  if (entry.kind === 'child') {
    const title = titleOf?.(entry.id)
    if (typeof title === 'string') return label.startsWith(`${expected} ${title} \u00b7 `)
  }
  return label === expected || label.startsWith(`${expected} `)
}

/** Whether a catalog is the first level of the menu: as many entries as first-level rows, each one fitting its row. */
function fitsRoot(catalog: SubagentCatalogLike, firstLevel: readonly DomRow[], titleOf: RowContext['titleOf']): boolean {
  const entries = catalog.entries
  return entries.length === firstLevel.length && entries.every((entry, index) => fits(entry, firstLevel[index]?.label ?? '', titleOf))
}

/** Candidate tiers from what the caller passed: a flat list is one tier. */
function tiersOf(candidates: unknown): readonly (readonly string[])[] {
  if (!Array.isArray(candidates)) return []
  if (candidates.length > 0 && candidates.every(Array.isArray)) return candidates as readonly (readonly string[])[]
  return [candidates as readonly string[]]
}

/**
 * The one session whose catalog is the first level of the menu, or undefined when none fits or the match is
 * ambiguous. The tiers are tried in order: the first tier that has a fitting catalog decides, and when it has
 * several the answer is "not known" rather than a guess, because a wrong guess marks one conversation's children
 * with another's outcomes. Among several fitting catalogs the only tie-breaker is DSH's own `aria-current` marker
 * (a switcher menu puts it on the row of the conversation the page shows): the catalog whose marked row is a
 * session on the page wins, when exactly one does.
 */
function rootOf(
  firstLevel: readonly DomRow[],
  catalogs: Readonly<Record<string, SubagentCatalogLike>>,
  tiers: readonly (readonly string[])[],
  context: RowContext,
): string | undefined {
  const onPage = new Set(Array.isArray(context.onPage) ? context.onPage : [])
  for (const tier of tiers) {
    if (!Array.isArray(tier)) continue
    const fitting: string[] = []
    for (const id of new Set(tier)) {
      const catalog = typeof id === 'string' ? catalogOf(catalogs, id) : undefined
      if (catalog !== undefined && fitsRoot(catalog, firstLevel, context.titleOf)) fitting.push(id)
    }
    if (fitting.length === 0) continue
    if (fitting.length === 1) return fitting[0]
    const marked = fitting.filter((id) => {
      const entries = catalogOf(catalogs, id)?.entries ?? []
      return firstLevel.some((row, index) => {
        const entry = entries[index]
        return row.current === true && entry !== undefined && entry !== null && entry.kind === 'child' && onPage.has(entry.id)
      })
    })
    return marked.length === 1 ? marked[0] : undefined
  }
  return undefined
}

/** One group of rows that belong to the same parent: the next entry index of its catalog. */
interface Frame {
  readonly parentId: string
  next: number
}

/**
 * Work out which catalog entry each row of DSH's subagent menu is. The menu is a tree: its first-level rows are
 * the root catalog's entries in order, and an expanded row owns a group of rows one level deeper that are its own
 * catalog's entries in order. Nothing in a row says which session the catalog belongs to, so the root is found by
 * comparing counts and labels (see {@link RowContext}), and every row is then checked against the entry its
 * position names.
 *
 * A row resolves only when its entry exists, is a `child` entry and its label fits the row. Disabled rows (loading
 * placeholders, diagnostics) and mismatches resolve to undefined, and so does everything nested under an unresolved
 * row. When the root cannot be told, nothing resolves. Never throws, whatever the input.
 * @param rows - the menu's rows in DOM order.
 * @param catalogs - the session list's catalogs, keyed by the parent session id.
 * @param candidates - the sessions that may be the menu's root: either one list, or tiers of lists, most likely tier first. The first tier with a fitting catalog decides; two fitting catalogs in it resolve nothing.
 * @param context - the session titles and the sessions on the page, which only narrow the match.
 * @returns the root (undefined when it cannot be told) and, per row, the entry it stands for.
 */
export function resolveRows(
  rows: readonly DomRow[],
  catalogs: Readonly<Record<string, SubagentCatalogLike>>,
  candidates: readonly string[] | readonly (readonly string[])[],
  context: RowContext = {},
): { root: string | undefined; rows: (ResolvedRow | undefined)[] } {
  if (!Array.isArray(rows)) return { root: undefined, rows: [] }
  // The answer always lines up with the rows it was asked about.
  const none = (): { root: string | undefined; rows: (ResolvedRow | undefined)[] } => ({ root: undefined, rows: rows.map(() => undefined) })
  const firstLevel = rows.filter(row => levelOf(row.level) === 1)
  if (firstLevel.length === 0) return none()
  const root = rootOf(firstLevel, catalogs, tiersOf(candidates), context)
  if (root === undefined) return none()

  const frames: (Frame | undefined)[] = [undefined, { parentId: root, next: 0 }]
  const resolved: (ResolvedRow | undefined)[] = []
  for (const row of rows) {
    const level = levelOf(row.level)
    if (level > MAX_LEVEL) {
      resolved.push(undefined)
      continue
    }
    const frame = frames[level]
    frames.length = level + 1
    let hit: ResolvedRow | undefined
    if (frame !== undefined) {
      // Every row of a group is one entry of the parent's catalog, whatever it renders as, so the position advances for
      // disabled rows and diagnostics too.
      const entry = catalogOf(catalogs, frame.parentId)?.entries[frame.next]
      frame.next += 1
      if (entry !== undefined && entry !== null && entry.kind === 'child' && !row.disabled && fits(entry, row.label, context.titleOf)) {
        hit = { parentId: frame.parentId, entry }
      }
    }
    frames[level + 1] = hit === undefined ? undefined : { parentId: hit.entry.id, next: 0 }
    resolved.push(hit)
  }
  return { root, rows: resolved }
}

/** The route of the latest model request of a session, when the session list carries a well-formed one. */
function lastUsedRoute(summary: SessionSummaryLike | undefined): ModelRoute | null {
  const used = summary?.projectionValues?.modelSelection?.lastUsed
  if (used === undefined || used === null) return null
  const { provider, model, reasoningEffort } = used
  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return null
  return typeof reasoningEffort === 'string' && reasoningEffort !== ''
    ? { provider, model, reasoningEffort }
    : { provider, model }
}

/**
 * Decide what one row shows. The host ledger is fresher than DSH's catalog, so a ledger record decides the state
 * when there is one; the catalog's `activity` decides only when there is none.
 *
 * - a `done`, `failed` or `stopped` record is that state, with its stop reason, even while the catalog still says the
 *   child is running (the catalog lags);
 * - a `running` record is `running` while the catalog says the child is live or the record is younger than
 *   {@link STALE_RUNNING_MS}; an older one the catalog calls not live is `unknown` (a missed end event), so a spinner
 *   can never spin forever;
 * - with no record, a live child is `running` and anything else is `unknown`.
 *
 * The route is the latest one the session list saw the child use (DSH's own `lastUsed`), else the ledger's. The
 * ledger keeps the route requested at the start, which a continuable child may have outgrown, so it only fills in
 * for a child that has not made its first request yet.
 * @param entry - the catalog entry the row stands for.
 * @param record - the host ledger's record of that child, when there is one.
 * @param summary - the session list's summary of that child, when there is one.
 * @param now - the current time in epoch milliseconds, in the clock of the record's times (the host's).
 * @returns the mark to draw.
 */
export function markFor(
  entry: ChildEntry,
  record: SubagentRecord | undefined,
  summary: SessionSummaryLike | undefined,
  now: number,
): RowMark {
  const route = lastUsedRoute(summary) ?? record?.route ?? null
  if (record === undefined) {
    return { state: entry.activity === 'running' ? 'running' : 'unknown', stopReason: null, route }
  }
  if (record.state !== 'running') return { state: record.state, stopReason: record.stopReason, route }
  const believed = entry.activity === 'running' || now - record.startedAt < STALE_RUNNING_MS
  return { state: believed ? 'running' : 'unknown', stopReason: null, route }
}

/**
 * The label a row shows for the model it runs on.
 * @param groups - the model catalog groups (empty until the catalog loaded).
 * @param route - the route the child runs on, or null when it is not known.
 * @returns the model's display name and the effort's display name (the raw ids when the catalog lacks them), or undefined without a route.
 */
export function describeRoute(groups: readonly CatalogGroupLike[], route: ModelRoute | null): RouteLabel | undefined {
  if (route === null) return undefined
  const model = modelName(groups, route)
  const effort = route.reasoningEffort
  if (effort === undefined || effort === '') return { model, effort: null }
  return { model, effort: ladderOf(groups, route)?.efforts.find(level => level.id === effort)?.name ?? effort }
}
