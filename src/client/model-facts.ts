/**
 * Browser-side model facts for the model picker's capability strip: the input
 * modalities a model understands, and one headline score — Terminal-Bench 4
 * when the committed leaderboard snapshot knows the model, else OpenRouter's
 * intelligence index.
 *
 * Both sources are read here and nothing else: OpenRouter's `/models` endpoint
 * is public, CORS-open (`access-control-allow-origin: *`) and CDN-cached, so a
 * plain browser `fetch` works, and Terminal-Bench 4 ships as a build-time
 * snapshot (`src/bench.generated.ts`) because the official leaderboard sends no
 * CORS header and can never be fetched from a page. This module therefore adds
 * no runtime dependency to the browser bundle.
 *
 * The score follows the reasoning effort the user picked, as far as the data
 * allows:
 *   - Terminal-Bench 4 publishes one row per (model, effort): the strip shows
 *     the accuracy of the selected level, and falls back to the model's best
 *     accuracy when the board never measured that level (the neutral "model
 *     default" option always lands on that best value);
 *   - OpenRouter's intelligence index is a single scalar per model — there is
 *     no per-effort intelligence anywhere in the public API, and the plugin
 *     holds no key for the endpoints that would need one — so that score is
 *     literally the model's intelligence at its maximum effort and reads the
 *     same at every level.
 *
 * Matching is deliberately narrow — an id, never a guess:
 *   1. case-insensitive match on the full catalog id (`z-ai/glm-5.3`);
 *   2. for an id with no `/`, case-insensitive match on the slug part
 *      (`DeepSeek-V4.1-Flash` → slug `deepseek-v4.1-flash`), which is unique
 *      across authors in the catalog;
 *   3. alias entries (`~z-ai/glm-latest`) resolve through `alias_target.slug`;
 *   4. display names never match a catalog entry, and `:variant` suffixes are
 *      never stripped — `:free`/`:batch` are different catalog entries.
 * The only place a display name is consulted is the Terminal-Bench 4 lookup,
 * whose rows are keyed by the model's published name.
 * @module dsh-orquestrator/client/model-facts
 */

import { TB4_SCORES, normalizeModelName, type TerminalBenchRow } from '../bench.generated.ts'

/** What we know about a model beyond DSH's catalog. */
export interface ModelFacts {
  /** Input modalities the model understands (OpenRouter). */
  readonly modalities: { readonly text: boolean; readonly image: boolean; readonly audio: boolean; readonly video: boolean }
  /**
   * Headline score at the effort the caller asked for: Terminal-Bench 4 when the leaderboard knows the model, else
   * OpenRouter's intelligence index; null when none.
   */
  readonly score: { readonly kind: 'terminal-bench-4' | 'intelligence'; readonly value: string } | null
}

/** The public OpenRouter catalog: every model, its modalities and its indices. */
const MODELS_URL = 'https://openrouter.ai/api/v1/models'

/** Deadline for that one catalog call; a slower answer resolves to "nothing known" rather than stalling the strip. */
const FETCH_TIMEOUT_MS = 8_000

/** One catalog entry, reduced to what the strip needs. */
interface CatalogEntry {
  /** Lowercased full id, e.g. `z-ai/glm-5.3`. */
  readonly id: string
  /** Lowercased slug part of the id, e.g. `glm-5.3`. */
  readonly slug: string
  /** Input modalities the model accepts. */
  readonly modalities: ModelFacts['modalities']
  /** OpenRouter's intelligence index, or null when the catalog does not rate the model. */
  readonly intelligence: number | null
  /** Lowercased `alias_target.slug` of an alias entry, or null for a real model. */
  readonly aliasTarget: string | null
}

/** The catalog as lookup maps: no prototype, no `__proto__`/`constructor` surprises. */
interface Catalog {
  /** Lowercased full id → entry. */
  readonly byId: Map<string, CatalogEntry>
  /** Lowercased slug → entry, only for slugs no author shares. */
  readonly bySlug: Map<string, CatalogEntry>
}

/**
 * Terminal-Bench 4 rows by normalized model name. Built from own entries only,
 * so a picker called `Constructor` can never read `Object.prototype.constructor`.
 */
const terminalBench: Map<string, TerminalBenchRow> = new Map(
  Object.entries(TB4_SCORES).filter(([key, row]) => key !== '' && Number.isFinite(row.max)),
)

/** One catalog fetch per page: the promise *is* the cache, and a failed fetch caches "unavailable". */
let catalogPromise: Promise<Catalog | null> | null = null

/** The in-flight request, so the test hook can drop it. */
let inFlight: AbortController | null = null

/**
 * Facts already computed this session, keyed by model id, display name and effort. Negative results are cached too — a
 * model the catalog does not list stays unknown — and a failed catalog call is remembered by {@link catalogPromise}, so
 * no keystroke of the picker's filter, and no move of the effort ladder, ever starts another request.
 */
const factsCache = new Map<string, ModelFacts | null>()

/**
 * Facts for a picker model id (e.g. `z-ai/glm-5.3`, `DeepSeek-V4.1-Flash`), its display name and the reasoning effort
 * the user picked. Resolves null when nothing is known (no network, no match). Cached per (model, display name, effort)
 * trio; never rejects.
 * @param model - the model id the picker holds.
 * @param displayName - the model's display name, consulted only for Terminal-Bench 4 matching.
 * @param effort - the DSH ladder effort id (`low`, `medium`, `high`, `max`, `xhigh`, …), or null/undefined/`''` for the
 * neutral "model default" option; a level the leaderboard never measured falls back to the model's best accuracy.
 * @returns the facts, or null when nothing is known.
 */
export async function modelFactsOf(model: string, displayName?: string, effort?: string | null): Promise<ModelFacts | null> {
  // A caller that is not TypeScript can pass anything at all; "never rejects" has to survive that too.
  const id = typeof model === 'string' ? model : ''
  const name = typeof displayName === 'string' ? displayName : undefined
  const level = effortKeyOf(effort)
  const key = `${id}\u0000${normalizeModelName(name ?? '')}\u0000${level}`
  if (factsCache.has(key)) return factsCache.get(key) ?? null
  const catalog = await loadCatalog()
  // No catalog means "the network is not there", not "this model has nothing": leave it uncached at this level, the
  // catalog promise already keeps the picker from retrying.
  if (catalog === null) return null
  const facts = factsOf(catalog, id, name, level)
  factsCache.set(key, facts)
  return facts
}

/** Test hook: drop the cache and any in-flight fetch. */
export function resetModelFactsForTests(): void {
  factsCache.clear()
  catalogPromise = null
  const pending = inFlight
  inFlight = null
  pending?.abort()
}

/** The effort key a caller asked for: trimmed and lowercased, `''` for the neutral option or anything that is not a string. */
function effortKeyOf(effort: string | null | undefined): string {
  return typeof effort === 'string' ? effort.trim().toLowerCase() : ''
}

/** Facts for a model the catalog answered for; null when the catalog does not list it. */
function factsOf(catalog: Catalog, model: string, displayName: string | undefined, effort: string): ModelFacts | null {
  const entry = matchCatalog(catalog, model)
  if (entry === null) return null
  return { modalities: entry.modalities, score: scoreOf(entry, displayName, effort) }
}

/**
 * Match a picker id to a catalog entry, following at most one alias hop.
 * @param catalog - the indexed catalog.
 * @param model - the picker's model id.
 * @returns the entry, or null when the catalog does not list the id.
 */
function matchCatalog(catalog: Catalog, model: string): CatalogEntry | null {
  const wanted = model.trim().toLowerCase()
  if (wanted === '') return null
  // A bare slug is matched across authors (unique in the catalog); an id with an author is matched whole, so
  // `acme/glm-5.3` never borrows `z-ai/glm-5.3`'s facts.
  const entry = wanted.includes('/') ? catalog.byId.get(wanted) : catalog.bySlug.get(wanted)
  if (entry === undefined) return null
  if (entry.aliasTarget === null) return entry
  return catalog.byId.get(entry.aliasTarget) ?? catalog.bySlug.get(entry.aliasTarget) ?? entry
}

/**
 * Terminal-Bench 4 first (by normalized slug, then by display name), else the intelligence index, else nothing. The
 * Terminal-Bench value follows the selected effort — the accuracy the board published for that level, or the model's
 * best accuracy when the board never measured it, which is where the neutral option and an unknown level land.
 * @param entry - the matched catalog entry.
 * @param displayName - the picker's display name for the model, when it has one.
 * @param effort - the normalized effort key (`''` for the neutral option).
 * @returns the score, or null when neither source rates the model.
 */
function scoreOf(entry: CatalogEntry, displayName: string | undefined, effort: string): ModelFacts['score'] {
  for (const candidate of [entry.slug, displayName ?? '']) {
    const key = normalizeModelName(candidate)
    const row = key === '' ? undefined : terminalBench.get(key)
    if (row !== undefined) return { kind: 'terminal-bench-4', value: `${(effortAccuracy(row, effort) ?? row.max).toFixed(1)}%` }
  }
  return entry.intelligence === null ? null : { kind: 'intelligence', value: entry.intelligence.toFixed(1) }
}

/**
 * The accuracy the snapshot holds for one effort, when it holds a real number there.
 * @param row - the model's Terminal-Bench 4 entry.
 * @param effort - the normalized effort key (`''` for the neutral option, which is never looked up).
 * @returns the accuracy in percent, or null when the board never measured that level.
 */
function effortAccuracy(row: TerminalBenchRow, effort: string): number | null {
  // Own entries only: a picker level called `constructor` must not read `Object.prototype.constructor`.
  if (effort === '' || !Object.hasOwn(row.efforts, effort)) return null
  const value: number | undefined = row.efforts[effort]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** The shared catalog promise: created once, resolved to null on any failure. */
function loadCatalog(): Promise<Catalog | null> {
  catalogPromise ??= fetchCatalog()
  return catalogPromise
}

/** One bounded, never-throwing fetch of `/models`. */
async function fetchCatalog(): Promise<Catalog | null> {
  // Read at call time: the picker keeps working in a host that installs fetch late, and tests replace it.
  const fetcher: typeof fetch | undefined = globalThis.fetch
  if (typeof fetcher !== 'function') return null
  const controller = new AbortController()
  inFlight = controller
  const timer = setTimeout(() => { controller.abort() }, FETCH_TIMEOUT_MS)
  try {
    const response = await fetcher(MODELS_URL, { headers: { accept: 'application/json' }, signal: controller.signal })
    if (!response.ok) return null
    return indexCatalog(await response.json())
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    if (inFlight === controller) inFlight = null
  }
}

/** Index a `/models` payload; null when it is not the shape the catalog promises. */
function indexCatalog(payload: unknown): Catalog | null {
  const rows = catalogRows(payload)
  if (rows === null) return null
  const entries: CatalogEntry[] = []
  const slugCounts = new Map<string, number>()
  for (const row of rows) {
    if (!isRecord(row)) continue
    const id = row['id']
    if (typeof id !== 'string' || id.trim() === '') continue
    const key = id.trim().toLowerCase()
    const slash = key.lastIndexOf('/')
    const slug = slash === -1 ? key : key.slice(slash + 1)
    entries.push({
      id: key,
      slug,
      modalities: readModalities(row['architecture']),
      intelligence: readIntelligence(row['benchmarks']),
      aliasTarget: readAliasTarget(row['alias_target']),
    })
    slugCounts.set(slug, (slugCounts.get(slug) ?? 0) + 1)
  }
  if (entries.length === 0) return null
  const byId = new Map<string, CatalogEntry>()
  const bySlug = new Map<string, CatalogEntry>()
  for (const entry of entries) {
    if (!byId.has(entry.id)) byId.set(entry.id, entry)
    // An ambiguous slug is dropped rather than guessed: two authors may publish the same slug.
    if (slugCounts.get(entry.slug) === 1) bySlug.set(entry.slug, entry)
  }
  return { byId, bySlug }
}

/** The entry array of a `/models` payload (`{ data: [...] }`, or the array itself). */
function catalogRows(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload
  if (isRecord(payload) && Array.isArray(payload['data'])) return payload['data']
  return null
}

/** `architecture.input_modalities` → the four booleans the strip shows (`file` is not one of them). */
function readModalities(architecture: unknown): ModelFacts['modalities'] {
  const declared = isRecord(architecture) && Array.isArray(architecture['input_modalities']) ? architecture['input_modalities'] : []
  const seen = new Set<string>()
  for (const value of declared) if (typeof value === 'string') seen.add(value.toLowerCase())
  return { text: seen.has('text'), image: seen.has('image'), audio: seen.has('audio'), video: seen.has('video') }
}

/** `benchmarks.artificial_analysis.intelligence_index` when it is a real number. */
function readIntelligence(benchmarks: unknown): number | null {
  if (!isRecord(benchmarks)) return null
  const analysis = benchmarks['artificial_analysis']
  if (!isRecord(analysis)) return null
  const value = analysis['intelligence_index']
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** `alias_target.slug` of an alias entry, lowercased and trimmed. */
function readAliasTarget(alias: unknown): string | null {
  if (!isRecord(alias)) return null
  const slug = alias['slug']
  return typeof slug === 'string' && slug.trim() !== '' ? slug.trim().toLowerCase() : null
}

/** A plain object (not null, not an array) usable as a dictionary. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
