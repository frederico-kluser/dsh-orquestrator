#!/usr/bin/env node
/**
 * Regenerates `src/bench.generated.ts` — the Terminal-Bench 4 headline scores the browser bundle ships. The official
 * leaderboard (tbench.ai) sends no CORS header, so a page can never fetch it: these scores are committed data, and
 * only this script (never a build, never CI) goes to the network.
 *
 *   node scripts/gen-bench.mjs [--payload <file>] [--out <file>] [--date <YYYY-MM-DD>] [--verbose]
 *
 * The leaderboard is a Next.js React Server Component stream (`content-type: text/x-component`, ~98 KB) reached by
 * asking for `/leaderboard` with the `RSC: 1` header; each line is `<id>:<json>`, sometimes with a text-chunk tag
 * (`<id>:T<hexlen>,<json>`) in front of the JSON. The parser is deliberately blind to that framing: for every line it
 * tries the body as JSON, then the body from its first `{`/`[`, and walks every object in whatever it parsed, so a
 * shape change in the stream degrades to "fewer rows", never to a crash.
 *
 * Rows are the dehydrated react-query payload of Board 4-0-0, shaped as
 *   { leaderboard_id, metadata: { model_display: { label }, agent_display: { label }, reasoning_effort }, metrics: { accuracy } }
 * and, as a second accepted shape, a plain `{ model, agent, effort, accuracy }`. A model collapses into ONE entry per
 * normalized name holding two numbers: its accuracy AT EACH reasoning-effort label it was measured at (the highest
 * across harnesses when several ran the same level, keyed as the board writes the label — `max`, `xhigh`, `high`,
 * `medium`, `low`, `none`), and `max`, the best accuracy across all of its rows. The strip reads `efforts[selected]`,
 * and falls back to `max` for an effort the board never measured — so the entry carries every number the board
 * publishes about that model. Only the rows of Board 4-0-0 are kept (by `leaderboard_id`, when the stream names the
 * board); rows with no usable model name are dropped, and a row with no effort label contributes to `max` alone.
 *
 * `--payload <file>` skips the network and parses a saved stream, for reproducing a snapshot from a `curl` capture:
 *   curl -sL -H 'RSC: 1' https://www.tbench.ai/leaderboard -o tb4.txt && node scripts/gen-bench.mjs --payload tb4.txt
 *
 * A run that would fetch refuses to start when `CI` is set: this snapshot is committed data, and no build or pipeline
 * should ever reach the network (`CI= node scripts/gen-bench.mjs` overrides, for a developer who really means it).
 *
 * Exit codes: 0 wrote (or `--check` found the file current), 1 the source gave nothing usable (the file is left
 * untouched), 2 a bad command line. Dependencies: none.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Leaderboard stream; the `RSC: 1` header is what makes the server answer with the component stream. */
const LEADERBOARD_URL = 'https://www.tbench.ai/leaderboard'

/** How long one leaderboard request may take before the script gives up. */
const REQUEST_TIMEOUT_MS = 30_000

/** Board identity we expect to find in the stream, used only to label the snapshot (and to warn). */
const BOARD_NAME = '4-0-0'
const BOARD_TITLE = 'Terminal-Bench 4.0'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = parseArgs(process.argv.slice(2))
const outPath = args.out === undefined ? resolve(repoRoot, 'src/bench.generated.ts') : resolve(process.cwd(), args.out)

if (args.payload === undefined && process.env.CI !== undefined && process.env.CI !== '') {
  fail('refusing to fetch the leaderboard from a CI run — pass --payload <file>, or unset CI')
}
const source = args.payload === undefined ? await fromNetwork(LEADERBOARD_URL) : fromFile(args.payload)
const parsed = parseRows(source.text)

if (parsed.rows.length === 0) {
  fail(`no leaderboard rows in ${source.origin} (${String(source.text.length)} bytes, content-type ${source.contentType ?? 'unknown'})`)
}
if (!parsed.boardFound) {
  warn(`the stream never mentions ${BOARD_TITLE} / "${BOARD_NAME}"; writing the ${String(parsed.rows.length)} rows it did contain`)
}

const models = groupModels(parsed.rows)
if (models.length === 0) fail(`the ${String(parsed.rows.length)} rows contained no usable model names`)
const module = renderModule(models, { rows: parsed.rows.length, date: args.date ?? new Date().toISOString().slice(0, 10) })

if (args.check) {
  const current = existsSync(outPath) ? readFileSync(outPath, 'utf8') : ''
  if (current === module) {
    console.log(`gen-bench: up to date (${String(models.length)} models)`)
    process.exit(0)
  }
  console.error(`gen-bench: ${relative(repoRoot, outPath)} is stale — run node scripts/gen-bench.mjs`)
  process.exit(1)
}

writeFileSync(outPath, module)
console.log(`gen-bench: wrote ${relative(repoRoot, outPath)} — ${String(models.length)} models from ${String(parsed.rows.length)} rows (${source.origin}, ${String(args.date ?? new Date().toISOString().slice(0, 10))})`)
if (args.verbose) for (const model of models) {
  const levels = effortOrder([...model.efforts.keys()])
    .map((effort) => `${effort} ${String(model.efforts.get(effort)?.accuracy)}`)
    .join(', ')
  console.log(`  ${String(model.max).padStart(6)}  ${model.label}  (${[...model.agents].join('/')}: ${levels})`)
}

/**
 * Parse the command line.
 * @param {string[]} argv - arguments after the script name.
 * @returns {{ payload?: string, out?: string, date?: string, check: boolean, verbose: boolean }} the options.
 */
function parseArgs(argv) {
  /** @type {{ payload?: string, out?: string, date?: string, check: boolean, verbose: boolean }} */
  const options = { check: false, verbose: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--check') { options.check = true; continue }
    if (flag === '--verbose') { options.verbose = true; continue }
    if (flag === '--payload' || flag === '--out' || flag === '--date') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) usage(`${flag} needs a value`)
      index += 1
      if (flag === '--payload') options.payload = value
      else if (flag === '--out') options.out = value
      else options.date = value
      continue
    }
    usage(`unknown argument ${flag}`)
  }
  return options
}

/** One-line usage error. @param {string} message - what went wrong. @returns {never} never returns. */
function usage(message) {
  console.error(`gen-bench: ${message}`)
  console.error('usage: node scripts/gen-bench.mjs [--payload <file>] [--out <file>] [--date <YYYY-MM-DD>] [--check] [--verbose]')
  process.exit(2)
}

/** A fatal parse problem: the committed file is left as it was. @param {string} message - what went wrong. @returns {never} never returns. */
function fail(message) {
  console.error(`gen-bench: ${message}`)
  process.exit(1)
}

/** A non-fatal problem. @param {string} message - what to say. */
function warn(message) {
  console.error(`gen-bench: warning: ${message}`)
}

/**
 * Read the saved stream.
 * @param {string} path - the file to read, relative to the working directory.
 * @returns {{ text: string, origin: string, contentType: string | null }} the stream and where it came from.
 */
function fromFile(path) {
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path)
  if (!existsSync(absolute)) usage(`no such payload file: ${absolute}`)
  return { text: readFileSync(absolute, 'utf8'), origin: relative(process.cwd(), absolute) || absolute, contentType: null }
}

/**
 * Fetch the stream, retrying the framings the leaderboard may answer to.
 * @param {string} url - the leaderboard URL.
 * @returns {Promise<{ text: string, origin: string, contentType: string | null }>} the best answer seen.
 */
async function fromNetwork(url) {
  const attempts = [
    { headers: { RSC: '1', accept: 'text/x-component' }, label: 'RSC' },
    { headers: { RSC: '1', accept: 'text/x-component', 'next-router-prefetch': '1' }, label: 'RSC+prefetch' },
    { headers: { accept: 'text/html' }, label: 'html' },
  ]
  let last = null
  for (const attempt of attempts) {
    try {
      const response = await fetch(url, { headers: attempt.headers, redirect: 'follow', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      const text = await response.text()
      if (!response.ok) {
        warn(`${attempt.label} request answered HTTP ${String(response.status)}`)
        continue
      }
      const contentType = response.headers.get('content-type')
      last = { text, origin: `${attempt.label} ${response.url}`, contentType }
      // The stream that carries the board is the one with rows in it; keep looking when this framing gave a shell.
      if (text.includes('"accuracy"')) return last
    } catch (cause) {
      warn(`${attempt.label} request failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  if (last === null) fail(`could not reach ${url}`)
  return last
}

/**
 * Pull every leaderboard row (and the board identity) out of the stream.
 * @param {string} text - the raw stream body.
 * @returns {{ rows: { model: string, agent: string, effort: string, accuracy: number }[], boardFound: boolean, skipped: number }} what was found.
 */
function parseRows(text) {
  const nodes = collectNodes(parseStream(text))
  const boardIds = new Set()
  let boardFound = false
  for (const record of nodes) {
    const named = record.name === BOARD_NAME || record.title === BOARD_TITLE
      || (typeof record.title === 'string' && record.title.includes(BOARD_TITLE))
    if (!named) continue
    boardFound = true
    if (typeof record.id === 'string') boardIds.add(record.id)
  }
  const rows = []
  const seen = new Set()
  let skipped = 0
  for (const record of nodes) {
    const row = readRow(record)
    if (row === null) continue
    // A page can dehydrate several boards at once: keep the rows that name Board 4-0-0, and keep unnamed rows only when
    // the stream never identified the board at all.
    if (boardIds.size > 0 && typeof record.leaderboard_id === 'string' && !boardIds.has(record.leaderboard_id)) {
      skipped += 1
      continue
    }
    const key = `${row.model}\u0000${row.agent}\u0000${row.effort}`
    if (seen.has(key)) continue
    seen.add(key)
    rows.push(row)
  }
  if (skipped > 0) warn(`ignored ${String(skipped)} rows of other leaderboards`)
  return { rows, boardFound, skipped }
}

/**
 * Every object in the parsed stream, depth-first.
 * @param {unknown[]} values - the parsed top-level values.
 * @returns {Record<string, unknown>[]} the object nodes.
 */
function collectNodes(values) {
  const nodes = []
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (typeof value !== 'object' || value === null) return
    nodes.push(value)
    for (const nested of Object.values(value)) visit(nested)
  }
  for (const value of values) visit(value)
  return nodes
}

/**
 * Read one node as a leaderboard row, in either shape the board has answered with.
 * @param {Record<string, unknown>} record - one object node.
 * @returns {{ model: string, agent: string, effort: string, accuracy: number } | null} the row, or null when the node is not a row.
 */
function readRow(record) {
  const metrics = isRecord(record.metrics) ? record.metrics : undefined
  const accuracy = toAccuracy(metrics === undefined ? record.accuracy : metrics.accuracy ?? record.accuracy)
  if (accuracy === null) return null
  const metadata = isRecord(record.metadata) ? record.metadata : undefined
  const label = metadata === undefined ? undefined : displayLabel(metadata.model_display)
  if (label !== undefined) {
    return {
      model: label,
      agent: displayLabel(metadata?.agent_display) ?? '',
      effort: typeof metadata?.reasoning_effort === 'string' ? metadata.reasoning_effort : '',
      accuracy,
    }
  }
  if (typeof record.model !== 'string' || record.model.trim() === '') return null
  return {
    model: record.model.trim(),
    agent: typeof record.agent === 'string' ? record.agent : '',
    effort: typeof record.effort === 'string' ? record.effort : '',
    accuracy,
  }
}

/**
 * A display value as the board writes it: a plain string, or `{ label }`.
 * @param {unknown} value - the field.
 * @returns {string | undefined} the trimmed label, when there is one.
 */
function displayLabel(value) {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value.trim()
  if (isRecord(value) && typeof value.label === 'string' && value.label.trim() !== '') return value.label.trim()
  return undefined
}

/** @param {unknown} value - anything. @returns {boolean} true for a non-null, non-array object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Every JSON value in the stream: the whole body when it is one document, else line by line (`<id>:<json>`, with any
 * text-chunk tag skipped by starting at the first `{`/`[`).
 * @param {string} text - the raw stream body.
 * @returns {unknown[]} the parsed values, malformed lines dropped.
 */
function parseStream(text) {
  const whole = tryJson(text)
  if (whole !== undefined) return [whole]
  const values = []
  for (const line of text.split('\n')) {
    const body = line.slice(line.indexOf(':') + 1)
    if (body === '') continue
    const parsed = tryJson(body) ?? tryJson(body.slice(firstStructuredIndex(body)))
    if (parsed !== undefined) values.push(parsed)
  }
  return values
}

/** @param {string} text - candidate JSON. @returns {unknown | undefined} the value, or undefined when it is not JSON. */
function tryJson(text) {
  try {
    const value = JSON.parse(text)
    return value === null ? undefined : value
  } catch {
    return undefined
  }
}

/** @param {string} body - a line body. @returns {number} index of the first `{` or `[`, or 0. */
function firstStructuredIndex(body) {
  const brace = body.indexOf('{')
  const bracket = body.indexOf('[')
  if (brace === -1) return bracket === -1 ? 0 : bracket
  if (bracket === -1) return brace
  return Math.min(brace, bracket)
}

/** @param {unknown} value - a row's accuracy. @returns {number | null} a finite number, or null. */
function toAccuracy(value) {
  const number = typeof value === 'string' ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) ? number : null
}

/**
 * Collapse rows to one entry per model: the accuracy of every reasoning effort it was measured at (highest wins when
 * several harnesses ran the same level) plus `max`, the best accuracy across its rows. The label comes from the row
 * that set `max`, and ties keep the first row seen, so the render is byte-stable.
 * @param {{ model: string, agent: string, effort: string, accuracy: number }[]} rows - the parsed rows.
 * @returns {{ key: string, label: string, max: number, efforts: Map<string, { accuracy: number, agent: string }>, agents: Set<string> }[]} entries sorted by key.
 */
function groupModels(rows) {
  const byKey = new Map()
  for (const row of rows) {
    const key = normalizeModelName(row.model)
    if (key === '') continue
    let entry = byKey.get(key)
    if (entry === undefined) {
      entry = { key, label: row.model, max: Number.NEGATIVE_INFINITY, efforts: new Map(), agents: new Set() }
      byKey.set(key, entry)
    }
    if (row.agent !== '') entry.agents.add(row.agent)
    // A row with no effort label still counts for `max`: the board publishes the number, we just cannot attribute it.
    const effort = row.effort.trim().toLowerCase()
    const level = entry.efforts.get(effort)
    if (effort !== '' && (level === undefined || row.accuracy > level.accuracy)) {
      entry.efforts.set(effort, { accuracy: row.accuracy, agent: row.agent })
    }
    if (row.accuracy > entry.max) {
      entry.max = row.accuracy
      entry.label = row.model
    }
  }
  const models = [...byKey.values()]
  for (const model of models) if (!Number.isFinite(model.max)) model.max = 0
  return models.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
}

/**
 * The effort labels in the order the module renders them: the board's ladder from the top down, then anything the board
 * invents later, alphabetically, so a new label never reshuffles the committed file.
 * @param {string[]} labels - every label an entry holds.
 * @returns {string[]} the labels, ordered.
 */
function effortOrder(labels) {
  const ladder = ['max', 'xhigh', 'high', 'medium', 'low', 'none']
  const rank = (label) => {
    const index = ladder.indexOf(label)
    return index === -1 ? ladder.length : index
  }
  return [...labels].sort((left, right) => (rank(left) - rank(right)) || (left < right ? -1 : left > right ? 1 : 0))
}

/**
 * The normalization this snapshot's keys are built with, and the rule the runtime matcher uses. Kept here — next to the
 * keys it produced — so the data and the rule can never drift apart.
 * @param {string} name - a model id or display name.
 * @returns {string} lowercased, every non-alphanumeric character removed (`GLM-5.3` → `glm53`).
 */
function normalizeModelName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Quote a string as a TypeScript literal: single quotes, as the repository writes them, falling back to JSON when the
 * value would need escaping.
 * @param {string} value - the text to emit.
 * @returns {string} a TypeScript string literal.
 */
function quote(value) {
  return value.includes("'") || value.includes('\\') || /[\n\r\u2028\u2029]/.test(value) ? JSON.stringify(value) : `'${value}'`
}

/**
 * Render the TypeScript module, byte-for-byte deterministically.
 * @param {{ key: string, label: string, max: number, efforts: Map<string, { accuracy: number, agent: string }>, agents: Set<string> }[]} models - the grouped entries.
 * @param {{ rows: number, date: string }} provenance - rows parsed and the snapshot date.
 * @returns {string} the module text.
 */
function renderModule(models, provenance) {
  const entries = models.map((model) => {
    const levels = effortOrder([...model.efforts.keys()])
      .map((effort) => `${quote(effort)}: ${String(model.efforts.get(effort)?.accuracy)}`)
      .join(', ')
    const efforts = levels === '' ? '{}' : `{ ${levels} }`
    return `  ${quote(model.key)}: { label: ${quote(model.label)}, efforts: ${efforts}, max: ${String(model.max)} },`
  })
  return `/**
 * Generated by \`node scripts/gen-bench.mjs\` — do not edit by hand.
 *
 * Terminal-Bench 4 scores, one entry per model, keyed by {@link normalizeModelName}: the accuracy the official
 * leaderboard reports for that model AT EACH reasoning effort it was measured at, plus \`max\`, its best accuracy. The
 * browser cannot fetch the leaderboard (no CORS header), so this file is committed data, regenerated by the script
 * alone — never by a build.
 *
 * Board:     ${BOARD_TITLE} (${BOARD_NAME})
 * Source:    ${LEADERBOARD_URL}
 * Captured:  ${provenance.date}
 * Leaderboard rows parsed: ${String(provenance.rows)} — models kept: ${String(models.length)}
 * @module dsh-orquestrator/bench.generated
 */

/** One Terminal-Bench 4 model: its published name, its accuracy per reasoning effort, and its best accuracy. */
export interface TerminalBenchRow {
  /** The model name exactly as the leaderboard publishes it. */
  readonly label: string
  /** Accuracy in percent (0-100) per leaderboard effort label (\`max\`, \`xhigh\`, \`high\`, \`medium\`, \`low\`, \`none\`). */
  readonly efforts: Readonly<Record<string, number>>
  /** Best accuracy in percent (0-100) across every row of this model — the fallback for an effort the board never measured. */
  readonly max: number
}

/** Where the committed Terminal-Bench 4 snapshot came from. */
export interface TerminalBenchSnapshot {
  /** Board identifier as the leaderboard names it. */
  readonly board: string
  /** Board title as the leaderboard names it. */
  readonly title: string
  /** The payload's URL. */
  readonly source: string
  /** UTC date (YYYY-MM-DD) of the capture. */
  readonly capturedAt: string
  /** Leaderboard rows parsed before grouping. */
  readonly rows: number
  /** Models kept after grouping (one per normalized name). */
  readonly models: number
}

/** Provenance of {@link TB4_SCORES}. */
export const TB4_SNAPSHOT: TerminalBenchSnapshot = {
  board: ${quote(BOARD_NAME)},
  title: ${quote(BOARD_TITLE)},
  source: ${quote(LEADERBOARD_URL)},
  capturedAt: ${quote(provenance.date)},
  rows: ${String(provenance.rows)},
  models: ${String(models.length)},
}

/**
 * Terminal-Bench 4 scores by normalized model name: the accuracy per reasoning effort, and the best accuracy across
 * rows. Read \`efforts[effort]\` first, then \`max\` — an effort the board never measured has no entry of its own.
 */
export const TB4_SCORES: Readonly<Record<string, TerminalBenchRow>> = {
${entries.join('\n')}
}

/**
 * Reduce a model name to this snapshot's key: lowercase, every non-alphanumeric character removed. The runtime applies
 * it to a model slug and to the picker's display name, so \`GLM-5.3\`, \`glm 5.3\` and the slug \`glm-5.3\` all land on
 * \`glm53\`.
 * @param name - a model id, slug or display name.
 * @returns the normalized key (empty when the name holds no alphanumeric character).
 */
export function normalizeModelName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}
`
}
