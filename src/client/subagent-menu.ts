/**
 * The marks on DSH's subagent menu. The menu in the task header (the dropdown
 * that lists a conversation's subagents) is closed UI: it takes no slot, so
 * this controller decorates its DOM from outside. It watches the page body
 * for the menu, works out which child session each row is, and puts two small
 * elements into the row: a status icon (a spinner while the subagent runs, a
 * check when it is done, a cross when it failed, a square when it was
 * stopped, a neutral dot when the outcome is not recorded) and a label with
 * the model it runs on.
 *
 * It is fail-open by construction. It selects nothing by class (DSH's classes
 * are hashed in production): only roles, aria attributes and structure. DSH's
 * own status dot is never moved or edited (the stylesheet hides it once the
 * row carries our icon), so React's reconciliation is untouched. A row whose
 * structure is not what DSH 0.1.6 renders, or that it cannot tell for sure
 * which subagent it is, is skipped and keeps looking the way DSH draws it.
 * Nothing here throws into DSH: every observer, timer and promise
 * continuation is wrapped, the first failure is reported once, and disposing
 * removes every element and attribute this controller added.
 * @module dsh-orquestrator/client/subagent-menu
 */

import type { SubagentRecord, SubagentsPayload } from '../shared.ts'
import type { CatalogState } from './catalog.ts'
import type { CatalogGroupLike, LocaleLike, SessionSummaryLike, SessionsLike } from './host-types.ts'
import { NS, type OrchestratorKey } from './locales.ts'
import {
  describeRoute, entryLabel, markFor, ownValue, resolveRows, type DomRow, type MarkState, type RouteLabel, type RowMark,
} from './subagent-marks.ts'
import type { SubagentsClient } from './subagents-client.ts'

/** The timer functions the controller schedules with (the page's own unless a test injects others). */
export interface MarksTimers {
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

/** What the controller reaches through. */
export interface SubagentMarksDeps {
  /** The page's document: its body is watched for the native subagent menu. */
  readonly document: Document
  /** The session registry; its `list` store carries the subagent catalogs and the session summaries. */
  readonly sessions: SessionsLike
  /** The locale runtime: the menu's own title (to recognize it) and this plugin's texts. */
  readonly locale: LocaleLike
  /** The host ledger carrier: which model each subagent runs on and how it ended. */
  readonly client: Pick<SubagentsClient, 'list'>
  /** The sessions whose conversation is on the page right now. */
  readonly visibleSessionIds: () => readonly string[]
  /** Load the model catalog (display names of models and efforts) for a session. */
  readonly loadCatalog: (sessionId: string) => Promise<CatalogState>
  /** Diagnostics sink (never user-visible); the controller reports its first failure once. */
  readonly warn: (message: string, error?: unknown) => void
  /** How often an open menu re-reads the ledger and re-checks its rows; 2000 by default. */
  readonly pollMs?: number
  /** Timer functions; the page's own by default. */
  readonly timers?: MarksTimers
  /** The page's clock in epoch milliseconds (it times the ledger answers and the model-name cache); `Date.now` by default. */
  readonly now?: () => number
}

/** The bound translate function of this plugin's namespace. */
type Translate = (key: OrchestratorKey, params?: Record<string, unknown>) => string

/** Everything the controller keeps about one open menu. */
interface MenuState {
  readonly menu: Element
  /** The page's clock when the menu was found. */
  readonly attachedAt: number
  /** The subtree observer: row additions, removals and replacements. */
  observer: MutationObserver | undefined
  /** Whether the poll interval was started (its handle may legitimately be any value). */
  polling: boolean
  interval: unknown
  /** Store and locale subscriptions, released when the menu leaves. */
  readonly unsubscribers: (() => void)[]
  /** The session whose catalog is the menu's first level, once found. */
  root: string | undefined
  /** Each marked row's catalog activity at the previous scan, to notice a status flip. */
  activities: ReadonlyMap<string, string>
  scanQueued: boolean
  /** Whether the model names were asked for (or found fresh) for this opening of the menu. */
  catalogAsked: boolean
  /** Cancels the pending debounced re-read of the ledger. */
  cancelRefetch: (() => void) | undefined
  detached: boolean
}

/** What one ledger answer taught, and when. */
interface Ledger {
  readonly records: ReadonlyMap<string, SubagentRecord>
  /** The host's clock when it answered, if it says (the records' times are in that clock). */
  readonly hostNow: number | undefined
  /** The page's clock when the answer arrived. */
  readonly receivedAt: number
}

/** A ledger request in flight. */
interface Request {
  readonly controller: AbortController
  /** Stops the watchdog that gives up on a carrier that never answers. */
  cancelWatchdog: () => void
}

const SVG_NS = 'http://www.w3.org/2000/svg'
/** Class of the status icon host (ours, so selecting by it is safe). */
const ICON_CLASS = 'dsh-orq-sub-icon'
/** Class of the model label host. */
const MODEL_CLASS = 'dsh-orq-sub-model'
/** Class of the model label itself. */
const TAG_CLASS = 'dsh-orq-sub-tag'
/** Prefix of the ids this controller gives its elements (a row's `aria-describedby` points at them). */
const ID_PREFIX = 'dsh-orq-sub-'
/** Attribute that marks a row as decorated (the stylesheet hides DSH's own dot on such a row). */
const ROW_ATTR = 'data-orq-row'
/** Attribute that carries the state the icon draws. */
const STATE_ATTR = 'data-orq-state'
/** Locale namespace of DSH's own subagent menu, and the key of its title. */
const NATIVE_NS = 'subagent'
const NATIVE_TREE_KEY = 'tree.aria'
/** Poll period of an open menu. */
const DEFAULT_POLL_MS = 2_000
/** How long the model names are reused before the catalog is asked again. */
const CATALOG_TTL_MS = 60_000
/** How long a model catalog request that never answers blocks the next one. */
const CATALOG_RETRY_MS = 30_000
/** Wait before the ledger is re-read after a status flip, so the host has recorded the ending. */
const REFETCH_DELAY_MS = 250
/** How long a first-time menu waits for the ledger before it draws status from the catalog alone. */
const STATUS_GRACE_MS = 1_500
/** How long a ledger request may stay unanswered before the controller gives up on it (the carrier's own deadline is shorter). */
const LEDGER_WATCHDOG_MS = 8_000
/** Ledgers kept (one per root session) so a reopened menu paints with what it knew. */
const MAX_LEDGERS = 16
/** The `data-state` values of DSH's StateDot: the only element a row's status dot can be. */
const DOT_SELECTOR = ['ongoing', 'done', 'error', 'idle', 'warning'].map(state => `[data-state="${state}"]`).join(', ')
const OWN_SELECTOR = `.${ICON_CLASS}, .${MODEL_CLASS}`
/** The stop reasons the dictionary names; any other reason is printed as the host sent it. */
const REASON_KEYS: Readonly<Record<string, OrchestratorKey>> = {
  'error': 'sub.reason.error',
  'max-tokens': 'sub.reason.max-tokens',
  'refusal': 'sub.reason.refusal',
}
/** Where the live controller of a document is kept, so that a newer one can retire it (a plugin reload). */
const LIVE_KEY = Symbol.for('dsh-orquestrator.subagent-marks')
/** Unique per page load, so ids stay unique even when two copies of this module meet. */
const PAGE_TOKEN = Math.random().toString(36).slice(2, 8)
let idCounter = 0

/** A new id for one of our elements. */
function nextId(): string {
  idCounter += 1
  return `${ID_PREFIX}${PAGE_TOKEN}-${String(idCounter)}`
}

/** Whether a node is one of the hosts this controller inserts. */
function isOwn(node: Node): boolean {
  if (node.nodeType !== 1) return false
  const { classList } = node as Element
  return classList.contains(ICON_CLASS) || classList.contains(MODEL_CLASS)
}

/** Whether a mutation only reports this controller's own insertions, removals or edits. */
function isOwnMutation(record: MutationRecord): boolean {
  const target = record.target
  const element = target.nodeType === 1 ? (target as Element) : target.parentElement
  if (element?.closest(OWN_SELECTOR) != null) return true
  const nodes = [...record.addedNodes, ...record.removedNodes]
  return nodes.length > 0 && nodes.every(isOwn)
}

/** What the controller reads from a `[role="treeitem"]` row. */
function readRow(item: Element): DomRow {
  const current = item.getAttribute('aria-current')
  return {
    level: Number(item.getAttribute('aria-level')),
    label: item.getAttribute('aria-label') ?? '',
    disabled: item.getAttribute('aria-disabled') === 'true',
    current: current !== null && current !== 'false',
  }
}

/** The first child of an element that carries a class. */
function childWithClass(parent: Element, className: string): Element | undefined {
  for (const child of parent.children) {
    if (child.classList.contains(className)) return child
  }
  return undefined
}

/** Remove the children that carry a class, except the one to keep. */
function removeOthers(parent: Element, className: string, keep: Element): void {
  for (const child of Array.from(parent.children)) {
    if (child !== keep && child.classList.contains(className)) child.remove()
  }
}

/** Write an attribute only when its value differs, so an unchanged row costs no mutation. */
function setIfChanged(element: Element, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value)
}

/** Give an element an id of ours, unless it has one. */
function ensureId(element: Element): string {
  if (element.id === '') element.id = nextId()
  return element.id
}

/**
 * Point a row's `aria-describedby` at the ids of our elements, keeping any id DSH (or anything else) put there.
 * React does not own this attribute on the row, so a re-render leaves it alone.
 * @param row - a `[role="treeitem"]` element.
 * @param ids - the ids to point at (none removes ours).
 */
function setDescribedBy(row: Element, ids: readonly string[]): void {
  const kept = (row.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(token => token !== '' && !token.startsWith(ID_PREFIX))
  const next = [...kept, ...ids].join(' ')
  if (next !== '') setIfChanged(row, 'aria-describedby', next)
  else if (row.hasAttribute('aria-describedby')) row.removeAttribute('aria-describedby')
}

/** An SVG element with attributes. */
function svgNode(doc: Document, name: string, attributes: Readonly<Record<string, string>>): SVGElement {
  const node = doc.createElementNS(SVG_NS, name)
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value)
  return node
}

/** Stroke style shared by every glyph; the color is the host's `currentColor`. */
const LINE: Readonly<Record<string, string>> = {
  fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
}

/**
 * The 14 px glyph of a state, built with `createElementNS` (never from markup). The running ring's spin is CSS.
 * @param doc - the document that owns the node.
 * @param state - the state to draw.
 * @returns the svg element.
 */
function glyph(doc: Document, state: MarkState): SVGElement {
  const svg = svgNode(doc, 'svg', {
    width: '14', height: '14', viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true', focusable: 'false',
  })
  const ring = (radius: string, extra: Readonly<Record<string, string>> = {}): SVGElement => (
    svgNode(doc, 'circle', { cx: '7', cy: '7', r: radius, ...LINE, ...extra })
  )
  const stroke = (d: string): SVGElement => svgNode(doc, 'path', { d, ...LINE })
  switch (state) {
    case 'running':
      // A faint ring with a 90 degree arc on it; the stylesheet spins the whole svg.
      svg.append(ring('5.25', { 'stroke-opacity': '0.25' }), stroke('M7 1.75A5.25 5.25 0 0 1 12.25 7'))
      break
    case 'done':
      svg.append(ring('5.5', { 'stroke-width': '1.25' }), stroke('M4.6 7.2 6.3 8.9 9.5 5.3'))
      break
    case 'failed':
      svg.append(ring('5.5', { 'stroke-width': '1.25' }), stroke('M5.2 5.2 8.8 8.8M8.8 5.2 5.2 8.8'))
      break
    case 'stopped':
      svg.append(
        ring('5.5', { 'stroke-width': '1.25' }),
        svgNode(doc, 'rect', { x: '5.2', y: '5.2', width: '3.6', height: '3.6', rx: '0.7', fill: 'currentColor' }),
      )
      break
    case 'unknown':
      svg.append(svgNode(doc, 'circle', { cx: '7', cy: '7', r: '2', fill: 'currentColor' }))
      break
  }
  return svg
}

/** What the icon says in words (its `aria-label` and tooltip). A stop reason the dictionary knows is spelled out; any other is printed as the host sent it. */
function statusText(mark: RowMark, t: Translate): string {
  switch (mark.state) {
    case 'running': return t('sub.status.running')
    case 'done': return t('sub.status.done')
    case 'failed': {
      const reason = mark.stopReason
      if (reason === null || reason === '') return t('sub.status.failed')
      const key = Object.hasOwn(REASON_KEYS, reason) ? REASON_KEYS[reason] : undefined
      return t('sub.status.failedReason', { reason: key === undefined ? reason : t(key) })
    }
    case 'stopped': return t('sub.status.stopped')
    case 'unknown': return t('sub.status.unknown')
  }
}

/** The parts of a decoratable row: DSH's status dot, the element that holds it, and the text block that follows it. */
interface Anatomy {
  readonly dot: Element
  readonly host: Element
  readonly content: Element
}

/**
 * Find the parts of a row, using structure only: the status dot is the row's `[data-state]` element and the text
 * block is the element that follows it (our own icon, when it already sits in between, does not count). The text
 * block must hold the row's label: a DSH that rearranged the row so that something else follows the dot is not
 * given a model label in the wrong place.
 * @param row - a `[role="treeitem"]` element.
 * @param label - the label the row's entry renders.
 * @returns the parts, or undefined when the row is not shaped like a DSH child row.
 */
function anatomyOf(row: Element, label: string): Anatomy | undefined {
  const dot = row.querySelector(DOT_SELECTOR)
  const host = dot?.parentElement
  if (dot == null || host == null) return undefined
  let content = dot.nextElementSibling
  while (content !== null && isOwn(content)) content = content.nextElementSibling
  if (content === null || !(content.textContent ?? '').startsWith(label)) return undefined
  return { dot, host, content }
}

/**
 * Take every element and attribute this controller put on a row off again.
 * @param row - a `[role="treeitem"]` element.
 */
function clearRow(row: Element): void {
  for (const element of Array.from(row.querySelectorAll(OWN_SELECTOR))) element.remove()
  if (row.hasAttribute(ROW_ATTR)) row.removeAttribute(ROW_ATTR)
  setDescribedBy(row, [])
}

/**
 * Take everything this controller added off a whole menu.
 * @param root - the menu element.
 */
function sweep(root: Element): void {
  for (const element of Array.from(root.querySelectorAll(`${OWN_SELECTOR}, [${ROW_ATTR}], [aria-describedby*="${ID_PREFIX}"]`))) {
    if (isOwn(element)) {
      element.remove()
      continue
    }
    if (element.hasAttribute(ROW_ATTR)) element.removeAttribute(ROW_ATTR)
    setDescribedBy(element, [])
  }
}

/** The model label of a route; a catalog that cannot be read costs the display names, not the label. */
function routeLabel(groups: readonly CatalogGroupLike[], route: RowMark['route']): RouteLabel | undefined {
  try {
    return describeRoute(groups, route)
  } catch {
    return route === null ? undefined : { model: route.model, effort: route.reasoningEffort ?? null }
  }
}

/**
 * Draw one row's mark, idempotently: nothing is touched unless the state or the text changed. The status icon is
 * inserted immediately before DSH's dot (which stays where React put it), the model label is appended to the
 * text block, and the row's `aria-describedby` points at both so that a screen reader hears them with the row.
 * @param doc - the document that owns the nodes.
 * @param row - a `[role="treeitem"]` element.
 * @param mark - what to show.
 * @param label - the label the row's entry renders (the text block must start with it).
 * @param status - whether the status icon may be drawn yet (the model label is drawn either way).
 * @param groups - the model catalog groups (empty until the catalog loaded: raw ids show).
 * @param t - this plugin's translate function.
 * @param live - whether the controller is still running: the translator is outside code, and may have retired it.
 * @returns false when the row is not shaped like a DSH child row, or the controller was retired meanwhile (nothing was added, and anything we added is gone).
 * @throws when a text cannot be written (the translator failed) or the DOM refuses; the row is then back as DSH drew it.
 */
function applyMark(
  doc: Document,
  row: Element,
  mark: RowMark,
  label: string,
  status: boolean,
  groups: readonly CatalogGroupLike[],
  t: Translate,
  live: () => boolean,
): boolean {
  const anatomy = anatomyOf(row, label)
  if (anatomy === undefined) {
    clearRow(row)
    return false
  }
  const { dot, host, content } = anatomy

  // Everything that can fail on its own (the translator, the catalog lookup) is worked out before the DOM is
  // touched, so that a failure cannot leave half a mark next to DSH's own dot.
  const text = statusText(mark, t)
  const model = routeLabel(groups, mark.route)
  const shown = model === undefined ? '' : model.effort === null ? model.model : `${model.model} \u00b7 ${model.effort}`
  const title = model === undefined
    ? ''
    : model.effort === null
      ? t('sub.model.title', { model: model.model })
      : t('sub.model.titleEffort', { model: model.model, effort: model.effort })
  if (!live()) return false

  try {
    let icon = childWithClass(host, ICON_CLASS)
    if (status) {
      if (icon === undefined) {
        icon = doc.createElement('span')
        icon.className = ICON_CLASS
        icon.setAttribute('role', 'img')
        host.insertBefore(icon, dot)
      } else if (icon.nextElementSibling !== dot) {
        host.insertBefore(icon, dot)
      }
      removeOthers(host, ICON_CLASS, icon)
      if (icon.getAttribute(STATE_ATTR) !== mark.state || icon.firstElementChild === null) {
        icon.setAttribute(STATE_ATTR, mark.state)
        icon.replaceChildren(glyph(doc, mark.state))
      }
      ensureId(icon)
      setIfChanged(icon, 'aria-label', text)
      setIfChanged(icon, 'title', text)
      // The stylesheet hides DSH's dot only for a marked row whose dot follows our icon, so this goes after the icon.
      setIfChanged(row, ROW_ATTR, '')
    } else if (icon !== undefined) {
      // Nothing status-related until the ledger has answered: a mark left from another root goes, and DSH's own dot shows.
      icon.remove()
      icon = undefined
      if (row.hasAttribute(ROW_ATTR)) row.removeAttribute(ROW_ATTR)
    }

    let tag: Element | undefined
    let modelHost = childWithClass(content, MODEL_CLASS)
    if (model === undefined) {
      modelHost?.remove()
    } else {
      if (modelHost === undefined) {
        modelHost = doc.createElement('span')
        modelHost.className = MODEL_CLASS
        content.append(modelHost)
      }
      removeOthers(content, MODEL_CLASS, modelHost)
      tag = childWithClass(modelHost, TAG_CLASS)
      if (tag === undefined) {
        tag = doc.createElement('span')
        tag.className = TAG_CLASS
        modelHost.append(tag)
      }
      ensureId(tag)
      if (tag.textContent !== shown) tag.textContent = shown
      setIfChanged(tag, 'title', title)
    }
    setDescribedBy(row, [icon?.id ?? '', tag?.id ?? ''].filter(id => id !== ''))
    return true
  } catch (error: unknown) {
    clearRow(row)
    throw error
  }
}

/**
 * Start decorating DSH's subagent menu whenever it opens. Fail-open and silent: with no session list, no
 * MutationObserver or any failure of its own it leaves the menu exactly as DSH draws it, and it never throws. A
 * newer controller on the same document retires the older one first, so two never fight over the same rows.
 * @param deps - the page, the stores and carriers it reads, and the diagnostics sink.
 * @returns the disposer: it stops every observer, timer, subscription and request, and removes every element and attribute added.
 */
export function installSubagentMarks(deps: SubagentMarksDeps): () => void {
  let disposed = false
  let warned = false
  let bodyObserver: MutationObserver | undefined
  const doc = deps.document
  const menus = new Map<Element, MenuState>()
  /** The last ledger answer per root session. */
  const ledgers = new Map<string, Ledger>()
  const inflight = new Map<string, Request>()
  const again = new Set<string>()
  let groups: readonly CatalogGroupLike[] = []
  let groupsAt: number | undefined
  /** The model catalog request in flight, if any (a request that never answers stops blocking after a while). */
  let groupsRequest: { readonly at: number } | undefined

  const pollMs = typeof deps.pollMs === 'number' && Number.isFinite(deps.pollMs) && deps.pollMs > 0 ? deps.pollMs : DEFAULT_POLL_MS
  const timers: MarksTimers = deps.timers ?? {
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (handle) => { globalThis.clearInterval(handle as ReturnType<typeof setInterval>) },
  }
  const clock = (): number => (deps.now === undefined ? Date.now() : deps.now())

  /** Report the first failure, once; later ones would only repeat it on every poll. */
  const fail = (message: string, error?: unknown): void => {
    if (warned) return
    warned = true
    try {
      deps.warn(message, error)
    } catch {
      // A broken diagnostics sink must not break the page either.
    }
  }

  /** Run a callback that must never throw into the page. */
  const guarded = (task: () => void): void => {
    try {
      task()
    } catch (error: unknown) {
      fail('the subagent menu marks failed; the menu stays as DSH draws it', error)
    }
  }

  /** Run an async task whose failure must never surface as an unhandled rejection. */
  const spawn = (task: () => Promise<void>): void => {
    try {
      task().catch((error: unknown) => { fail('the subagent menu marks failed; the menu stays as DSH draws it', error) })
    } catch (error: unknown) {
      fail('the subagent menu marks failed; the menu stays as DSH draws it', error)
    }
  }

  /** A one-shot timer built on the injected interval API, so a test drives every timer through one fake. */
  const later = (ms: number, task: () => void): (() => void) => {
    let handle: unknown
    let live = true
    const cancel = (): void => {
      if (!live) return
      live = false
      guarded(() => { timers.clearInterval(handle) })
    }
    handle = timers.setInterval(() => {
      if (!live) return
      cancel()
      guarded(task)
    }, ms)
    return cancel
  }

  /** Re-scan a menu once, however many things asked for it in this turn. */
  function scheduleScan(state: MenuState): void {
    if (disposed || state.detached || state.scanQueued) return
    state.scanQueued = true
    const run = (): void => {
      state.scanQueued = false
      guarded(() => { scan(state) })
    }
    if (typeof queueMicrotask === 'function') queueMicrotask(run)
    else void Promise.resolve().then(run)
  }

  function rescanAll(): void {
    for (const state of [...menus.values()]) scheduleScan(state)
  }

  /** Keep what a ledger request found, newest last, bounded. A failed request keeps what was known (and says an answer came). */
  function settle(root: string, payload: SubagentsPayload | undefined): void {
    const previous = ledgers.get(root)
    if (payload === undefined && previous !== undefined) return
    const records = new Map<string, SubagentRecord>()
    for (const record of payload?.subagents ?? []) records.set(record.id, record)
    ledgers.delete(root)
    ledgers.set(root, { records, hostNow: payload?.now, receivedAt: clock() })
    while (ledgers.size > MAX_LEDGERS) {
      const oldest = ledgers.keys().next()
      if (oldest.done === true) break
      ledgers.delete(oldest.value)
    }
  }

  /**
   * Now, in the clock the ledger's times are in. The host's clock when it said what time it was, carried forward by
   * the time that has passed here since (a delta of this page's own clock, so a skewed or tunnelled browser clock
   * cannot misjudge a record's age); this page's clock only for a host that does not say.
   */
  function ledgerClock(ledger: Ledger): number {
    const here = clock()
    return ledger.hostNow === undefined ? here : ledger.hostNow + Math.max(0, here - ledger.receivedAt)
  }

  /** Read the ledger of a root session; one request at a time per root, and never one that waits for ever. */
  function refresh(root: string, trailing: boolean): void {
    if (disposed) return
    if (inflight.has(root)) {
      // A burst of flips asks again; a poll that finds a slow request pending does not, or a slow host would be asked nonstop.
      if (trailing) again.add(root)
      return
    }
    const controller = new AbortController()
    const request: Request = { controller, cancelWatchdog: () => undefined }
    inflight.set(root, request)
    request.cancelWatchdog = later(LEDGER_WATCHDOG_MS, () => {
      // The carrier did not answer, and a fetch that ignores its signal never will: stop waiting, count it as a failed
      // answer (so the marks stop waiting for it too), and let the next poll ask again.
      if (inflight.get(root) === request) inflight.delete(root)
      guarded(() => { controller.abort() })
      fail('the subagent ledger did not answer in time')
      settle(root, undefined)
      rescanAll()
      if (again.delete(root)) refresh(root, false)
    })
    spawn(async () => {
      let payload: SubagentsPayload | undefined
      try {
        payload = await deps.client.list(root, controller.signal)
      } catch (error: unknown) {
        if (!controller.signal.aborted) fail('could not read the subagent ledger', error)
      }
      if (controller.signal.aborted || disposed) return
      request.cancelWatchdog()
      if (inflight.get(root) === request) inflight.delete(root)
      settle(root, payload)
      rescanAll()
      if (again.delete(root)) refresh(root, false)
    })
  }

  /** Ask for the model names once per opening of a menu, and reuse them for a minute. */
  function ensureGroups(state: MenuState, visible: readonly string[]): void {
    if (state.catalogAsked) return
    const sessionId = visible[0] ?? state.root
    if (sessionId === undefined) return
    state.catalogAsked = true
    const now = clock()
    const age = groupsAt === undefined ? Number.POSITIVE_INFINITY : now - groupsAt
    if (age >= 0 && age < CATALOG_TTL_MS) return
    if (groupsRequest !== undefined && now - groupsRequest.at >= 0 && now - groupsRequest.at < CATALOG_RETRY_MS) return
    const request = { at: now }
    groupsRequest = request
    spawn(async () => {
      try {
        const loaded = await deps.loadCatalog(sessionId)
        if (!disposed && loaded.status === 'ready' && Array.isArray(loaded.groups)) {
          groups = loaded.groups
          groupsAt = clock()
        }
      } finally {
        if (groupsRequest === request) groupsRequest = undefined
      }
      if (!disposed) rescanAll()
    })
  }

  /** The sessions that are on the page; a failing source costs the candidates it would have given, not the scan. */
  function visibleIds(): readonly string[] {
    try {
      const ids = deps.visibleSessionIds()
      return Array.isArray(ids) ? ids : []
    } catch (error: unknown) {
      fail('could not list the visible conversations', error)
      return []
    }
  }

  /**
   * The sessions the page shows: each visible conversation and every ancestor of it, walking `parentId` while the
   * session is a subagent (DSH's header does the same, and gives each of those crumbs its own menu, so any of them
   * can be the root of the menu that is open).
   */
  function sessionsOnPage(byId: Readonly<Record<string, SessionSummaryLike>>, visible: readonly string[]): string[] {
    const ids = new Set<string>()
    for (const start of visible) {
      let cursor: string | undefined = start
      while (cursor !== undefined && !ids.has(cursor)) {
        ids.add(cursor)
        const summary: SessionSummaryLike | undefined = ownValue(byId, cursor)
        cursor = summary?.origin === 'subagent' ? summary.parentId : undefined
      }
    }
    return [...ids]
  }

  /** Re-read the menu and bring its marks up to date. */
  function scan(state: MenuState): void {
    if (disposed || state.detached) return
    if (!state.menu.isConnected) {
      detach(state)
      return
    }
    const list = deps.sessions.list
    if (list === undefined) return
    const snapshot = list.getSnapshot()
    const items = Array.from(state.menu.querySelectorAll('[role="treeitem"]'))
    const visible = visibleIds()
    const onPage = sessionsOnPage(snapshot.byId, visible)
    const onPageSet = new Set(onPage)
    // Candidates, most likely first: the conversations on the page and their ancestors, then every other owner of a catalog.
    const tiers = [onPage, Object.keys(snapshot.subagentsByParent).filter(id => !onPageSet.has(id))]
    const resolved = resolveRows(items.map(readRow), snapshot.subagentsByParent, tiers, {
      titleOf: (id) => {
        const title = ownValue(snapshot.byId, id)?.title
        return typeof title === 'string' ? title : undefined
      },
      onPage,
    })
    const t: Translate = deps.locale.bind(NS)
    // A callback above may have disposed the controller, or taken the menu away: nothing is drawn then.
    if (disposed || state.detached) return
    if (resolved.root !== state.root) {
      state.root = resolved.root
      if (resolved.root !== undefined) refresh(resolved.root, false)
    }
    const ledger = state.root === undefined ? undefined : ledgers.get(state.root)
    // The first time a menu opens, DSH's own dots stay until the ledger has answered (or failed, or a moment passed),
    // instead of showing "outcome not recorded" for a few frames; the model label needs no ledger and is drawn at once.
    const status = ledger !== undefined || clock() - state.attachedAt >= STATUS_GRACE_MS
    const now = ledger === undefined ? clock() : ledgerClock(ledger)
    const activities = new Map<string, string>()
    items.forEach((item, index) => {
      try {
        const hit = resolved.rows[index]
        if (hit === undefined) {
          clearRow(item)
          return
        }
        activities.set(hit.entry.id, hit.entry.activity)
        const mark = markFor(hit.entry, ledger?.records.get(hit.entry.id), ownValue(snapshot.byId, hit.entry.id), now)
        applyMark(doc, item, mark, entryLabel(hit.entry), status, groups, t, () => !disposed && !state.detached)
      } catch (error: unknown) {
        fail('could not mark a row of the subagent menu; it stays as DSH draws it', error)
      }
    })
    if (disposed || state.detached) return
    let flipped = false
    for (const [id, activity] of activities) {
      const before = state.activities.get(id)
      if (before !== undefined && before !== activity) flipped = true
    }
    state.activities = activities
    // A status flip is the moment the ledger changes; ask for it again soon (and the poll keeps asking every tick).
    if (flipped && state.root !== undefined) scheduleRefetch(state)
    ensureGroups(state, visible)
  }

  /** One debounced re-read of the ledger after a status flip. */
  function scheduleRefetch(state: MenuState): void {
    if (state.cancelRefetch !== undefined || state.detached) return
    state.cancelRefetch = later(REFETCH_DELAY_MS, () => {
      state.cancelRefetch = undefined
      if (!state.detached && state.root !== undefined) refresh(state.root, true)
    })
  }

  /** The poll: re-read the ledger of the menu's root and re-check its rows. */
  function tick(state: MenuState): void {
    if (disposed || state.detached) return
    if (!state.menu.isConnected) {
      detach(state)
      return
    }
    if (state.root !== undefined) refresh(state.root, false)
    scheduleScan(state)
  }

  /** Start decorating one menu. */
  function attach(menu: Element): void {
    const list = deps.sessions.list
    const Observer = doc.defaultView?.MutationObserver
    if (list === undefined || Observer === undefined) return
    const state: MenuState = {
      menu,
      attachedAt: clock(),
      observer: undefined,
      polling: false,
      interval: undefined,
      unsubscribers: [],
      root: undefined,
      activities: new Map(),
      scanQueued: false,
      catalogAsked: false,
      cancelRefetch: undefined,
      detached: false,
    }
    menus.set(menu, state)
    try {
      state.observer = new Observer((records) => {
        guarded(() => {
          if (records.some(record => !isOwnMutation(record))) scheduleScan(state)
        })
      })
      state.observer.observe(menu, { childList: true, subtree: true })
      // A status flip in the store re-scans; so does a language switch (the marks carry translated text).
      guarded(() => { state.unsubscribers.push(list.subscribe(() => { scheduleScan(state) })) })
      guarded(() => { state.unsubscribers.push(deps.locale.subscribe(() => { scheduleScan(state) })) })
      guarded(() => { scan(state) })
      state.interval = timers.setInterval(() => { guarded(() => { tick(state) }) }, pollMs)
      state.polling = true
    } catch (error: unknown) {
      fail('could not decorate the subagent menu; it stays as DSH draws it', error)
      detach(state)
    }
  }

  /** Stop decorating one menu and take its marks off. */
  function detach(state: MenuState): void {
    if (state.detached) return
    state.detached = true
    menus.delete(state.menu)
    guarded(() => { state.observer?.disconnect() })
    if (state.polling) guarded(() => { timers.clearInterval(state.interval) })
    state.cancelRefetch?.()
    state.cancelRefetch = undefined
    for (const unsubscribe of state.unsubscribers) guarded(unsubscribe)
    state.unsubscribers.length = 0
    guarded(() => { sweep(state.menu) })
  }

  /** The title DSH's own menu carries in the active language, or undefined when it cannot be looked up. */
  function nativeTitle(): string | undefined {
    try {
      const title = deps.locale.bind(NATIVE_NS)(NATIVE_TREE_KEY)
      // The runtime answers with the key itself for a namespace or key it does not know.
      return typeof title === 'string' && title !== '' && title !== NATIVE_TREE_KEY ? title : undefined
    } catch {
      return undefined
    }
  }

  /** Whether a body-level `role="tree"` is DSH's subagent menu. */
  function isSubagentMenu(element: Element): boolean {
    const title = nativeTitle()
    if (title !== undefined) return element.getAttribute('aria-label') === title
    // The title cannot be looked up: accept a tree that has rows, every one of which carries a status dot.
    const items = Array.from(element.querySelectorAll('[role="treeitem"]'))
    return items.length > 0 && items.every(item => item.querySelector(DOT_SELECTOR) !== null)
  }

  /** Look at one node that appeared on the body. */
  function consider(node: Node): void {
    if (disposed || node.nodeType !== 1) return
    const element = node as Element
    if (menus.has(element) || !element.isConnected || element.getAttribute('role') !== 'tree') return
    if (isSubagentMenu(element)) attach(element)
  }

  /** Where the live controller of this document is kept (see {@link LIVE_KEY}). */
  const registry = doc as unknown as Record<symbol, { dispose(): void } | undefined>
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    guarded(() => { bodyObserver?.disconnect() })
    bodyObserver = undefined
    for (const state of [...menus.values()]) detach(state)
    for (const request of inflight.values()) {
      request.cancelWatchdog()
      guarded(() => { request.controller.abort() })
    }
    inflight.clear()
    again.clear()
    ledgers.clear()
    guarded(() => { delete registry[LIVE_KEY] })
  }

  try {
    // One controller per document: a newer one (a plugin reload) retires the older, so that two never decorate and
    // sweep the same rows against each other.
    guarded(() => { registry[LIVE_KEY]?.dispose() })
    const Observer = doc.defaultView?.MutationObserver
    const body = doc.body as HTMLElement | null
    if (Observer === undefined || body === null) {
      fail('the page has no body to watch for the subagent menu; the menu stays as DSH draws it')
      return dispose
    }
    guarded(() => { registry[LIVE_KEY] = { dispose } })
    // The native menu is portaled to the body, so its children are all that has to be watched.
    bodyObserver = new Observer((records) => {
      guarded(() => {
        for (const record of records) {
          for (const node of Array.from(record.removedNodes)) {
            const state = menus.get(node as Element)
            if (state !== undefined) detach(state)
          }
          for (const node of Array.from(record.addedNodes)) consider(node)
        }
      })
    })
    bodyObserver.observe(body, { childList: true })
    for (const child of Array.from(body.children)) guarded(() => { consider(child) })
  } catch (error: unknown) {
    fail('could not start the subagent menu marks; the menu stays as DSH draws it', error)
    dispose()
  }
  return dispose
}
