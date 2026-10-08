#!/usr/bin/env node
/**
 * Browser end-to-end checks of the orchestration dialog against a REAL DSH web server running on an isolated
 * DSH_HOME (never the operator's own): the orchestration-skill checkbox, the native reasoning-effort select and the
 * selected model's capability strip. Companion of `ui-e2e.mjs`, same style: a `check()` helper, one
 * `<phase>.report.json`, screenshots.
 *
 *   DSH_URL=<authenticated dsh web URL> ORQ_SESSIONS_DIR=<sessions dir> [OUT_DIR=<dir>] [CHROME_PATH=<chrome>] \
 *     [STEPS=conversation,facts,child,themes,wire,queue] PHASE=skill node ui-e2e-skill.mjs
 *   STEPS=facts PHASE=skill scripts/e2e/with-server.sh node scripts/e2e/ui-e2e-skill.mjs    starts that isolated server for you
 *
 * PHASE:
 *   skill   the one phase. `STEPS` (default: all six) picks which groups run:
 *     conversation  S1..S5 and S7 in ONE conversation, plus the extras that need the same conversation
 *                   S1  new task: the dialog has ONE checkbox ("Apply the orchestration skill to this task"), CHECKED and
 *                       ENABLED even though the "Subagent model" switch is OFF (the box is NOT gated by that switch: the
 *                       0.8.1 coupling is gone), the task preview, no remember/ask-again box, and NO "Reasoning effort"
 *                       section: no Show/Hide button, no heading, no paragraph — the effort is a plain native <select>,
 *                       always visible, sitting directly under the switch while the switch is off
 *                   S2  confirm with the switch off and the box left at its default (ticked): the message goes out as
 *                       typed with `/orchestrate-subagents` on a line of its own AT THE END, DSH injected the skill
 *                       (`source.kind === 'skill-invocation'`), and the answer is remembered
 *                   S3  the switch and a model come first (the home's own DeepSeek V4.1 Flash route): the box stays ticked and enabled, the
 *                       effort select jumps to that model's HIGHEST level (its LAST option) the moment the model is
 *                       picked, and the send carries the token, one injection and that auto-max level on the wire
 *                   S4  the ways OUT of the dialog (Escape, the ✕, the Cancel button, a click on the mask) ABORT the send
 *                       (0.8.3 reversed the 0.6.0 behavior): no message reaches the log or the transcript, NO configuration
 *                       is written, and the composer still holds the text that was typed; the next dialog is unchanged
 *                   S5  `/orquestrar` (configure mode, nothing is sent): no skill section, no checkbox, and closing it
 *                       stores nothing
 *                   S7  keyboard: Tab never leaves the dialog, Space toggles the checkbox, Escape cancels the send (the
 *                       draft stays in the composer and the next dialog still works); Enter confirms
 *                   X   a token the user typed (first word or inside the text) is not doubled and LOCKS the box (ticked and
 *                       disabled), a multi-line task keeps the token on its own last line, an attachment-only message gets the
 *                       token as a text part in front of the file, the answer survives a reload and reaches a new conversation
 *                       (and a cancel there leaves its draft in the composer), the skill + a subagent model travel together (the
 *                       configuration carries nothing about the skill), an OFF -> ON round trip of the switch leaves the STORED
 *                       effort level untouched (AUTO-MAX fires on a model change, not on the switch), a model change does
 *                       auto-max, and the conversation's title is non-empty and carries no token (a provider-generated title
 *                       is fine)
 *     facts         the capability strip and the effort select, driven by a FIXTURE: `page.route` on
 *                   `https://openrouter.ai/api/v1/models` answers exactly three models, so the four modality icons (audio,
 *                   photo, text, video) are asserted marked/dimmed per model and the score badge is matched loosely
 *                   (/Terminal-Bench 4|Intelligence|Inteligência|智能/); the effort select is asserted to be a native
 *                   <select> whose options are the model's ladder plus one first NEUTRAL option, positioned immediately below
 *                   the model select (else directly under the switch), and to auto-max on every model change. F5 then walks
 *                   the badge over every option of the ladder, the neutral first one included, one arm per KIND of
 *                   headline: a Terminal-Bench 4 model must show its committed snapshot accuracy (`glm53: 41.82` — one row
 *                   per model, so the value at its MAX is the value everywhere) and an Intelligence model its intercepted
 *                   intelligence index (the real field `benchmarks.artificial_analysis.intelligence_index`, ONE scalar per
 *                   model — OpenRouter carries no per-effort intelligence at all). Both are therefore CONSTANT across the
 *                   ladder, which is the documented fallback ("a level with no number of its own: the value at the model's
 *                   MAX") and not a bug; a value that really MOVES (GPT-6 Astra: low 50.61 / medium 54.24 / max 58.18)
 *                   needs a snapshot model with several rows that this home's picker does not offer, so that half is a
 *                   SKIP, the data layer's own unit tests covering it with the real rows. One extra pass runs WITHOUT the
 *                   interception and only REPORTS what the live catalog showed (never an assertion)
 *     child         S10 a subagent's OWN conversation (a continuable child opened from its parent's header dropdown): the dialog
 *                       has NO skill section and the message that goes out has no token (its Escape cancels the send like
 *                       everywhere else, so the capture is what witnesses the "Send with these options" half). The prompt
 *                       request is captured and aborted, so no model ever runs there. The parent and its continuable child are
 *                       read from the session logs, never from a title written down here; skipped, cleanly, when the home has
 *                       no such child
 *     themes        S6  light theme (the checkbox and the effort select render, readable) and a 1024x600 screen (dark and
 *                       light) with the subagent model on and the skill section: the dialog fits and the primary action
 *                       stays reachable (the stack only has to scroll when the content is taller than its box). Each theme
 *                       also asserts the effort select's OWN computed paint (0.8.3): a background it really draws (never
 *                       transparent, never white in the dark theme) with text at contrast >= 4.5, resting and focused
 *     wire          S8  `page.route` on the configuration route: a host without the `skill` field (older than 0.8), a host that
 *                       says `available: false`, a malformed offer and a failing route show NO section and send NO token; the
 *                       unmodified route brings the section back; a failing save keeps the dialog and the answer
 *     queue         a message sent WHILE a turn runs: the dialog opens and the token is carried by the queued message
 *   S9 (every step)     no uncaught page errors and no failed `/dsh-orquestrator/` responses
 *
 * Cancel (0.8.3, a REVERSAL of the 0.6.0 behavior those paths had): Escape, the ✕, the Cancel button and a click on the mask
 * ABORT the send. Only "Send with these options" sends. Every cancel path is asserted on the same four observables: nothing
 * in the session log (`absent`, which never waits for a turn), no bubble in the transcript, the draft STILL in the composer
 * (`composerText`), and not one configuration write on the wire. In `/orquestrar` configure mode there is no send at all:
 * closing it just stores nothing, which is unchanged.
 *
 * The dialog's copy is never pinned here: the checkbox is found by role, its label by the DOM around it, the levels by
 * the escalation vocabulary the host itself uses (`off`, `low`, `medium`, `high`, `xhigh`, `max`, matched loosely), and
 * the effort ladder's SIZE is witnessed against the home's own `settings.yaml` (so the "+ one neutral option" count is
 * checked against the model's declared `reasoningEfforts`, not against a number written down here).
 *
 * Attribution: `landed(s, text)` never uses turn NUMBERS. DSH's "New session" reuses an abandoned blank session (which may
 * already hold turns) and a message sent while a turn runs lands in its own later turn, so baselining a turn count still
 * attributed the wrong turn (the "alpha instead of juliet" symptom, found by the 0.8.2 verifier). The sent message is
 * located BY ITS TEXT in the session log and the events that follow THAT message are the ones checked: DSH appends a
 * message inside the turn it already opened, so the first `turn/end` after it closes its own turn.
 *
 * Composer: every send settles the composer first — no text left by the previous send, no attachment still uploading and
 * no stale file card. Racing an upload left the file attached after a failed send and the next message went out carrying
 * that stale part (found by the 0.8.2 verifier). What the composer really holds is verified before Enter, because a lost
 * keystroke sent a truncated task (": juliet") and every later check then reported the wrong text.
 *
 * Models: ONLY the main agent of the isolated home (GLM 5.3) and, for the subagent picker, the DeepSeek V4.1 Flash route
 * that home carries — the isolated home is built from the operator's own settings, so the Azure route and the OpenRouter
 * one both occur and the first candidate the picker really offers is resolved at run time. Every run is a one-word
 * answer; the script waits for the turn to end (60 s at most) and presses "Stop generating" otherwise.
 * The session logs (`<ORQ_SESSIONS_DIR>/<workspace>/<session-id>/session.v3.jsonl.zstd`, read with `zstd -dc`) are the
 * evidence of what DSH received, so `zstd` must be on PATH.
 *
 * Writes <OUT_DIR>/skill.report.json (checks, advice, the log event shapes, the wire) and screenshots `skill-*.png`.
 * The token in DSH_URL is a per-process credential: it is never written out (every message is scrubbed).
 */
import { chromium } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const url = process.env.DSH_URL
const phase = process.env.PHASE ?? 'skill'
const out = resolve(process.env.OUT_DIR ?? join(repo, '.validation-tmp', 'out-dialog'))
const steps = new Set((process.env.STEPS ?? 'conversation,facts,child,themes,wire,queue').split(',').map((item) => item.trim()).filter(Boolean))
const sessionsDir = process.env.ORQ_SESSIONS_DIR ?? (process.env.DSH_HOME === undefined ? undefined : join(process.env.DSH_HOME, 'sessions'))
if (phase !== 'skill') {
  console.error(`unknown phase: ${phase}`)
  process.exit(2)
}
if (url === undefined) throw new Error('DSH_URL is required')
if (sessionsDir === undefined) throw new Error('ORQ_SESSIONS_DIR (or DSH_HOME) is required: the checks read the DSH session logs')
mkdirSync(out, { recursive: true })

/** Strip anything that could carry the per-process token out of a message. */
const scrub = (value) => String(value)
  .split(url).join('<dsh-url>')
  .replace(/token=[A-Za-z0-9_-]+/g, 'token=<x>')
  .replace(/https?:\/\/127\.0\.0\.1:\d+/g, 'http://127.0.0.1:<port>')

// A crash must not print the URL (Playwright puts it in some messages).
for (const event of ['unhandledRejection', 'uncaughtException']) {
  process.on(event, (error) => {
    console.error(`${event}: ${scrub(error?.stack ?? error)}`)
    process.exit(1)
  })
}

// DSH lands either on the new-session view ("Describe what you want to build") or on a blank conversation ("Message or run a
// task"): a start-up race of its own, so the helpers take whichever composer is there.
const COMPOSER = /Describe what you want to build|Message or run a task/
const DIALOG = 'Orchestrate subagents'
const SKILL = 'orchestrate-subagents'
const TOKEN = `/${SKILL}`
const SKILL_TITLE = 'Orchestration skill'
/** The copy that names the skill checkbox may change with the dialog's locales: it is only ever matched loosely. */
const SKILL_NAME = /skill|habilidade|orquestra|技能|habilidade/i
const MEMORY_KEY = 'dsh-orquestrator:skill:v1'
const REMEMBER_BOX = /ask again|remember|do not ask/i
/**
 * The subagent model every step picks, in preference order: the isolated home is built from the operator's own
 * `settings.yaml`, so the SAME script meets different routes on different machines (the Azure DeepSeek route on the
 * development workstation, the OpenRouter one on the Mac mini) and a model name written down here would make every
 * pick fail on the other. The first candidate the picker really offers is resolved per page and used from then on.
 */
const WORKER_CANDIDATES = [
  { label: 'DeepSeek V4.1 Flash (Azure)', name: /DeepSeek V4\.1 Flash \(Azure\)/, id: 'DeepSeek-V4.1-Flash' },
  { label: 'DeepSeek: DeepSeek V4.1 Flash', name: /DeepSeek V4\.1 Flash/i, id: 'deepseek/deepseek-v4.1-flash' },
  // The pattern is also tested against the TRIGGER, which appends the provider with no separator
  // ("Z.ai: GLM 5.3OpenRouter"): an end anchor never matched there, so this case silently SKIPped (found by the
  // 0.8.2 verifier). The lookahead keeps it off the "GLM 5.3 Flash" row.
  { label: 'Z.ai: GLM 5.3', name: /GLM[\s-]?5\.3(?!(\s*Flash))/i, id: 'z-ai/glm-5.3' },
]
const SEND = 'Send with these options'
const TRIGGER = '[aria-haspopup="tree"]'
const TREE = 'body > [role="tree"]'

// The reasoning-effort vocabulary the host itself uses (pi-ai's escalation order). Level names come from the host
// catalog, not from this plugin's locales, so they are matched as words and never as the whole option text.
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const levelOf = (text) => LEVELS.find((level) => new RegExp(`(^|[^a-z])${level}([^a-z]|$)`, 'i').test(text))

/** The removed "Reasoning effort" block: its Show/Hide control and the effort words it was built around. */
const EFFORT_WORDS = /effort|esforço|reasoning|推理|思考/i
const SHOW_HIDE = /^(show|hide|mostrar|ocultar|显示|隐藏)$/i
const REMOVED_HINT = /turn on the switch|switch above|ligue? o (interruptor|switch)|开关/i
/** A paragraph that IS the removed effort block (a note that merely says "at high effort" is not one). */
const EFFORT_PARAGRAPH = /reasoning effort|esforço de raciocínio|推理强度|recommended level|nível recomendado|how long the model may think|quanto tempo o modelo pode pensar/i

/** The capability strip's score label, in the four languages the plugin ships (matched loosely on purpose). */
const SCORE_LABEL = /Terminal-Bench 4|Intelligence|Inteligência|智能/i
/** The score label that means "the headline IS the intelligence index" (one scalar per model, so its value never moves). */
const INDEX_LABEL = /Intelligence|Inteligência|智能/i
/** The score label that means "the headline is the committed Terminal-Bench 4 snapshot" (matched loosely on purpose). */
const TB4_LABEL = /Terminal-Bench\s*4|TB\s*4|终端基准/i

/**
 * The intelligence index the fixture's catalog carries, per asset — the REAL field the data layer reads,
 * `benchmarks.artificial_analysis.intelligence_index`. OpenRouter publishes it as ONE scalar per model: there is no
 * per-effort intelligence anywhere in that catalog (verified against the live one, all 469 rows), so a single number is
 * all a fixture of it can honestly carry.
 *
 * That is exactly what the documented fallback rule resolves to at every level ("it has no per-effort value: show the
 * intelligence at the model's MAX"), so the badge is expected to be CONSTANT across the ladder, and F5 asserts that
 * constancy. A value that MOVES needs a metric with several rows per effort (Terminal-Bench 4, e.g. GPT-6 Astra) and is
 * deliberately NOT asserted here: this home's picker offers no such model (see the F5 block).
 */
const INDEX = {
  'z-ai/glm-5.3': 44.8,
  'xiaomi/mimo-v2.6-pro': 51.2,
  'deepseek/deepseek-v4.1-flash': 33.3,
}

/**
 * What the badge must show for each fixture asset, at EVERY option of the effort ladder (the neutral first one included),
 * and the headline it must read that value from. Both sources are constant per model, which is why the value cannot move:
 *   - a Terminal-Bench 4 model shows its accuracy from the committed snapshot (`src/bench.generated.ts`, `glm53: 41.82`) —
 *     the board publishes a single row for GLM-5.3 and the snapshot keeps the MAX per model, so "the accuracy at the
 *     model's MAX" IS the value at every effort (the documented fallback);
 *   - an Intelligence model shows its intelligence index from the catalog this fixture intercepts, and that field is ONE
 *     scalar per model (OpenRouter carries no per-effort intelligence at all, verified on all 469 live rows).
 * A value that really MOVES (GPT-6 Astra: low 50.61 / medium 54.24 / max 58.18) needs a model whose snapshot rows cover
 * several efforts: this home's picker offers none, so that half is a SKIP and the data layer's unit tests cover it.
 */
const BADGE_FACTS = {
  'z-ai/glm-5.3': { kind: 'terminal-bench', label: TB4_LABEL, value: 41.82, why: 'its Terminal-Bench 4 accuracy: the committed snapshot keeps one row per model (GLM-5.3 = 41.82), which is the value at the model\'s MAX and therefore at every effort' },
  'xiaomi/mimo-v2.6-pro': { kind: 'intelligence', label: INDEX_LABEL, value: 51.2, why: 'the intelligence index this fixture intercepts, one scalar per model — constant at every effort by construction' },
  'deepseek/deepseek-v4.1-flash': { kind: 'intelligence', label: INDEX_LABEL, value: 33.3, why: 'the intelligence index this fixture intercepts, one scalar per model — constant at every effort by construction' },
}

/** The browser-side model catalog the strip reads: intercepted so the ikons' marks and the intelligence index are known. */
const MODELS_ROUTE = '**/openrouter.ai/api/v1/models'
/** One fixture row: the modalities the strip must mark and the ONE intelligence index that whole model carries. */
const fixtureRow = (asset, name, input) => ({
  id: asset,
  name,
  architecture: { input_modalities: input, output_modalities: ['text'] },
  benchmarks: { artificial_analysis: { intelligence_index: INDEX[asset] } },
})
const FIXTURE_CATALOG = {
  data: [
    fixtureRow('z-ai/glm-5.3', 'GLM 5.3', ['text']),
    fixtureRow('xiaomi/mimo-v2.6-pro', 'MiMo V2.6 Pro', ['text', 'image', 'audio', 'video']),
    fixtureRow('deepseek/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', ['text', 'image']),
  ],
}

/**
 * One model whose capability strip is asserted: how the picker names it, the id its configuration carries, the fixture
 * entry it resolves to and the four modalities that entry declares. A case whose model the picker does not offer SKIPs.
 */
/** What the fixture declares for each route a case can resolve to: the marks the strip must show, and the score. */
const STRIP_FACTS = {
  'DeepSeek-V4.1-Flash': { asset: 'deepseek/deepseek-v4.1-flash', on: ['text', 'image'], off: ['audio', 'video'], score: '33.3' },
  'deepseek/deepseek-v4.1-flash': { asset: 'deepseek/deepseek-v4.1-flash', on: ['text', 'image'], off: ['audio', 'video'], score: '33.3' },
  'z-ai/glm-5.3': { asset: 'z-ai/glm-5.3', on: ['text'], off: ['image', 'audio', 'video'], score: '44.8' },
  'xiaomi/mimo-v2.6-pro': { asset: 'xiaomi/mimo-v2.6-pro', on: ['text', 'image', 'audio', 'video'], off: [], score: '51.2' },
}

/** The cases the strip is asserted for: the subagent model this home carries (filled in at run time), GLM 5.3, MiMo. */
const STRIP_CASES = [
  { label: 'the subagent model', picker: undefined, id: undefined, asset: undefined, on: [], off: [], score: '' },
  { label: 'Z.ai: GLM 5.3', picker: /GLM[\s-]?5\.3(?!\s*Flash)/i, id: 'z-ai/glm-5.3', asset: 'z-ai/glm-5.3', on: ['text'], off: ['image', 'audio', 'video'], score: '41.8' },
  { label: 'MiMo V2.6 Pro', picker: /MiMo/i, id: 'xiaomi/mimo-v2.6-pro', asset: 'xiaomi/mimo-v2.6-pro', on: ['text', 'image', 'audio', 'video'], off: [], score: '51.2' },
]

const checks = []
const shapes = {}
const check = (name, ok, detail = '') => {
  const text = scrub(detail === undefined ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail))
  checks.push({ name, ok: Boolean(ok), detail: text.slice(0, 700) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${text === '' ? '' : `  [${text.slice(0, 240)}]`}`)
}

/** A soft finding: reported with its evidence, never counted as a failure (a design consequence rather than a broken promise). */
const advice = []
const advise = (name, ok, detail = '') => {
  const text = scrub(detail === undefined ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail))
  advice.push({ name, ok: Boolean(ok), detail: text.slice(0, 700) })
  console.log(`${ok ? 'ADVICE-OK  ' : 'ADVICE-FAIL'}  ${name}${text === '' ? '' : `  [${text.slice(0, 240)}]`}`)
}

/** A check this environment cannot run (it needs something the DSH home does not have): reported, never a failure. */
const skipped = []
const skip = (name, reason) => {
  skipped.push({ name, reason })
  console.log(`SKIP  ${name}  [${reason}]`)
}

const chromePath = process.env.CHROME_PATH
const browser = await chromium.launch(chromePath === undefined ? { channel: 'chrome', headless: true } : { executablePath: chromePath, headless: true, args: ['--no-sandbox'] })

// ------------------------------------------------------------------------------------------------ page, tracking, helpers

/** Everything one page reports: errors, failed responses and the plugin's configuration traffic (paths only, never the URL). */
const trackers = []
function track(label, page) {
  const tracker = { label, uncaught: [], consoleErrors: [], failed: [], wire: [], sessionIds: [], expecting: false }
  page.on('pageerror', (error) => tracker.uncaught.push(scrub(error).slice(0, 300)))
  page.on('console', (message) => {
    if (message.type() === 'error') tracker.consoleErrors.push({ text: scrub(message.text()).slice(0, 200), expected: tracker.expecting })
  })
  page.on('response', async (response) => {
    const path = new URL(response.url()).pathname
    if (response.status() >= 400) tracker.failed.push({ status: response.status(), path, method: response.request().method(), expected: tracker.expecting })
    if (path !== '/dsh-orquestrator/config') return
    const entry = { method: response.request().method(), status: response.status(), sessionId: new URL(response.url()).searchParams.get('sessionId'), body: response.request().postData() }
    try {
      const json = await response.json()
      entry.skill = 'skill' in json ? json.skill : '<absent>'
      entry.config = json.config
      entry.sessionId ??= json.sessionId
    } catch { /* an aborted or non-JSON answer has nothing to read */ }
    tracker.wire.push(entry)
  })
  page.on('request', (request) => {
    if (new URL(request.url()).pathname !== '/dsh-orquestrator/config' || request.method() !== 'GET') return
    const id = new URL(request.url()).searchParams.get('sessionId')
    if (id !== null) tracker.sessionIds.push(id)
  })
  trackers.push(tracker)
  return tracker
}

/**
 * A page of its own (own context, so own localStorage): `{ label, context, page, t, sessionId, locatedAt }`
 * (`sessionId` is the conversation this page talks to and `locatedAt` how much of that conversation's log has already
 * been read). `worker`/`entries` are filled the first time this page resolves the subagent model its picker offers.
 */
async function newPage(label, { scheme = 'dark', viewport = { width: 1280, height: 860 } } = {}) {
  const context = await browser.newContext({ viewport, colorScheme: scheme })
  const page = await context.newPage()
  return { label, context, page, t: track(label, page), sessionId: undefined, locatedAt: 0, worker: undefined, entries: undefined }
}

const dialog = (s) => s.page.getByRole('dialog', { name: DIALOG })
/** The ONE skill checkbox of the dialog (its copy lives in the plugin's locales: it is never pinned here). */
const skillBox = (s) => dialog(s).getByRole('checkbox')
/**
 * The portalled menu the model picker opens: the DSH `Menu` primitive renders it as a direct child of `<body>`. The
 * effort `<select>` lives INSIDE the dialog and its `<option>`s carry the implicit role `option` too, so every model
 * entry is looked up here and nowhere else (a bare `getByRole('option')` resolved to a hidden "Model default" option and
 * timed the pick out — found by the 0.8.2 verifier).
 */
const modelMenu = (s) => s.page.locator('body > [role="menu"]').filter({ visible: true }).first()
/**
 * The entries the model picker really offers, read once per page (the grouped menu is opened, read and closed again).
 * `undefined` when the picker could not be read at all: the caller then falls back to trying the patterns one by one.
 */
async function modelEntries(s) {
  if (s.entries !== undefined) return s.entries
  if (!(await openModelPicker(s))) return undefined
  await modelMenu(s).getByRole('menuitem').first().waitFor({ state: 'visible', timeout: 6_000 }).catch(() => undefined)
  const texts = await modelMenu(s).getByRole('menuitem').allInnerTexts().catch(() => [])
  await s.page.keyboard.press('Escape') // the menu owns Escape first; the dialog stays open (it guards the close)
  await s.page.waitForTimeout(400)
  const entries = texts.map(normal).filter((text) => text !== '')
  if (entries.length > 0) s.entries = entries
  return entries.length === 0 ? undefined : entries
}

/**
 * The subagent model this home offers, picked in the dialog: the first candidate the picker accepts. Returns the
 * candidate that was picked (`{ label, name, id }`), or undefined when this home offers none of them.
 */
async function pickWorker(s) {
  if (s.worker !== undefined) return s.worker
  const entries = await modelEntries(s)
  const offered = entries === undefined ? WORKER_CANDIDATES : WORKER_CANDIDATES.filter((candidate) => entries.some((text) => candidate.name.test(text)))
  for (const candidate of (offered.length > 0 ? offered : WORKER_CANDIDATES)) {
    if (await pickModel(s, candidate.name)) { s.worker = candidate; return candidate }
  }
  return undefined
}

/** The element that draws the checkbox's visible text: the host puts the box and its label in one row. */
const skillLabel = (s) => skillBox(s).locator('xpath=ancestor::label[1]')
const memory = (s) => s.page.evaluate((key) => localStorage.getItem(key), MEMORY_KEY)
const shot = async (s, name) => { await s.page.screenshot({ path: join(out, `skill-${name}.png`) }) }
const slug = (value) => value.replace(/[^A-Za-z0-9]+/g, '-')
const normal = (text) => text.replace(/\s+/g, ' ').trim()

async function open(s) {
  await s.page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await s.page.getByRole('textbox', { name: COMPOSER }).waitFor({ state: 'visible', timeout: 30_000 })
  // DSH lands either on the new-session view or on a conversation (a start-up race of its own). Start from a blank one, so the
  // choice stored for an old conversation never leaks into a check: "New session" reuses an empty session when there is one.
  if (await s.page.getByRole('textbox', { name: /Message or run a task/ }).count() > 0) await newConversation(s)
}

/** The "New session" button of the sidebar: a blank conversation, whatever the page showed. */
async function newConversation(s) {
  await s.page.getByRole('button', { name: 'New session', exact: true }).first().click()
  await s.page.waitForTimeout(1_000)
  await s.page.getByRole('textbox', { name: COMPOSER }).waitFor({ state: 'visible', timeout: 15_000 })
}

/**
 * The session a step is now talking to, and how much of its log has already been read: "New session" reuses an abandoned
 * blank session, so the log may already hold turns whose messages must never be mistaken for the one about to be sent.
 */
function noteSession(s) {
  const id = s.t.sessionIds.at(-1)
  if (id === undefined || id === s.sessionId) return
  s.sessionId = id
  s.locatedAt = readEvents(id).length
}

/** What the composer holds right now (a textarea, an input or the host's contenteditable: read whichever it is). */
async function composerText(s) {
  const composer = s.page.getByRole('textbox', { name: COMPOSER })
  const held = await composer.evaluate((element) => ('value' in element && typeof element.value === 'string'
    ? element.value
    : (element.innerText ?? element.textContent ?? ''))).catch(() => '<no composer>')
  return normal(held)
}

/** The cards the composer draws for attached files, by the file name each one carries as its title. */
const attachmentCards = (s, name) => s.page.locator(`div[title="${name}"]`)

/** The file the attachment check uploads (and the one a stale card could leave behind). */
const ATTACHMENT = 'skill-attachment.txt'

/**
 * Select-all in the composer: the PLATFORM's own accelerator. `Control+A` is not select-all on macOS — Chrome moves the
 * caret there, so `Control+A` + `Backspace` deleted one character per round and the composer accumulated every draft
 * (found by the 0.8.3 verifier on the Mac mini: `Control+A` left `alpha bravo charlie` untouched, `Meta+A` emptied it).
 * Since 0.8.3 a cancel LEAVES the draft in the composer, so this helper is on the critical path of the S4/S7 walk.
 */
const SELECT_ALL = process.platform === 'darwin' ? 'Meta+A' : 'Control+A'

/**
 * Empty the composer, whatever the platform's accelerator did: select-all + Backspace first, and when the text is still
 * there the same text is erased character by character, from the caret outwards in both directions. Returns whether the
 * composer really ended up empty (a caller that cannot clear it must not type into it).
 */
async function clearComposer(s) {
  const composer = s.page.getByRole('textbox', { name: COMPOSER })
  for (let round = 0; round < 4; round += 1) {
    const held = await composerText(s)
    if (held === '') return true
    await composer.click()
    await s.page.keyboard.press(SELECT_ALL)
    await s.page.keyboard.press('Backspace')
    if ((await composerText(s)) === '') return true
    for (let index = 0; index < held.length + 2; index += 1) await s.page.keyboard.press('Backspace')
    for (let index = 0; index < held.length + 2; index += 1) await s.page.keyboard.press('Delete')
    await s.page.waitForTimeout(200)
  }
  const left = await composerText(s)
  if (left !== '') console.log(`DEBUG the composer could not be emptied: ${JSON.stringify(left)}`)
  return left === ''
}

/**
 * Wait for the composer to SETTLE before anything is typed or sent into it. With `file` set, that attachment is the one
 * this send is about: its card must be on screen and past its upload (a ready card shows the file size, an uploading one
 * a status word, so the digit is the signal). Without it, a card left by a previous send is waited out — and taken off
 * if it stays, because it would otherwise ride along with the next message.
 */
async function settleComposer(s, { file = null } = {}) {
  const composer = s.page.getByRole('textbox', { name: COMPOSER })
  await composer.waitFor({ state: 'visible', timeout: 15_000 })
  await clearComposer(s)
  if (file === null) {
    const stale = attachmentCards(s, ATTACHMENT)
    for (let waited = 0; waited < 8_000 && (await stale.count()) > 0; waited += 250) await s.page.waitForTimeout(250)
    if ((await stale.count()) > 0) {
      const remove = stale.first().locator('button').last()
      if (await remove.count() > 0) await remove.click().catch(() => undefined)
      await s.page.waitForTimeout(400)
    }
    return composer
  }
  const card = attachmentCards(s, file).first()
  await card.waitFor({ state: 'visible', timeout: 15_000 })
  for (let waited = 0; waited < 20_000; waited += 250) {
    if (/\d/.test(await card.innerText().catch(() => ''))) break
    await s.page.waitForTimeout(250)
  }
  return composer
}

/**
 * Type a task in the composer and press Enter: the dialog must appear. The composer is settled first and what it really
 * holds is verified (a lost keystroke sent a truncated task and every later check reported the wrong text); the failure
 * is loud, never silent.
 */
async function ask(s, text) {
  const composer = await settleComposer(s)
  const wanted = normal(text)
  let held = ''
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await composer.click()
    await s.page.keyboard.type(text, { delay: 5 })
    await s.page.waitForTimeout(200)
    held = await composerText(s)
    // Exactly the task: a composer that still held an earlier draft (the 0.8.3 cancel leaves one) would otherwise send
    // the concatenation, and every later check would report on the wrong message.
    if (held === wanted) break
    await clearComposer(s)
  }
  if (held !== wanted) console.log(`DEBUG the composer holds ${JSON.stringify(held)} for the ${String(wanted.length)}-character task ${JSON.stringify(wanted)}`)
  await s.page.keyboard.press('Enter')
  await dialog(s).waitFor({ state: 'visible', timeout: 15_000 })
  noteSession(s)
}

/** Answer the dialog the way a click would: the footer button. */
async function sendWith(s) {
  await dialog(s).getByRole('button', { name: SEND }).click()
  await dialog(s).waitFor({ state: 'hidden', timeout: 8_000 })
}

// ------------------------------------------------------------------------------------------------ the dialog's controls

/** The names of the models the isolated home's catalog carries (loose: a select that lists them is the model picker). */
const MODELISH = /GLM|DeepSeek|MiMo|Claude|GPT|Gemini|Kimi|Qwen|Grok|Llama|Mistral|Sonnet|Haiku/i

/** Every `<select>` of the dialog, with the options it draws and the one it shows (option order = DOM order, so an index selects what it says). */
async function selectsIn(s) {
  const nodes = dialog(s).locator('select')
  const found = []
  for (let index = 0; index < await nodes.count(); index += 1) {
    const handle = nodes.nth(index)
    found.push({
      index,
      handle,
      visible: await handle.isVisible(),
      options: (await handle.locator('option').allInnerTexts()).map(normal),
      values: await handle.locator('option').evaluateAll((elements) => elements.map((element) => element.value)),
      selected: await handle.evaluate((element) => element.selectedIndex),
      label: normal((await handle.getAttribute('aria-label')) ?? ''),
    })
  }
  return found
}

/** The options one select really draws: a placeholder rendered with no text is not one of them. */
const filledOptions = (select) => (select === undefined ? [] : select.options.filter((text) => text !== ''))

/** The effort select: the dialog's native select that does NOT list models (the model picker is a button or a select). */
async function effortSelect(s) {
  const visible = (await selectsIn(s)).filter((item) => item.visible)
  return visible.find((item) => !item.options.some((text) => MODELISH.test(text))) ?? visible.at(-1)
}

/** The model select, when the picker is a native select; undefined while it is the grouped menu button. */
async function modelSelect(s) {
  return (await selectsIn(s)).find((item) => item.visible && item.options.some((text) => MODELISH.test(text)))
}

/** What the model control shows right now. */
async function modelShown(s) {
  const native = await modelSelect(s)
  if (native !== undefined) return normal(await native.handle.evaluate((element) => element.selectedOptions[0]?.textContent ?? ''))
  const button = dialog(s).locator('button[aria-haspopup]').first()
  return (await button.count()) > 0 ? normal(await button.innerText()) : ''
}

/** Open the model picker: a native select needs nothing, the grouped menu is opened by its trigger. */
async function openModelPicker(s) {
  if (await modelSelect(s) !== undefined) return true
  const trigger = dialog(s).locator('button[aria-haspopup]').first()
  // The picker is progressive disclosure (it mounts when the switch goes on): give it a moment before giving up.
  for (let waited = 0; waited < 5_000 && await trigger.count() === 0; waited += 250) await s.page.waitForTimeout(250)
  if (await trigger.count() === 0) return false
  await trigger.click()
  await s.page.waitForTimeout(250)
  return true
}

/**
 * Pick a model in the dialog's picker (native select or grouped menu). Returns false, without throwing, when the
 * picker does not offer a model whose name matches: the caller decides whether that is a SKIP or a FAIL.
 */
async function pickModel(s, pattern) {
  const native = await modelSelect(s)
  if (native !== undefined) {
    const index = native.options.findIndex((text) => pattern.test(text))
    if (index < 0) return false
    await native.handle.selectOption({ index })
    await s.page.waitForTimeout(350)
    return pattern.test(await modelShown(s))
  }
  if (!(await openModelPicker(s))) return false
  const entry = modelMenu(s).getByRole('menuitem', { name: pattern })
    .or(modelMenu(s).locator('[role=menuitem]').filter({ hasText: pattern })).first()
  const there = await entry.waitFor({ state: 'visible', timeout: 6_000 }).then(() => true, () => false)
  if (!there) {
    await s.page.keyboard.press('Escape') // the menu owns Escape first; the dialog stays open (it guards the close)
    await s.page.waitForTimeout(400)
    return false
  }
  await entry.click()
  await s.page.waitForTimeout(350)
  return pattern.test(await modelShown(s))
}

/** The "no Reasoning effort section" evidence: no Show/Hide control, no heading and no paragraph about the effort. */
async function effortSectionEvidence(s) {
  // `locator.evaluate` hands the LOCATOR'S element in as the first argument and the caller's value in as the second
  // (a page-level `evaluate` would be the other way round). Reading the sources from the first parameter made every
  // regex `undefined` — `new RegExp(undefined)` matches EVERY element, so "no effort paragraph/Show-Hide" and "no
  // turn-on-the-switch hint" were red on a dialog that has neither (found by the 0.8.2 verifier).
  return dialog(s).evaluate((_element, sources) => {
    const words = new RegExp(sources.words, 'i')
    const showHide = new RegExp(`^(?:${sources.showHide})$`, 'i')
    const removed = new RegExp(sources.removed, 'i')
    const text = (element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim()
    const buttons = [...document.querySelectorAll('[role=dialog] button')].filter((button) => showHide.test(text(button)))
    const heads = [...document.querySelectorAll('[role=dialog] h1,[role=dialog] h2,[role=dialog] h3,[role=dialog] h4,[role=dialog] h5,[role=dialog] h6')].filter((head) => words.test(text(head)))
    const effortParagraph = new RegExp(sources.paragraph, 'i')
    const paragraphs = [...document.querySelectorAll('[role=dialog] p')].filter((paragraph) => effortParagraph.test(text(paragraph)))
    const removedHints = [...document.querySelectorAll('[role=dialog] p, [role=dialog] span')].filter((element) => removed.test(text(element)))
    return {
      showHide: buttons.map(text).slice(0, 3),
      headings: heads.map(text).slice(0, 3),
      paragraphs: paragraphs.map(text).slice(0, 3),
      removedHints: removedHints.map(text).slice(0, 3),
      selects: [...document.querySelectorAll('[role=dialog] select')].length,
    }
  }, { words: EFFORT_WORDS.source, showHide: SHOW_HIDE.source, removed: REMOVED_HINT.source, paragraph: EFFORT_PARAGRAPH.source })
}

// ------------------------------------------------------------------------------------------------ the capability strip

/**
 * The four modality items the dialog shows for the selected model: one per modality, found by the accessible name each
 * carries (the glyphs themselves are decorative), with the signals a "dimmed" mark can be drawn with. The score badge
 * is the smallest box that states the headline AND its value: a leaf naming the benchmark
 * (/Terminal-Bench 4|Intelligence|Inteligência|智能/) is grown upwards until a number is in scope, because label and
 * value are often two separate leaves — a bare label carries nothing the value checks could compare.
 */
async function stripOf(s) {
  return dialog(s).evaluate((root) => {
    const MODALITIES = [
      ['audio', /audio|áudio|音频|音頻|声音|聲音|voz/i],
      ['image', /image|imagem|foto|photo|imagen|图像|圖片|图片/i],
      ['text', /texto|text|文本|文字/i],
      ['video', /vídeo|video|视频|影片/i],
    ]
    const named = (element) => ['aria-label', 'title', 'alt', 'data-modality', 'data-fact', 'data-name']
      .map((attribute) => element.getAttribute(attribute) ?? '').join(' ').trim()
    const glyph = (element) => element.tagName === 'SVG' || element.tagName === 'IMG' || element.querySelector('svg,img') !== null
    const matches = []
    for (const element of root.querySelectorAll('*')) {
      const name = named(element)
      if (name === '' || !glyph(element)) continue
      const hits = MODALITIES.filter(([, pattern]) => pattern.test(name)).map(([key]) => key)
      if (hits.length !== 1) continue
      matches.push({ element, modality: hits[0], name })
    }
    const kept = matches.filter((item) => !matches.some((other) => other !== item && other.modality === item.modality && other.element.contains(item.element)))
    const classOf = (element) => `${element.getAttribute('class') ?? ''} ${element.parentElement?.getAttribute('class') ?? ''}`.trim().slice(0, 160)
    const items = []
    const seen = new Set()
    for (const item of kept) {
      if (seen.has(item.modality)) continue
      seen.add(item.modality)
      let opacity = 1
      for (let node = item.element; node !== null && node !== root.parentElement; node = node.parentElement) {
        const value = Number(getComputedStyle(node).opacity)
        if (Number.isFinite(value)) opacity *= value
      }
      const color = getComputedStyle(item.element).color
      // Every state attribute of the item and its wrapper, whatever the plugin named it: `data-*` booleans and
      // `aria-disabled` are the ways a mark can be stated in the DOM instead of drawn.
      const attributes = {}
      for (const node of [item.element, item.element.parentElement].filter((element) => element !== null)) {
        for (const attribute of node.attributes) {
          if (attribute.name !== 'aria-disabled' && !attribute.name.startsWith('data-')) continue
          if (attribute.value.length > 24 || attributes[attribute.name] !== undefined) continue
          attributes[attribute.name] = attribute.value
        }
      }
      // Browser context: the tolerant alpha parser has to live INSIDE this callback (a Node-side constant is not defined here).
      const alpha = (value) => {
        const parts = String(value).match(/[0-9.]+/g) ?? []
        return String(value).startsWith('rgba') && parts.length >= 4 ? Number(parts[3]) : 1
      }
      let background = 'rgb(255, 255, 255)'
      for (let node = item.element; node !== null; node = node.parentElement) {
        const value = getComputedStyle(node).backgroundColor
        if (alpha(value) > 0.5) { background = value; break }
      }
      items.push({
        modality: item.modality,
        name: item.name,
        opacity: Number(opacity.toFixed(3)),
        color,
        alpha: alpha(color),
        background,
        attributes,
        classes: classOf(item.element),
        html: item.element.outerHTML.slice(0, 160),
      })
    }
    const badge = [...root.querySelectorAll('*')]
      .filter((element) => element.children.length === 0 && /Terminal-Bench 4|Intelligence|Inteligência|智能/i.test(element.textContent ?? ''))
      .map((element) => {
        // The label and its number can be two separate leaves: walk up to the SMALLEST box that carries both, so the
        // entry the checks read is the badge (label + value), never a bare label with nothing to compare.
        let node = element
        for (let up = 0; up < 4 && node.parentElement !== null && !/\d/.test(node.textContent ?? ''); up += 1) node = node.parentElement
        return (node.textContent ?? '').replace(/\s+/g, ' ').trim()
      })
      .filter((text) => text !== '')
    return { items, badge: [...new Set(badge)].slice(0, 4) }
  })
}

const DIM_CLASS = /(^|[-_ ])(off|dim|dimmed|muted|disabled|unavailable|inactive|empty)([-_ ]|$)/i

/**
 * Every signal that can draw one modality as "marked" or "dimmed": an explicit state attribute, a dim/off class, an
 * opacity, or the colour it is painted in (a dimmed token has a lower contrast against its own backdrop than the
 * primary one). The strip is judged on the signals, never on the plugin's class names or copy.
 */
function marksOf(items) {
  return items.map((item) => {
    const state = item.attributes ?? {}
    const booleans = Object.entries(state).filter(([name, value]) => name !== 'aria-disabled' && /^(true|false|on|off|yes|no)$/i.test(value))
    const off = state['aria-disabled'] === 'true' || booleans.some(([, value]) => /^(false|off|no)$/i.test(value)) || DIM_CLASS.test(item.classes ?? '')
    const on = booleans.some(([, value]) => /^(true|on|yes)$/i.test(value))
    let strength = null
    try {
      strength = typeof item.color === 'string' && typeof item.background === 'string' ? contrast(item.color, item.background) : null
    } catch { strength = null }
    return { modality: item.modality, off, on, opacity: item.opacity, contrast: Number.isFinite(strength) ? Number(strength.toFixed(2)) : null }
  })
}

const valuesOf = (list, key) => list.map((item) => item[key]).filter((value) => typeof value === 'number' && Number.isFinite(value))

/** Whether the four items are marked exactly as the fixture's modalities say. */
function marksMatch(items, expected) {
  const byModality = Object.fromEntries(items.map((item) => [item.modality, item]))
  const missing = [...expected.on, ...expected.off].filter((modality) => byModality[modality] === undefined)
  if (missing.length > 0) return { ok: false, why: `no icon carries the name of ${missing.join(', ')}` }
  const judged = marksOf(items)
  const pick = (modalities) => modalities.map((modality) => judged.find((item) => item.modality === modality))
  const on = pick(expected.on)
  const offItems = pick(expected.off)
  const detail = judged.map((item) => `${item.modality}: contrast ${item.contrast === null ? '?' : item.contrast}, opacity ${String(item.opacity)}${item.off ? ', off-attribute' : item.on ? ', on-attribute' : ''}`).join(' | ')
  if (offItems.length === 0) {
    const contrasts = valuesOf(judged, 'contrast')
    const uniform = contrasts.length < 2 || Math.max(...contrasts) - Math.min(...contrasts) <= 0.6
    return { ok: on.every((item) => !item.off) && uniform, why: `every modality marked :: ${detail}` }
  }
  const explicit = offItems.every((item) => item.off) && on.every((item) => !item.off)
  const offContrast = valuesOf(offItems, 'contrast')
  const onContrast = valuesOf(on, 'contrast')
  const offOpacity = valuesOf(offItems, 'opacity')
  const onOpacity = valuesOf(on, 'opacity')
  const weaker = (offContrast.length > 0 && onContrast.length > 0 && Math.max(...offContrast) < Math.min(...onContrast) - 0.2)
    || (offOpacity.length > 0 && onOpacity.length > 0 && Math.max(...offOpacity) < Math.min(...onOpacity))
  return {
    ok: explicit || weaker,
    why: `${explicit ? 'explicit off marks' : weaker ? 'the off icons are drawn weaker (lower contrast or opacity), as a dimmed state' : 'NO signal tells the off icons apart from the marked ones'} :: ${detail}`,
  }
}

/** The signals of one strip, one line per modality, for a report a human can read. */
const stripSignals = (items) => marksOf(items).map((item) => `${item.modality}:contrast ${item.contrast === null ? '?' : item.contrast}/opacity ${String(item.opacity)}${item.off ? '/off' : item.on ? '/on' : ''}`).join(' ')

/** The strip once the browser has read the catalog and rendered it: the fetch is async, so poll for up to `ms`. */
async function stripWhenReady(s, ms = 6_000) {
  const started = Date.now()
  let strip = await stripOf(s)
  while (Date.now() - started < ms && strip.items.length < 4) {
    await s.page.waitForTimeout(300)
    strip = await stripOf(s)
  }
  return strip
}

/**
 * What sits immediately above the effort select: the nearest visible control of the dialog, by the foot of its box.
 * The spec puts the select directly under the model select when the switch is on, and directly under the switch when it
 * is off, so the anchor's identity IS the positioning check (told apart from a stale gap that a stray control would leave).
 */
async function effortAnchor(s, index) {
  return dialog(s).evaluate((root, wanted) => {
    const effort = [...root.querySelectorAll('select')][wanted]
    if (effort === undefined) return null
    const effortRect = effort.getBoundingClientRect()
    const all = [...root.querySelectorAll('select, button, input, [role=switch], [role=checkbox], textarea')]
      .filter((element) => {
        if (element === effort || element.contains(effort) || effort.contains(element)) return false
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      })
    // A wrapper and the input it draws are one control: keep the outermost of each nested pair.
    const outer = all.filter((element) => !all.some((other) => other !== element && other.contains(element)))
    const describe = (element) => element === undefined ? null : {
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role') ?? '',
      haspopup: element.getAttribute('aria-haspopup'),
      models: element.tagName === 'SELECT' ? [...element.options].some((option) => /GLM|DeepSeek|MiMo|Claude|GPT|Gemini|Kimi|Qwen/i.test(option.textContent ?? '')) : false,
      name: (element.getAttribute('aria-label') ?? element.labels?.[0]?.textContent ?? element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
      bottom: Number(element.getBoundingClientRect().bottom.toFixed(1)),
    }
    const above = outer.filter((element) => element.getBoundingClientRect().bottom <= effortRect.top + 2)
      .sort((left, right) => right.getBoundingClientRect().bottom - left.getBoundingClientRect().bottom)
    return {
      effortTop: Number(effortRect.top.toFixed(1)),
      anchor: describe(above[0]),
      gap: above[0] === undefined ? null : Number((effortRect.top - above[0].getBoundingClientRect().bottom).toFixed(1)),
      controls: outer.length,
    }
  }, index)
}

/**
 * The reasoning levels the isolated home declares for one model id, one entry per provider block that declares it: the
 * witness for "the ladder plus one neutral option". DSH lists exactly the levels a profile declares (`llm-pi-ai`
 * resolves the declared `reasoningEfforts` into the model's map), so the option count can be checked against the home's
 * own settings instead of a number written down here. A model several providers declare yields several ladders, and the
 * select may follow any of them; the check accepts a match with any.
 */
function declaredLadders(modelId) {
  const home = process.env.DSH_HOME
  if (home === undefined) return []
  const file = join(home, 'settings.yaml')
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf8').split('\n')
  const pattern = new RegExp(`^\\s*-\\s*id:\\s*['"]?${modelId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*$`)
  const ladders = []
  for (let start = 0; start < lines.length; start += 1) {
    if (!pattern.test(lines[start])) continue
    let indent
    const levels = []
    for (const line of lines.slice(start + 1)) {
      if (/^\s*-\s*id:/.test(line)) break
      const header = /^(\s*)reasoningEfforts:\s*$/.exec(line)
      if (header !== null) { indent = header[1].length; continue }
      if (indent === undefined) continue
      if (line.trim() === '' || line.trim().startsWith('#')) continue
      const key = /^(\s*)([A-Za-z_]+):/.exec(line)
      if (key === null || key[1].length <= indent) { if (key !== null) break; continue }
      levels.push(key[2])
    }
    if (levels.length > 0) ladders.push(levels)
  }
  return ladders
}

// ------------------------------------------------------------------------------------------------ the DSH session log

function logFile(sessionId) {
  if (sessionId === undefined) return undefined
  for (const directory of readdirSync(sessionsDir)) {
    const file = join(sessionsDir, directory, sessionId, 'session.v3.jsonl.zstd')
    if (existsSync(file)) return file
  }
  return undefined
}

/** Every event of one session log file decoded so far (a log being written yields its complete lines). */
function readEventsAt(file) {
  let text = ''
  try {
    text = execFileSync('zstd', ['-dc', file], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8')
  } catch (error) {
    text = error.stdout?.toString('utf8') ?? ''
  }
  return text.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })
}

/** Every event of a session log decoded so far, by session id. */
function readEvents(sessionId) {
  const file = logFile(sessionId)
  return file === undefined ? [] : readEventsAt(file)
}

const textOfMessage = (event) => (event.data.content ?? []).map((part) => part.text ?? '').join('')

/** The log grouped by turn: the user's own messages, the skill injections, the answer and how the turn ended. */
function turnsOf(events) {
  const turns = []
  let current = null
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = { turn: event.data.turn, users: [], injections: [], others: [], answer: '', end: null }
      turns.push(current)
    } else if (current !== null && event.type === 'user/message') {
      const source = event.data.source ?? {}
      const text = textOfMessage(event)
      if (source.kind === 'user') current.users.push({ text, source, event })
      else if (source.kind === 'skill-invocation') current.injections.push({ name: source.name, form: source.form, text, event })
      else current.others.push({ kind: source.kind, text })
    } else if (current !== null && event.type === 'assistant/message') {
      current.answer += (event.data.message?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('')
    } else if (current !== null && event.type === 'turn/end') {
      current.end = event.data.reason ?? {}
    }
  }
  return turns
}

const isInjection = (event) => event.type === 'user/message' && event.data?.source?.kind === 'skill-invocation'

/** One-line shape of an event: keys and sources kept, long strings cut. */
function shapeOf(event) {
  const cut = (_key, value) => (typeof value === 'string' && value.length > 70 ? `${value.slice(0, 60)}...(${String(value.length)} chars)` : value)
  return JSON.stringify(event, cut)
}

/**
 * The log event of the message `expected` names, at or after `from`: matched BY ITS TEXT (a string, compared after
 * whitespace is collapsed, or a RegExp). Turn numbers are deliberately not used — see the header.
 */
function locateMessage(events, expected, from) {
  const wanted = typeof expected === 'string' ? normal(expected) : null
  for (let index = Math.max(0, from); index < events.length; index += 1) {
    const event = events[index]
    if (event.type !== 'user/message' || event.data?.source?.kind !== 'user') continue
    const text = textOfMessage(event)
    if (wanted === null ? expected.test(text) : normal(text) === wanted) return { index, event, text }
  }
  return null
}

/**
 * Everything that follows ONE message inside its own turn: the injections DSH made for it, the answer and how the turn
 * ended. DSH appends a message inside the turn it has already opened (the agent loop appends `turn/start` first), so the
 * first `turn/end` after the message closes the message's own turn — a message that waits in the queue is logged with
 * its own turn, never with the running one.
 */
function followOf(events, located, endIndex) {
  // `endIndex` is INCLUSIVE: the caller passes the index of the `turn/end` that closes this message's own turn, and that
  // event is what fills `end` — a loop that stopped one short left `turn.end` null on the ok:true path.
  const users = [{ text: located.text, source: located.event.data.source ?? {}, event: located.event }]
  const injections = []
  const others = []
  let answer = ''
  let end = null
  for (let index = located.index + 1; index <= endIndex; index += 1) {
    const event = events[index]
    if (event.type === 'user/message') {
      const source = event.data?.source ?? {}
      const text = textOfMessage(event)
      if (source.kind === 'user') users.push({ text, source, event })
      else if (source.kind === 'skill-invocation') injections.push({ name: source.name, form: source.form, text, event })
      else others.push({ kind: source.kind, text })
    } else if (event.type === 'assistant/message') {
      answer += (event.data.message?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('')
    } else if (event.type === 'turn/end') {
      end = event.data.reason ?? {}
      break
    }
  }
  return { users, injections, others, answer, end }
}

/**
 * The next message of the conversation — the one `expected` names — went out: wait until its turn has ended and return
 * what followed it. The read position (`s.locatedAt`) advances past the located message, so two sends of the same text
 * are told apart and a queued message logged before the previous turn ended is still found. A message that never shows
 * up (a truncated send) reports the first message the log DID get after the read position, so the failure names what
 * really went out instead of "undefined" (the symptom the turn-number attribution produced).
 */
async function landed(s, expected, ms = 60_000) {
  const started = Date.now()
  let seen = null
  while (Date.now() - started < ms) {
    const events = readEvents(s.sessionId)
    const located = locateMessage(events, expected, s.locatedAt ?? 0)
    if (located !== null) {
      seen = located
      const end = events.findIndex((event, index) => index > located.index && event.type === 'turn/end')
      if (end >= 0) {
        s.locatedAt = located.index + 1
        return { ok: true, turn: followOf(events, located, end), ms: Date.now() - started }
      }
    }
    await s.page.waitForTimeout(500)
  }
  const stop = s.page.getByRole('button', { name: 'Stop generating' })
  if (await stop.count() > 0) await stop.first().click().catch(() => undefined)
  await s.page.waitForTimeout(1_500)
  const events = readEvents(s.sessionId)
  let fallback = seen ?? locateMessage(events, /[\s\S]*/, s.locatedAt ?? 0)
  if (seen === null && fallback === null) {
    // Nothing new at all after the read position: report the LAST message the log holds, so the failing check names what
    // really went out (the truncated ": juliet" was invisible while the turn lookup returned undefined).
    for (let index = events.length - 1; index >= 0 && fallback === null; index -= 1) {
      const event = events[index]
      if (event.type === 'user/message' && event.data?.source?.kind === 'user') fallback = { index, event, text: textOfMessage(event) }
    }
  }
  console.log(`DEBUG landed() timed out after ${String(ms)} ms for ${JSON.stringify(typeof expected === 'string' ? expected : String(expected))}; the log held ${String(events.filter((event) => event.type === 'user/message').length)} user messages`)
  return { ok: false, turn: fallback === null ? undefined : followOf(events, fallback, events.length), ms }
}

// ------------------------------------------------------------------------------------------------ transcript helpers

const chips = (s) => s.page.locator('button[data-ref-chip="skill"]', { hasText: TOKEN })
const bodyText = async (s) => (await s.page.locator('body').innerText()).replace(/[ \t]+/g, ' ')
const occurrences = (text, needle) => text.split(needle).length - 1

/** The visible text of the user bubble that holds `needle` (the chip and the plain run side by side). */
async function bubbleOf(s, needle) {
  const run = s.page.locator('span', { hasText: needle }).filter({ visible: true }).last()
  if (await run.count() === 0) return undefined
  return run.evaluate((element) => {
    const holder = element.closest('[class*="bubble"]') ?? element.parentElement
    return (holder?.textContent ?? '').replace(/\s+/g, ' ').trim()
  })
}

/** Run one named part; an exception is a FAIL of its own with a screenshot, never the end of the run. */
async function section(name, s, body) {
  try {
    await body()
  } catch (error) {
    check(`${name} ran to the end without an exception`, false, scrub(error?.message ?? error).split('\n')[0])
    if (s !== undefined) await shot(s, `${name}-exception`).catch(() => undefined)
  }
}

/** Contrast ratio of two `rgb(a)` strings (WCAG 2.x relative luminance). */
function contrast(foreground, background) {
  const parse = (value) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
  const luminance = (rgb) => {
    const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const [a, b] = [luminance(parse(foreground)), luminance(parse(background))]
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** The alpha of a computed `rgb(a)` colour (1 when it carries none). The closing parenthesis is never part of the
 * number: `Number('rgba(38, 49, 72, 0.06)'.split(',')[3])` is NaN, which made a translucent DSH hover token read as
 * "not painted" and the legibility check that measured it fail (found by the 0.8.3 verifier on the Mac mini). */
const alphaOf = (value) => {
  const parts = String(value).match(/[0-9.]+/g) ?? []
  return String(value).startsWith('rgba') && parts.length >= 4 ? Number(parts[3]) : 1
}

/** `foreground` composited over `background`: what the eye really sees through a translucent paint. */
function over(foreground, background) {
  const parts = (value) => (String(value).match(/[\d.]+/g) ?? []).slice(0, 4).map(Number)
  const [r, g, b, a = 1] = parts(foreground)
  const [br, bg, bb] = parts(background)
  const mix = (front, back) => Math.round(front * a + back * (1 - a))
  return `rgb(${String(mix(r, br))}, ${String(mix(g, bg))}, ${String(mix(b, bb))})`
}

/** Whether a computed colour is (near) pure white: the paint the 0.8.2 select fell back to in the dark theme. */
const isWhite = (value) => (String(value).match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).every((channel) => channel >= 250)

/**
 * The effort select's OWN computed paint (0.8.3): the background it really draws and the colour of its text, RESTING and
 * FOCUSED, with the surface behind it for compositing. `colorsOf` walks UP to the nearest opaque ancestor — which is
 * exactly what hid the white-on-white — so this probe reads the select itself. The stylesheet is never consulted.
 */
async function selectPaint(s) {
  // The EFFORT select, by its position among the dialog's own `<select>`s: on a home whose model picker is a native
  // select too, `querySelector('select')` would be the MODEL one (it comes first) and the paint of the wrong control
  // would be judged.
  const effort = await effortSelect(s)
  if (effort === undefined) return null
  const wanted = effort.index
  const read = async () => dialog(s).evaluate((root, index) => {
    const select = [...root.querySelectorAll('select')][index]
    if (select === undefined) return null
    const style = getComputedStyle(select)
    return { background: style.backgroundColor, color: style.color, focused: document.activeElement === select }
  }, wanted)
  const resting = await read()
  if (resting === null) return null
  const handle = dialog(s).locator('select').nth(wanted)
  await handle.focus({ timeout: 4_000 }).catch(() => undefined)
  await s.page.waitForTimeout(150)
  const focused = (await read()) ?? resting
  await handle.blur({ timeout: 4_000 }).catch(() => undefined)
  const surface = await dialog(s).evaluate((root, index) => {
    const alpha = (value) => {
      const parts = String(value).match(/[0-9.]+/g) ?? []
      return String(value).startsWith('rgba') && parts.length >= 4 ? Number(parts[3]) : 1
    }
    for (let node = [...root.querySelectorAll('select')][index]; node !== null; node = node.parentElement) {
      const value = getComputedStyle(node).backgroundColor
      if (alpha(value) > 0.5) return value
    }
    return 'rgb(255, 255, 255)'
  }, wanted)
  return { resting, focused, surface }
}

/**
 * The 0.8.3 legibility assertion for the effort select, in the theme the page carries: its computed background must be
 * PAINTED (never transparent) and its text must contrast with what is really behind that paint (>= 4.5); in the dark
 * theme the background must not be white either (the white-on-white reported for 0.8.2). Resting AND focused.
 */
async function selectLegibility(s, where, { dark }) {
  const paint = await selectPaint(s)
  if (paint === null) {
    check(`${where}: the effort select is on screen and its computed paint can be read`, false, 'no <select> in the dialog')
    return
  }
  for (const [state, value] of [['unfocused', paint.resting], ['focused', paint.focused]]) {
    const alpha = alphaOf(value.background)
    const seen = alpha >= 1 ? value.background : over(value.background, paint.surface)
    const ratio = contrast(value.color, seen)
    check(`${where}: the effort select paints its OWN background (computed, never transparent) and its text contrasts with it (>= 4.5) — ${state}`, alpha > 0 && ratio >= 4.5, `background ${value.background} (alpha ${String(alpha)}) over ${paint.surface} = ${seen}; text ${value.color}; contrast ${ratio.toFixed(2)}; focus observed=${String(value.focused)}`)
    if (dark) check(`${where}: its background is not WHITE in the dark theme (the 0.8.2 white-on-white) — ${state}`, !isWhite(seen), `${seen} from ${value.background} over ${paint.surface}`)
  }
}

/** Whether the transcript draws a user bubble holding `needle` right now (the composer's own draft is not a bubble). */
async function bubbleHolds(s, needle) {
  const [held, bubbles] = await s.page.evaluate((text) => [
    [...document.querySelectorAll('[class*="bubble"]')].some((node) => (node.textContent ?? '').replace(/\s+/g, ' ').includes(text)),
    document.querySelectorAll('[class*="bubble"]').length,
  ], normal(needle))
  return { held, bubbles }
}

/**
 * A message that must NOT have gone out (0.8.3: Escape/✕/Cancel/mask abort the send). The session log is the witness and
 * it is read for `ms` before the absence is reported — `landed` would wait a whole minute for a turn that never starts.
 * The text is searched from the START of the log: every task this script types is asked once per conversation. A log that
 * cannot be read at all (no ORQ_SESSIONS_DIR, no session id, a wrong path) would make EVERY absence check pass vacuously,
 * so that case FAILS the check it belongs to and says so in its own `detail`.
 */
async function absent(s, expected, ms = 3_000) {
  const wanted = normal(expected)
  const started = Date.now()
  let events = readEvents(s.sessionId)
  let found = locateMessage(events, wanted, 0)
  while (found === null && Date.now() - started < ms) {
    await s.page.waitForTimeout(400)
    events = readEvents(s.sessionId)
    found = locateMessage(events, wanted, 0)
  }
  const detail = found !== null
    ? `the log DOES hold it: ${JSON.stringify(found.text)}`
    : events.length > 0
      ? `absent from the log (${String(events.length)} events read)`
      : `the session log could not be read at all (session ${String(s.sessionId).slice(0, 12)}): the absence cannot be witnessed`
  return { ok: found === null && events.length > 0, text: found?.text, ms: Date.now() - started, events: events.length, detail }
}

/** Whether a badge text carries one score value (the FORMATTING is the product's: only the number is matched, with a
 * tolerance that survives the rounded form the badge may print, e.g. 41.82 drawn as `41.8%`). */
const badgeHas = (badge, value) => badge.some((text) => (String(text).match(/-?\d+(?:[.,]\d+)?/g) ?? [])
  .map((raw) => Number(raw.replace(',', '.')))
  .some((number) => Math.abs(number - value) < 0.05))

/** The badge text, polled until it satisfies `ok` (the effort change re-resolves it asynchronously) or `ms` runs out. */
async function badgeWhen(s, ok, ms = 6_000) {
  const started = Date.now()
  let badge = (await stripOf(s)).badge
  while (Date.now() - started < ms && !ok(badge)) {
    await s.page.waitForTimeout(250)
    badge = (await stripOf(s)).badge
  }
  return badge
}

/** What goes out when the checkbox applies the skill (0.8.0): the typed text, then the token on a line of its own. */
const withToken = (text) => `${text}\n${TOKEN}`

const T = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor'].map((word) => `Reply with exactly the word: ${word}`)

// ------------------------------------------------------------------------------------------------ conversation: S1..S5, S7 and the extras

async function conversation() {
  const s = await newPage('conversation')
  await open(s)

  // ---- S1: a new task raises the redesigned dialog: one skill box, always ticked, and the effort as a plain select
  await section('S1', s, async () => {
    await ask(s, T[0])
    const dlg = dialog(s)
    const boxes = dlg.getByRole('checkbox')
    check('S1 the dialog has exactly ONE checkbox', (await boxes.count()) === 1, await boxes.count())
    const box = skillBox(s)
    const name = normal((await box.getAttribute('aria-label')) ?? await box.evaluate((element) => element.labels?.[0]?.textContent ?? ''))
    advise('S1 the one checkbox is the orchestration-skill one (its copy lives in the locales: matched loosely)', SKILL_NAME.test(name), name)
    check('S1 it is CHECKED and ENABLED with the subagent-model switch OFF (the 0.8.1 coupling is gone)', (await box.count()) === 1 && await box.isChecked() && !(await box.isDisabled()), `checked=${String(await box.isChecked())} disabled=${String(await box.isDisabled())}`)
    check('S1 no checkbox named like "ask again" / "remember" / "do not ask"', (await dlg.getByRole('checkbox', { name: REMEMBER_BOX }).count()) === 0)
    const switches = dlg.getByRole('switch')
    check('S1 the subagent-model switch is still there, once, and OFF', (await switches.count()) === 1 && (await switches.first().getAttribute('aria-checked')) === 'false')
    check('S1 the dialog previews exactly what was typed', await dlg.getByText(T[0], { exact: true }).isVisible())
    const evidence = await effortSectionEvidence(s)
    check('S1 the "Reasoning effort" section is GONE: no Show/Hide control, no heading and no paragraph around it', evidence.showHide.length === 0 && evidence.headings.length === 0 && evidence.paragraphs.length === 0, JSON.stringify(evidence))
    const effort = await effortSelect(s)
    const visibleSelects = (await selectsIn(s)).filter((item) => item.visible)
    check('S1 the effort is a plain native <select>, ALWAYS visible (the only visible select while the switch is off)', visibleSelects.length === 1 && effort !== undefined && effort.visible, JSON.stringify({ visible: visibleSelects.length, found: effort !== undefined }))
    check('S1 before any model is picked the select shows its first, NEUTRAL option — not one of the ladder\'s levels', effort !== undefined && effort.selected === 0 && filledOptions(effort).length >= 1 && levelOf(filledOptions(effort)[0] ?? '') === undefined, effort === undefined ? 'no select' : JSON.stringify({ selected: effort.selected, options: effort.options }))
    advise('S1 with no model picked the select still offers a ladder (the inherited model\'s levels), not only the neutral option', filledOptions(effort).length >= 2, JSON.stringify(effort?.options))
    check('S1 the box is no longer gated: no "turn on the switch" hint anywhere in the dialog', evidence.removedHints.length === 0, JSON.stringify(evidence.removedHints))
    const anchor = effort === undefined ? null : await effortAnchor(s, effort.index)
    check('S1 with the switch off the effort select sits immediately under that switch (nothing between them)', anchor !== null && anchor.anchor !== null && anchor.anchor.role === 'switch' && anchor.gap !== null && anchor.gap >= 0 && anchor.gap <= 200, JSON.stringify(anchor))
    const answered = s.t.wire.find((entry) => entry.method === 'GET' && entry.sessionId === s.sessionId)
    check('S1 the host answered skill {name: orchestrate-subagents, available: true}', answered?.skill?.name === SKILL && answered?.skill?.available === true, JSON.stringify(answered?.skill))
    await shot(s, 'S1-dialog-dark')
  })

  // ---- S2: the box is ticked by default with the switch OFF -> the token goes out and DSH injects the skill
  await section('S2', s, async () => {
    check('S2 the checkbox is CHECKED and ENABLED before sending (the switch is off and does not gate it)', await skillBox(s).isChecked() && !(await skillBox(s).isDisabled()))
    await sendWith(s)
    const { ok, turn, ms } = await landed(s, withToken(T[0]))
    check('S2 the model answered (the message really went out)', ok && turn?.end?.kind === 'completed', `${String(ms)} ms, answer=${JSON.stringify(turn?.answer?.slice(0, 40))}`)
    const events = readEvents(s.sessionId)
    const user = turn?.users[0]
    check('S2 log: the user/message is the typed text with /orchestrate-subagents on its own line AT THE END', user?.text === withToken(T[0]) && user.text.endsWith(`\n${TOKEN}`), JSON.stringify(user?.text))
    check('S2 log: exactly ONE skill-invocation injection in that turn, named orchestrate-subagents', turn?.injections.length === 1 && turn?.injections[0]?.name === SKILL, JSON.stringify(turn?.injections.map((item) => item.name)))
    const catalog = events.find((event) => event.type === 'user/message' && event.data.source?.kind === 'skill-catalog')
    check('S2 log: the skill catalog lists orchestrate-subagents (the model may load it itself)', catalog?.data.source.entries?.some((entry) => entry.name === SKILL) === true)
    check('S2 the answer the user left (ticked) is remembered as "on"', (await memory(s)) === 'on', await memory(s))
    shapes.S2_userMessage = user === undefined ? null : shapeOf(user.event)
    check('S2 transcript: the bubble shows the typed text and exactly ONE skill chip', normal((await bubbleOf(s, T[0])) ?? '') === normal(`${T[0]} ${TOKEN}`) && (await chips(s).count()) === 1, await bubbleOf(s, T[0]))
    check('S2 transcript: the typed text appears exactly once (no duplicate bubble)', occurrences(await bodyText(s), T[0]) === 1, occurrences(await bodyText(s), T[0]))
    await shot(s, 'S2-transcript-with-token')
  })

  // ---- S3: the switch and a model come first; the effort auto-maxes and the send carries the token
  await section('S3', s, async () => {
    await ask(s, T[1])
    check('S3 the preview shows what was typed, without any token', await dialog(s).getByText(T[1], { exact: true }).isVisible())
    check('S3 the next dialog opens CHECKED and ENABLED, as the last answer left it', await skillBox(s).isChecked() && !(await skillBox(s).isDisabled()), await memory(s))
    const neutral = await effortSelect(s)
    check('S3 before the pick the effort select still shows the neutral first option', neutral !== undefined && neutral.selected === 0, JSON.stringify({ selected: neutral?.selected, options: neutral?.options }))
    await dialog(s).getByRole('switch').click()
    const worker = await pickWorker(s)
    check(`S3 the picker offers and accepts the subagent model this home carries (${worker?.label ?? 'none of the known routes'})`, worker !== undefined, await modelShown(s))
    const effort = await effortSelect(s)
    check('S3 AUTO-MAX: picking a model moves the effort select to that model\'s HIGHEST level (a non-neutral option, the LAST one)', effort !== undefined && effort.selected > 0 && effort.selected === filledOptions(effort).length - 1, JSON.stringify({ selected: effort?.selected, options: effort?.options }))
    const anchor = effort === undefined ? null : await effortAnchor(s, effort.index)
    check('S3 with the switch on the effort select sits immediately below the model select (nothing between them)', anchor !== null && anchor.anchor !== null && (anchor.anchor.haspopup !== null || anchor.anchor.models === true || /model|modelo|模型/i.test(anchor.anchor.name)) && anchor.gap !== null && anchor.gap >= 0 && anchor.gap <= 200, JSON.stringify(anchor))
    check('S3 with the switch on and a model picked the checkbox is still CHECKED and ENABLED before sending', await skillBox(s).isChecked() && !(await skillBox(s).isDisabled()))
    const autoMaxValue = effort?.values.at(-1)
    const autoMaxText = effort?.options.at(-1)
    await shot(s, 'S3-dialog-checked')
    const postsBefore = s.t.wire.filter((entry) => entry.method === 'POST').length
    await sendWith(s)
    check('S3 the answer is remembered as "on"', (await memory(s)) === 'on', await memory(s))
    await chips(s).first().waitFor({ state: 'visible', timeout: 15_000 })
    const { ok, turn, ms } = await landed(s, withToken(T[1]))
    check('S3 the model answered', ok && turn?.end?.kind === 'completed', `${String(ms)} ms, answer=${JSON.stringify(turn?.answer?.slice(0, 40))}`)
    const posts = s.t.wire.filter((entry) => entry.method === 'POST')
    const saved = posts.length > postsBefore ? JSON.parse(posts.at(-1).body ?? '{}').config : null
    check('S3 the effort the select auto-maxed to is what the configuration stores (workerEffort)', saved?.workerEffort !== undefined && (saved.workerEffort === autoMaxValue || levelOf(autoMaxText ?? '') === saved.workerEffort), `${JSON.stringify(saved?.workerEffort)} vs ${JSON.stringify({ value: autoMaxValue, text: autoMaxText })}`)
    const bubble = await bubbleOf(s, T[1])
    // The count is the conversation's: S2's message already put ONE chip in the transcript, so this send leaves TWO.
    // Comparing against 1 made the check unreachable in this sequence (the chip itself is asserted on the LAST one).
    const chipCount = await chips(s).count()
    check('S3 transcript: the message shows the typed text, then ONE /orchestrate-subagents chip on a line of its own', bubble === `${T[1]} ${TOKEN}` && chipCount === 2 && await chips(s).last().evaluate((chip) => chip.nextSibling === null && (chip.previousSibling?.textContent ?? '').endsWith('\n')), `${String(bubble)} chips=${String(chipCount)}`)
    check('S3 transcript: the message appears once (the optimistic echo was replaced, not duplicated)', occurrences(await bodyText(s), T[1]) === 1, occurrences(await bodyText(s), T[1]))
    const user = turn?.users[0]
    check('S3 log: the user/message text is the typed text, a newline and /orchestrate-subagents (the token goes at the END)', user?.text === withToken(T[1]) && user.text.startsWith(T[1]) && user.text.endsWith(`\n${TOKEN}`), JSON.stringify(user?.text))
    check('S3 log: the token is there exactly once', occurrences(user?.text ?? '', TOKEN) === 1)
    const injection = turn?.injections.find((item) => item.name === SKILL)
    check('S3 log: DSH injected a message whose source is {kind: skill-invocation, name: orchestrate-subagents}', injection !== undefined && injection.event.data.source.kind === 'skill-invocation', injection === undefined ? 'none' : JSON.stringify(injection.event.data.source))
    check('S3 log: the injected text contains "Do not read code yourself"', injection?.text.includes('Do not read code yourself') === true, injection?.text.length)
    check('S3 log: exactly one injection in this turn, after the user message', turn?.injections.length === 1 && injection !== undefined && injection.event.seq > (user?.event.seq ?? Infinity), turn?.injections.length)
    const skillFile = join(repo, 'skills', SKILL, 'SKILL.md')
    if (existsSync(skillFile) && injection !== undefined) {
      const body = readFileSync(skillFile, 'utf8').replace(/^---[\s\S]*?\n---\n/, '').trim()
      check('S3 log: the injected text carries the whole body of skills/orchestrate-subagents/SKILL.md', injection.text.includes(body), `${String(body.length)} chars in the file, ${String(injection.text.length)} injected`)
    }
    shapes.S3_userMessage = user === undefined ? null : shapeOf(user.event)
    shapes.S3_injectedMessage = injection === undefined ? null : shapeOf(injection.event)
    await shot(s, 'S3-transcript-with-token')
  })

  // ---- S4 (0.8.3): every way OUT of the dialog ABORTS the send. Escape, the ✕, the Cancel button and a click on the mask
  // are walked one at a time, and each of them must leave the session log, the transcript, the stored configuration and
  // the remembered answer alone — with the draft still in the composer. The 0.6.0 checks had this backwards: they
  // asserted the message went out untouched.
  await section('S4', s, async () => {
    const posts = () => s.t.wire.filter((entry) => entry.method === 'POST').length
    const postsBefore = posts()

    /** One cancel path: a fresh draft raises the dialog, the path closes it, and NOTHING at all goes out. */
    const cancel = async (how, task, close) => {
      await ask(s, task)
      check(`S4 ${how}: the draft raises the dialog (the box is still CHECKED, the S3 answer)`, await skillBox(s).isChecked())
      await close()
      await dialog(s).waitFor({ state: 'hidden', timeout: 8_000 }).then(() => check(`S4 ${how}: the dialog closes`, true), () => check(`S4 ${how}: the dialog closes`, false))
      const gone = await absent(s, task)
      const bubble = await bubbleHolds(s, task)
      check(`S4 ${how}: NOTHING was sent — no user/message for that text in the session log and no bubble in the transcript`, gone.ok && !bubble.held, `log: ${gone.detail} after ${String(gone.ms)} ms; ${String(bubble.bubbles)} bubble(s) on screen, holding it=${String(bubble.held)}`)
      check(`S4 ${how}: the composer still holds the typed text (the draft survived the cancel)`, (await composerText(s)) === task, JSON.stringify(await composerText(s)))
    }

    // Escape first, with the switch flipped OFF: the box must not follow the switch (the 0.8.1 coupling is gone).
    await ask(s, T[2])
    check('S4 Escape: the dialog opens CHECKED (the S3 answer)', await skillBox(s).isChecked())
    await dialog(s).getByRole('switch').click() // OFF: the coupling is gone, so the box must not follow it
    check('S4 Escape: flipping the subagent-model switch OFF leaves the box CHECKED and ENABLED (no coupling, no hint)', await skillBox(s).isChecked() && !(await skillBox(s).isDisabled()) && (await effortSectionEvidence(s)).removedHints.length === 0)
    await s.page.keyboard.press('Escape')
    await dialog(s).waitFor({ state: 'hidden', timeout: 8_000 }).then(() => check('S4 Escape: the dialog closes', true), () => check('S4 Escape: the dialog closes', false))
    const escaped = await absent(s, T[2])
    const escapedBubble = await bubbleHolds(s, T[2])
    check('S4 Escape: NOTHING was sent — no user/message for that text in the session log and no bubble in the transcript', escaped.ok && !escapedBubble.held, `log: ${escaped.detail} after ${String(escaped.ms)} ms; ${String(escapedBubble.bubbles)} bubble(s) on screen, holding it=${String(escapedBubble.held)}`)
    check('S4 Escape: the composer still holds the typed text (the draft survived the cancel)', (await composerText(s)) === T[2], JSON.stringify(await composerText(s)))
    await shot(s, 'S4-after-escape')

    // The NEXT dialog is unchanged; toggle it and close with the ✕: nothing of that toggle may stick.
    await ask(s, T[3])
    check('S4 the NEXT dialog is still CHECKED after the Escape-cancel', await skillBox(s).isChecked())
    await skillBox(s).uncheck()
    await dialog(s).getByRole('button', { name: 'Close', exact: true }).click()
    await dialog(s).waitFor({ state: 'hidden', timeout: 8_000 })
    const closed = await absent(s, T[3])
    const closedBubble = await bubbleHolds(s, T[3])
    check('S4 the ✕ (Close): NOTHING was sent — no user/message in the log and no bubble for the text, even with the box toggled off before closing', closed.ok && !closedBubble.held, `log: ${closed.detail}; ${String(closedBubble.bubbles)} bubble(s), holding it=${String(closedBubble.held)}`)
    check('S4 the ✕ (Close): the composer still holds the typed text', (await composerText(s)) === T[3], JSON.stringify(await composerText(s)))
    check('S4 the ✕ (Close): an unconfirmed toggle is not remembered (still "on")', (await memory(s)) === 'on', await memory(s))

    await cancel('the Cancel button', T[4], async () => dialog(s).getByRole('button', { name: 'Cancel', exact: true }).click())
    await cancel('a click on the mask', T[5], async () => { await s.page.mouse.click(30, 400) })

    check('S4 the four cancel paths wrote NO configuration at all (not one POST reached the route: a cancel stores nothing)', posts() === postsBefore, `${String(postsBefore)} -> ${String(posts())} POSTs`)
    check('S4 after four cancels the answer is still remembered as "on" and the S2+S3 injections are still the only ones', (await memory(s)) === 'on' && readEvents(s.sessionId).filter(isInjection).length === 2, `memory=${String(await memory(s))}, injections=${String(readEvents(s.sessionId).filter(isInjection).length)}`)
    check('S4 the transcript still shows exactly TWO skill chips (no cancel added a message)', (await chips(s).count()) === 2, await chips(s).count())

    // The draft the last cancel left is sent for REAL now: a cancel must leave the composer exactly as it was ("as if it
    // had not been sent"), so the next send from it has to go out normally — the token, the injection and the bubble
    // included. It is also the proof that the absence checks above were not vacuous.
    await ask(s, T[5])
    check('S4 the next dialog still works after four cancels (the same task raises it, checked, with the preview)', await skillBox(s).isChecked() && await dialog(s).getByText(T[5], { exact: true }).isVisible())
    await sendWith(s)
    const sentAtLast = await landed(s, withToken(T[5]))
    check('S4 the NEXT send from that composer goes out normally (nothing was lost): the token is on the wire and DSH injected the skill', sentAtLast.turn?.users[0]?.text === withToken(T[5]) && sentAtLast.turn?.injections.length === 1, JSON.stringify(sentAtLast.turn?.users[0]?.text))
    check('S4 ...and the message it was typed from is now in the transcript (exactly three chips: no cancel left one)', (await chips(s).count()) === 3 && (await bubbleOf(s, T[5])) === `${T[5]} ${TOKEN}`, `${String(await chips(s).count())} chips, bubble=${String(await bubbleOf(s, T[5]))}`)
    await settleComposer(s)
  })

  // ---- S5: /orquestrar opens the configure dialog: nothing is being sent, so no skill section
  await section('S5', s, async () => {
    const before = turnsOf(readEvents(s.sessionId)).reduce((total, turn) => total + turn.users.length, 0)
    const posts = () => s.t.wire.filter((entry) => entry.method === 'POST').length
    const postsBefore = posts()
    const composer = s.page.getByRole('textbox', { name: COMPOSER })
    await composer.click()
    await s.page.keyboard.type('/orquestrar', { delay: 6 })
    await s.page.waitForTimeout(800)
    check('S5 the /orquestrar command is offered by the slash palette', await s.page.getByText(DIALOG).first().isVisible().catch(() => false))
    await s.page.keyboard.press('Enter')
    const opened = await dialog(s).waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)
    check('S5 the command opens the dialog in configure mode', opened && (await dialog(s).getByText('The options apply from the next task.').isVisible()))
    if (opened) {
      const dlg = dialog(s)
      check('S5 configure dialog: NO checkbox at all', (await dlg.getByRole('checkbox').count()) === 0, await dlg.getByRole('checkbox').count())
      check('S5 configure dialog: no "Orchestration skill" section, label or token text', (await dlg.getByRole('heading', { name: SKILL_TITLE }).count()) === 0 && (await dlg.getByText(/orchestration skill/i).count()) === 0 && (await dlg.getByText(TOKEN).count()) === 0)
      check('S5 configure dialog: the subagent switch and Save are there', (await dlg.getByRole('switch').count()) === 1 && (await dlg.getByRole('button', { name: 'Save', exact: true }).isVisible()))
      await shot(s, 'S5-configure')
      await s.page.keyboard.press('Escape')
      await dlg.waitFor({ state: 'hidden', timeout: 8_000 })
    }
    await clearComposer(s)
    await s.page.waitForTimeout(1_500)
    const after = turnsOf(readEvents(s.sessionId)).reduce((total, turn) => total + turn.users.length, 0)
    check('S5 nothing was sent by the command or by closing its dialog', after === before, `${String(before)} -> ${String(after)} user messages`)
    // Configure mode has no send at all, so closing it stores nothing (0.8.3 keeps this the way it was).
    check('S5 closing the configure dialog stored nothing (no POST reached the configuration route)', posts() === postsBefore, `${String(postsBefore)} -> ${String(posts())} POSTs`)

    // The dock chip is the other way into the configure dialog.
    const chip = s.page.getByRole('button', { name: /Subagent orchestration in this conversation/ })
    if (await chip.count() === 1) {
      await chip.click()
      const chipOpened = await dialog(s).waitFor({ state: 'visible', timeout: 8_000 }).then(() => true, () => false)
      check('S5 the dock chip opens the configure dialog, also without a skill section', chipOpened && (await dialog(s).getByRole('checkbox').count()) === 0 && (await dialog(s).getByText(/orchestration skill/i).count()) === 0)
      await s.page.keyboard.press('Escape')
      await dialog(s).waitFor({ state: 'hidden', timeout: 8_000 })
    }
  })

  // ---- S7: keyboard
  await section('S7', s, async () => {
    await ask(s, T[6])
    const dlg = dialog(s)
    const focused = () => s.page.evaluate(() => {
      const element = document.activeElement
      const name = element?.getAttribute('aria-label') ?? element?.labels?.[0]?.textContent ?? element?.textContent ?? ''
      return { inside: element !== null && element.closest('[role=dialog]') !== null, label: `${element?.tagName.toLowerCase() ?? '?'}:${name.trim().slice(0, 90)}` }
    })
    const clickLabel = async () => {
      const label = skillLabel(s)
      if (await label.count() > 0 && await label.first().isVisible()) { await label.first().click({ timeout: 4_000 }); return }
      const box = await skillBox(s).boundingBox()
      if (box !== null) await s.page.mouse.click(box.x + box.width + 24, box.y + box.height / 2)
    }
    const walk = []
    let escaped = 0
    for (let index = 0; index < 20; index += 1) {
      await s.page.keyboard.press('Tab')
      const state = await focused()
      walk.push(state.label)
      if (!state.inside) escaped += 1
    }
    check('S7 Tab never leaves the dialog (20 tabs)', escaped === 0, `${String(escaped)} escaped; ${walk.slice(0, 6).join(' > ')}`)
    check('S7 the skill checkbox is part of the Tab cycle (its copy matched loosely)', walk.some((label) => SKILL_NAME.test(label)), walk.join(' | '))
    check('S7 the effort select is part of the Tab cycle too', walk.some((label) => label.startsWith('select:')), walk.join(' | '))
    let backEscaped = 0
    for (let index = 0; index < 20; index += 1) {
      await s.page.keyboard.press('Shift+Tab')
      if (!(await focused()).inside) backEscaped += 1
    }
    check('S7 Shift+Tab never leaves the dialog either (20 presses)', backEscaped === 0, backEscaped)
    let reached = false
    for (let index = 0; index < 20 && !reached; index += 1) {
      await s.page.keyboard.press('Tab')
      reached = await skillBox(s).evaluate((element) => element === document.activeElement)
    }
    check('S7 the checkbox can be focused from the keyboard', reached, (await focused()).label)
    const before = await skillBox(s).isChecked()
    await s.page.keyboard.press('Space')
    check('S7 Space toggles the focused checkbox', (await skillBox(s).isChecked()) === !before, `${String(before)} -> ${String(await skillBox(s).isChecked())}`)
    await s.page.keyboard.press('Space')
    check('S7 Space again toggles it back', (await skillBox(s).isChecked()) === before)
    await clickLabel()
    check('S7 a real click on the checkbox label toggles it too (nothing covers it)', (await skillBox(s).isChecked()) === !before)
    await clickLabel()
    check('S7 and back', (await skillBox(s).isChecked()) === before)
    await shot(s, 'S7-keyboard')
    await s.page.keyboard.press('Escape')
    await dlg.waitFor({ state: 'hidden', timeout: 8_000 }).then(() => check('S7 Escape closes the dialog', true), () => check('S7 Escape closes the dialog', false))
    // 0.8.3: Escape from the keyboard is the same cancel as anywhere else — the message does NOT go out and the draft stays.
    const escapedByKeyboard = await absent(s, T[6])
    const bubble = await bubbleHolds(s, T[6])
    check('S7 Escape cancels the send: no user/message in the log, no bubble in the transcript, no skill injected', escapedByKeyboard.ok && !bubble.held && readEvents(s.sessionId).filter(isInjection).length === 3, `log: ${escapedByKeyboard.detail}; ${String(bubble.bubbles)} bubble(s), holding it=${String(bubble.held)}`)
    check('S7 the cancelled draft is still in the composer', (await composerText(s)) === T[6], JSON.stringify(await composerText(s)))
    // ...and the next dialog still works after a keyboard cancel.
    await ask(s, T[18])
    check('S7 the next dialog still works after the Escape-cancel (checked, with the preview)', await skillBox(s).isChecked() && await dialog(s).getByText(T[18], { exact: true }).isVisible())
    await s.page.keyboard.press('Escape')
    await dlg.waitFor({ state: 'hidden', timeout: 8_000 })
    const second = await absent(s, T[18])
    check('S7 the second Escape cancels too (nothing sent, draft kept)', second.ok && (await composerText(s)) === T[18], `log: ${second.detail}; composer=${JSON.stringify(await composerText(s))}`)
  })

  // ---- X: Enter on the focused primary button confirms with the default (checked) answer
  await section('X-enter', s, async () => {
    await ask(s, T[7])
    check('X the primary button holds the focus when the dialog opens', await dialog(s).getByRole('button', { name: SEND }).evaluate((element) => element === document.activeElement))
    await s.page.keyboard.press('Enter')
    await dialog(s).waitFor({ state: 'hidden', timeout: 8_000 })
    const result = await landed(s, withToken(T[7]))
    check('X Enter on the dialog confirms: the message carries the token and DSH injected the skill', result.turn?.users[0]?.text === withToken(T[7]) && result.turn?.injections.length === 1, JSON.stringify(result.turn?.users[0]?.text))
  })

  // ---- X: a token the user typed is not doubled, wherever it is
  await section('X-typed', s, async () => {
    // At the end of the text the slash palette stays open (Enter would pick its entry), so a space closes it; DSH trims it again.
    for (const [where, keys, typed] of [
      ['as the first word', `${TOKEN} ${T[8]}`, `${TOKEN} ${T[8]}`],
      ['inside the text', `${T[13]} ${TOKEN} please`, `${T[13]} ${TOKEN} please`],
      ['as the last word', `${T[14]} ${TOKEN} `, `${T[14]} ${TOKEN}`],
    ]) {
      await ask(s, keys)
      check(`X typing the token yourself (${where}) still raises the dialog, with the box TICKED and LOCKED by the token in the message`, await skillBox(s).isChecked() && await skillBox(s).isDisabled(), `checked=${String(await skillBox(s).isChecked())} disabled=${String(await skillBox(s).isDisabled())}`)
      await sendWith(s)
      const result = await landed(s, typed)
      const text = result.turn?.users[0]?.text ?? ''
      check(`X a token typed ${where} is not doubled: the message is exactly what was typed, with one injection`, text === typed && occurrences(text, TOKEN) === 1 && result.turn?.injections.length === 1, `${JSON.stringify(text)}, injections=${String(result.turn?.injections.length)}`)
    }
  })

  // ---- X: a multi-line task keeps the token on its own LAST line
  await section('X-multiline', s, async () => {
    const typed = `${T[15]}\nand nothing else`
    await s.page.getByRole('textbox', { name: COMPOSER }).click()
    await s.page.getByRole('textbox', { name: COMPOSER }).fill(typed)
    await s.page.keyboard.press('Enter')
    await dialog(s).waitFor({ state: 'visible', timeout: 15_000 })
    noteSession(s)
    check('X multi-line task: the dialog previews it on one line, whitespace collapsed', await dialog(s).getByText(`${T[15]} and nothing else`, { exact: true }).isVisible())
    await sendWith(s)
    const result = await landed(s, withToken(typed))
    const text = result.turn?.users[0]?.text ?? ''
    check('X multi-line task: the lines are untouched and the token is the last line, on its own', text === withToken(typed) && text.split('\n').at(-1) === TOKEN && text.split('\n').length === 3, JSON.stringify(text))
    check('X multi-line task: DSH injected the skill', result.turn?.injections.length === 1)
  })

  // ---- X: a message with an attachment and no text: the token becomes a text part of its own
  await section('X-attach', s, async () => {
    const file = join(out, ATTACHMENT)
    writeFileSync(file, 'one line of text for the attachment-only message\n')
    await settleComposer(s) // nothing left by the previous send, and no card of an earlier upload
    await s.page.locator('input[type=file]').first().setInputFiles(file)
    // The upload has to FINISH and its card has to be drawn before Enter: racing it left the file attached after a
    // failed send, and the next messages went out carrying that stale part (found by the 0.8.2 verifier).
    const composer = await settleComposer(s, { file: ATTACHMENT })
    await composer.click()
    await s.page.keyboard.press('Enter')
    const asked = await dialog(s).waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false)
    check('X an attachment with no text still raises the dialog, with the checkbox', asked && (await skillBox(s).count()) === 1)
    if (!asked) return
    noteSession(s)
    await sendWith(s)
    const result = await landed(s, /^\/orchestrate-subagents(\s|$)/)
    const parts = result.turn?.users[0]?.event.data.content.map((part) => part.type) ?? []
    check('X attachment-only message: the token is a text part of its own, in front of the file, and the skill was injected', result.turn?.users[0]?.text === TOKEN && parts.length === 2 && parts[0] === 'text' && result.turn?.injections.length === 1, `${parts.join(',')} | ${JSON.stringify(result.turn?.users[0]?.text)}`)
    // The send must consume the attachment: a card that stayed would ride along with the next messages.
    for (let waited = 0; waited < 10_000 && (await attachmentCards(s, ATTACHMENT).count()) > 0; waited += 250) await s.page.waitForTimeout(250)
    check('X the attachment did not outlive its send (the composer holds no stale file card)', (await attachmentCards(s, ATTACHMENT).count()) === 0, await composerText(s))
  })

  // ---- X: the answers so far, as the conversation's log sees them
  await section('X-log', s, async () => {
    const events = readEvents(s.sessionId)
    const copies = events.filter(isInjection)
    const tokened = turnsOf(events).filter((turn) => turn.users.some((user) => user.text.includes(TOKEN))).length
    check('X every message that carried the token got exactly one injection, none of the others got any', copies.length === tokened && turnsOf(events).every((turn) => turn.injections.length === (turn.users.some((user) => user.text.includes(TOKEN)) ? 1 : 0)), `${String(copies.length)} injections for ${String(tokened)} tokened messages`)
    advise('the skill text is injected again by EVERY tokened message (the history keeps each copy)', copies.length <= 1, `${String(copies.length)} copies x ${String(copies[0] === undefined ? 0 : textOfMessage(copies[0]).length)} chars in one conversation of ${String(turnsOf(events).length)} turns`)
  })

  // ---- X: the answer survives a reload and reaches a new conversation; the skill and a subagent model travel together
  await section('X-reload', s, async () => {
    await s.page.reload({ waitUntil: 'networkidle', timeout: 60_000 })
    await s.page.getByRole('textbox', { name: COMPOSER }).waitFor({ state: 'visible', timeout: 30_000 })
    check('X after a reload the remembered answer is still "on"', (await memory(s)) === 'on', await memory(s))
    // 0.8.3: a cancel ABORTS the send, so the draft it was typed from survives — the observable every flipped cancel path
    // shares, asserted here on the page the group reloaded (the composer is the host's own, freshly mounted).
    await ask(s, T[19])
    check('X-reload the draft raises the dialog (the box is CHECKED and ENABLED)', await skillBox(s).isChecked() && !(await skillBox(s).isDisabled()))
    await s.page.keyboard.press('Escape')
    await dialog(s).waitFor({ state: 'hidden', timeout: 8_000 })
    const cancelled = await absent(s, T[19])
    check('X-reload the cancelled draft was NOT sent (no user/message in the log, no bubble)', cancelled.ok && !(await bubbleHolds(s, T[19])).held, `log: ${cancelled.detail}`)
    check('X-reload the composer still holds the cancelled draft, and it is exactly what was typed', (await composerText(s)) === T[19], JSON.stringify(await composerText(s)))
    await settleComposer(s) // the draft must not ride along with the group's next message
    await newConversation(s)
    const fresh = s.sessionId
    await ask(s, T[9])
    check('X a NEW conversation opens with the same remembered answer (CHECKED)', await skillBox(s).isChecked())
    check('X the new conversation is another session', s.sessionId !== undefined && s.sessionId !== fresh, `${String(s.sessionId).slice(0, 16)} vs ${String(fresh).slice(0, 16)}`)
    // 0.8.2: AUTO-MAX fires on a MODEL pick or change, never on the switch, so a level that is NOT the model's highest
    // is what tells the shipped behavior apart from a jump to the top. Pick one by hand, then round-trip the switch.
    const effortOpen = await effortSelect(s)
    const lowerIndex = effortOpen !== undefined && effortOpen.options.length > 2 ? 1 : 0
    await effortOpen.handle.selectOption({ index: lowerIndex })
    const chosen = await effortSelect(s)
    check('X a level picked by hand (never the model\'s highest) is what the select holds', chosen !== undefined && chosen.selected === lowerIndex && chosen.selected !== chosen.options.length - 1, JSON.stringify({ selected: chosen?.selected, options: chosen?.options }))
    await dialog(s).getByRole('switch').click() // off
    check('X with the switch OFF the skill box stays CHECKED and ENABLED (the coupling is gone)', await skillBox(s).isChecked() && !(await skillBox(s).isDisabled()))
    const effortOff = await effortSelect(s)
    const anchorOff = effortOff === undefined ? null : await effortAnchor(s, effortOff.index)
    check('X with the switch off the effort select moves up to sit under the switch', anchorOff !== null && anchorOff.anchor !== null && anchorOff.anchor.role === 'switch' && anchorOff.gap !== null && anchorOff.gap <= 200, JSON.stringify(anchorOff))
    await dialog(s).getByRole('switch').click() // on again
    check('X toggling the switch back ON keeps the box ticked and enabled', await skillBox(s).isChecked() && !(await skillBox(s).isDisabled()))
    await s.page.waitForTimeout(300)
    check('X the picker still shows the remembered model after the round trip', s.worker !== undefined && s.worker.name.test(await modelShown(s)), `${await modelShown(s)} vs ${String(s.worker?.label)}`)
    const effortOn = await effortSelect(s)
    // The stored level has to survive the OFF -> ON round trip untouched. The old check asserted the opposite ("jumps back
    // to that model's highest level", the auto-max "following the model"): that is not the shipped behavior, it only
    // looked right because this home's stored level happened to BE the highest (found by the 0.8.2 verifier).
    check('X ...and the effort select still shows the SAME stored level after the OFF -> ON round trip (the switch does not auto-max)', effortOn !== undefined && effortOn.selected === chosen?.selected && filledOptions(effortOn).join('|') === filledOptions(chosen).join('|'), JSON.stringify({ before: chosen?.options?.[chosen?.selected], after: effortOn?.options?.[effortOn?.selected], options: effortOn?.options }))
    check('X the skill box is still ticked after the model round trip', await skillBox(s).isChecked())
    // What DOES auto-max is a MODEL CHANGE: pick another route this home carries and the select jumps to its highest.
    // The other route has to be a row the current one does NOT already answer to (the Azure and the OpenRouter DeepSeek
    // candidates share a name pattern, so matching any row would silently re-pick the same model).
    const entries = await modelEntries(s)
    const workerEntry = entries?.find((text) => s.worker !== undefined && s.worker.name.test(text))
    const other = WORKER_CANDIDATES.find((candidate) => candidate !== s.worker && candidate.label !== s.worker?.label
      && (entries === undefined || entries.some((text) => text !== workerEntry && candidate.name.test(text))))
    if (other === undefined) {
      skip('X a MODEL CHANGE sets the effort to the new model\'s highest level', `this home offers no other known route than ${String(s.worker?.label)}`)
    } else {
      const changed = await pickModel(s, other.name)
      const effortChanged = await effortSelect(s)
      if (effortChanged !== undefined && effortChanged.disabled) {
        skip('X a MODEL CHANGE sets the effort to the new model\'s highest level', `${other.label} declares no reasoning ladder on this home (its select is disabled)`)
      } else {
        check('X a MODEL CHANGE sets the effort to that model\'s HIGHEST level (auto-max on the pick, not on the switch)', changed && effortChanged !== undefined && effortChanged.selected > 0 && effortChanged.selected === effortChanged.options.length - 1, JSON.stringify({ model: other.label, selected: effortChanged?.selected, options: effortChanged?.options }))
      }
      const back = await pickModel(s, s.worker.name)
      check('X the home\'s own subagent model is accepted again (the send below runs on it)', back, await modelShown(s))
    }
    const postsBefore = s.t.wire.filter((entry) => entry.method === 'POST').length
    await sendWith(s)
    await s.page.waitForTimeout(500)
    const posts = s.t.wire.filter((entry) => entry.method === 'POST')
    const saved = posts.length > postsBefore ? JSON.parse(posts.at(-1).body ?? '{}').config : null
    check('X the stored configuration carries the model and NOTHING about the skill', saved?.subagentModel?.model !== undefined && saved.subagentModel.model === (s.worker ?? WORKER_CANDIDATES[0]).id && Object.keys(saved).sort().join() === 'reviewer,subagentModel,version,workerEffort', JSON.stringify(saved))
    check('X the host accepted it (200)', posts.at(-1)?.status === 200, posts.at(-1)?.status)
    const result = await landed(s, withToken(T[9]))
    check('X skill + subagent model: the message still carries the token and the skill was injected', result.turn?.users[0]?.text === withToken(T[9]) && result.turn?.injections.length === 1, JSON.stringify(result.turn?.users[0]?.text))
    const title = readEvents(s.sessionId).filter((event) => event.type === 'session/title').at(-1)?.data
    // A provider-generated title is fine ("Prompting exact reply and subagent orchestration" was seen on this home):
    // what the check is about is that the title is really there and that the skill TOKEN never leaks into it.
    check('X the conversation title is non-empty and does not start with the skill token (a provider title is fine)', title !== undefined && normal(title.title) !== '' && !normal(title.title).startsWith(TOKEN), `title=${JSON.stringify(title?.title)} source=${JSON.stringify(title?.source)}`)
    await shot(s, 'X-skill-and-model')

    // A SHORT first message: DSH's fallback title takes up to five words, so the token on its own line can still make it in.
    await newConversation(s)
    await ask(s, 'Say ok')
    await sendWith(s)
    const short = await landed(s, withToken('Say ok'))
    const shortTitle = readEvents(s.sessionId).filter((event) => event.type === 'session/title').at(-1)?.data
    check('X a short first message ("Say ok") still carries the token and gets the skill', short.turn?.users[0]?.text === withToken('Say ok') && short.turn?.injections.length === 1, JSON.stringify(short.turn?.users[0]?.text))
    advise('the title of a conversation that starts with a SHORT message (fewer than five words) does not contain the token', shortTitle !== undefined && !shortTitle.title.includes(TOKEN), `title=${JSON.stringify(shortTitle?.title)} source=${JSON.stringify(shortTitle?.source)}`)
    await shot(s, 'X-short-title')
  })

  await s.context.close()
}

// ------------------------------------------------------------------------------------------------ S10: a subagent's own conversation

/**
 * Every ROOT session of this home that has subagent children, read from the logs: `{ rootId, titles, kids }`. A subagent's
 * own log is headed by `origin: 'subagent'` and names its `parentSession`, so the roots are the sessions whose first event
 * carries neither; the parent's `subagent/catalog` events give each child's mode — `continuable` is the child that takes
 * further messages, the one the header dropdown offers as a conversation of its own. A title is no way to find a session:
 * DSH rewrites it (a rename, source `user`) and a generated title can win the sidebar over the rewrite (measured here), so
 * every title the log ever carried is kept, most recent first, and the row is looked up by whichever one the sidebar shows.
 */
function parentsWithChildren() {
  const found = []
  for (const workspace of readdirSync(sessionsDir)) {
    let entries = []
    try {
      entries = readdirSync(join(sessionsDir, workspace))
    } catch {
      continue
    }
    for (const id of entries) {
      if (!id.startsWith('session-')) continue
      const file = join(sessionsDir, workspace, id, 'session.v3.jsonl.zstd')
      if (!existsSync(file)) continue
      const events = readEventsAt(file)
      if (events[0]?.origin === 'subagent' || events[0]?.parentSession !== undefined) continue
      const titles = [...new Set(events.filter((event) => event.type === 'session/title' && typeof event.data?.title === 'string').map((event) => event.data.title))].reverse()
      const kids = []
      const seen = new Set()
      for (const event of events) {
        if (event.type !== 'subagent/catalog' || seen.has(event.data.childId)) continue
        seen.add(event.data.childId)
        kids.push({ id: event.data.childId, mode: event.data.mode ?? null, label: event.data.label ?? null })
      }
      if (titles.length > 0 && kids.length > 0) found.push({ rootId: id, titles, kids })
    }
  }
  return found
}

/** The sidebar row of the session whose log carried one of `titles` (a long title may be cut in the row: its opening words count too). */
async function sessionRow(s, titles) {
  const sidebar = s.page.getByRole('tree', { name: 'Sessions' })
  const candidates = [...titles, ...titles.filter((title) => title.length > 30).map((title) => title.slice(0, 30))]
  for (const title of candidates) {
    const rows = sidebar.getByRole('treeitem').filter({ hasText: title })
    if (await rows.count() > 0) return { row: rows.first(), title }
  }
  return undefined
}

/** The whole sidebar loaded: collapsed groups opened and "Show more sessions" pressed until it stops offering more. */
async function expandSidebar(s) {
  const sidebar = s.page.getByRole('tree', { name: 'Sessions' })
  for (let index = 0; index < 20; index += 1) {
    const collapsed = sidebar.locator('[role=treeitem][aria-expanded=false]').first()
    if (await collapsed.count() === 0) break
    await collapsed.click()
    await s.page.waitForTimeout(200)
  }
  for (let index = 0; index < 20; index += 1) {
    const more = sidebar.getByRole('button', { name: /Show \d+ more sessions/ }).first()
    if (await more.count() === 0) break
    await more.click()
    await s.page.waitForTimeout(200)
  }
}

/**
 * From the header dropdown of a parent session, open a child that takes messages: a continuable one. The parent and its
 * children come from the logs (`parentsWithChildren`), never from a title written down here, so this works on any home.
 * `undefined` = this home holds no continuable child at all (the step SKIPs, cleanly); an exception = it holds one that
 * could not be opened, which is a FAIL of the step and not a SKIP.
 */
async function openContinuableChild(s) {
  const parents = parentsWithChildren().filter((parent) => parent.kids.some((kid) => kid.mode === 'continuable'))
  if (parents.length === 0) return undefined
  await expandSidebar(s)
  for (const parent of parents.sort((left, right) => left.kids.length - right.kids.length)) {
    const hit = await sessionRow(s, parent.titles)
    if (hit === undefined) continue
    const before = s.t.sessionIds.length
    await hit.row.click()
    for (let waited = 0; waited < 5_000 && s.t.sessionIds.length === before; waited += 100) await s.page.waitForTimeout(100)
    await s.page.waitForTimeout(700)
    await s.page.mouse.move(8, 8)
    await s.page.waitForTimeout(150)
    await s.page.locator(TRIGGER).first().hover()
    const menu = s.page.locator(TREE)
    if (!(await menu.waitFor({ state: 'attached', timeout: 6_000 }).then(() => true, () => false))) continue
    await s.page.waitForTimeout(250)
    const items = menu.getByRole('treeitem')
    const texts = await items.evaluateAll((elements) => elements.map((element) => (element.textContent ?? '').replace(/\s+/g, ' ')))
    const wanted = texts.findIndex((text) => text.includes('continuable'))
    if (wanted < 0) {
      await s.page.mouse.move(8, 8)
      continue
    }
    await items.nth(wanted).click()
    await s.page.waitForTimeout(2_000)
    return { parent, row: hit.title, label: texts[wanted], switcher: await s.page.locator(TRIGGER).first().getAttribute('aria-label').catch(() => null) }
  }
  throw new Error(`this home holds ${String(parents.length)} parent(s) with a continuable child (titles: ${parents.map((parent) => parent.titles.join(' / ')).join('; ')}) but none could be opened from the sidebar`)
}

async function child() {
  const s = await newPage('S10-child')
  await open(s)
  await section('S10', s, async () => {
    const opened = await openContinuableChild(s)
    if (opened === undefined) {
      skip('S10 a subagent\'s own conversation', 'no continuable child in this DSH home (run a background `subagent` task first)')
      return
    }
    check('S10 the parent\'s header dropdown opens the child\'s own conversation (the header switcher names it)', /^Switch subagent: /.test(opened.switcher ?? ''), `child=${opened.label} :: switcher=${String(opened.switcher)} :: parent titles=${opened.parent.titles.join(' / ')} :: shown as=${opened.row}`)
    // The prompt is captured and ABORTED: no model runs in the child, and the content that would go out is what is judged.
    const toChild = []
    const toMain = []
    await s.page.route('**/api/subagents/prompt', async (route) => { toChild.push(route.request().postData() ?? ''); await route.abort() })
    await s.page.route('**/api/session/prompt', async (route) => { toMain.push(route.request().postData() ?? ''); await route.abort() })
    s.t.expecting = true
    const outgoing = (body) => { try { return JSON.parse(body).payload.args.request.content.map((part) => part.text ?? `<${part.type}>`).join('') } catch { return undefined } }
    const waitSends = async (count) => { for (let waited = 0; waited < 8_000 && toChild.length < count; waited += 250) await s.page.waitForTimeout(250) }

    await ask(s, T[16])
    const dlg = dialog(s)
    check('S10 a subagent\'s own conversation raises the dialog too', await dlg.isVisible())
    check('S10 ...with NO skill section and NO checkbox (the skill is for the agent that coordinates)', (await dlg.getByRole('checkbox').count()) === 0 && (await dlg.getByRole('heading', { name: SKILL_TITLE }).count()) === 0 && (await dlg.getByText(/orchestration skill/i).count()) === 0 && (await dlg.getByText(TOKEN).count()) === 0)
    check('S10 ...and still has the subagent switch and the Send button', (await dlg.getByRole('switch').count()) === 1 && (await dlg.getByRole('button', { name: SEND }).isVisible()))
    await shot(s, 'S10-subagent-dialog')
    await s.page.keyboard.press('Escape')
    await dlg.waitFor({ state: 'hidden', timeout: 8_000 })
    await s.page.waitForTimeout(1_000)
    // 0.8.3: Escape cancels the send in a child's conversation too — nothing reaches the subagent OR the main agent, and
    // the draft waits in the composer (the capture routes below then witness the "Send with these options" half).
    check('S10 Escape cancels the send: NOTHING goes out to the subagent or to the main agent', toChild.length === 0 && toMain.length === 0, `toChild=${String(toChild.length)}, toMain=${String(toMain.length)}`)
    check('S10 the cancelled draft is still in the composer', (await composerText(s)) === T[16], JSON.stringify(await composerText(s)))

    // The CANCEL left its draft in the composer: wait until the composer stops changing, then empty it, or the draft
    // lands after the new task and travels out with it.
    const composer = s.page.getByRole('textbox', { name: COMPOSER })
    let previous = null
    for (let stable = 0; stable < 4;) {
      await s.page.waitForTimeout(500)
      const now = (await composer.innerText()).trim()
      stable = now === previous ? stable + 1 : 0
      previous = now
    }
    await clearComposer(s)
    await ask(s, T[17])
    check('S10 the next dialog in the subagent conversation has no checkbox either', (await dialog(s).getByRole('checkbox').count()) === 0)
    await sendWith(s)
    await waitSends(1) // only NOW does anything go out: the Escape above cancelled its send
    // DSH's give-back of an aborted message can still land in the composer after the clear (measured on this home), so the
    // payload may be the typed task followed by that leftover. What S10 is about is that no token ever goes out to a child.
    const sent = outgoing(toChild[0]) ?? ''
    check('S10 "Send with these options": the message that goes out has no token either', toChild.length === 1 && toMain.length === 0 && sent.includes(T[17]) && !sent.includes(TOKEN), JSON.stringify(sent))
    await s.page.waitForTimeout(1_000)
    s.t.expecting = false
  })
  await s.context.close()
}

// ------------------------------------------------------------------------------------------------ S6: both themes, a short screen

/** Colours of the controls the dialog draws its own copy with: the checkbox row, the effort select and, when they exist, a heading and a hint. */
async function colorsOf(s) {
  return s.page.evaluate(() => {
    const root = document.querySelector('[role=dialog]')
    const alphaOf = (value) => {
      const parts = String(value).match(/[0-9.]+/g) ?? []
      return String(value).startsWith('rgba') && parts.length >= 4 ? Number(parts[3]) : 1
    }
    const backdrop = (start) => {
      for (let node = start; node !== null; node = node.parentElement) {
        const color = getComputedStyle(node).backgroundColor
        if (alphaOf(color) > 0.5) return color
      }
      return 'rgb(255, 255, 255)'
    }
    const measure = (element) => (element === null || element === undefined ? null : { color: getComputedStyle(element).color, background: backdrop(element) })
    const checkbox = root.querySelector('[role=checkbox], input[type=checkbox]')
    const select = root.querySelector('select')
    const row = (element) => (element === null ? null : (element.closest('label') ?? element.parentElement))
    const heading = root.querySelector('h3')
    const hint = root.querySelector('p')
    return {
      label: measure(row(checkbox)),
      select: measure(select),
      heading: measure(heading),
      hint: measure(hint),
    }
  })
}

async function themes() {
  // light theme, a normal desktop window
  const light = await newPage('S6-light', { scheme: 'light' })
  await section('S6-light', light, async () => {
    await open(light)
    await ask(light, T[10])
    const dlg = dialog(light)
    await dlg.getByRole('checkbox').first().waitFor({ state: 'visible', timeout: 8_000 })
    check('S6 light theme: the fresh dialog renders the box CHECKED and ENABLED with the switch off, and the effort select is there', (await skillBox(light).isVisible()) && await skillBox(light).isChecked() && !(await skillBox(light).isDisabled()) && (await dlg.getByRole('switch').first().getAttribute('aria-checked')) === 'false' && (await effortSectionEvidence(light)).selects === 1)
    check('S6 light theme: the rest of the dialog is intact (one switch, off; Send is visible)', (await dlg.getByRole('switch').count()) === 1 && (await dlg.getByRole('button', { name: SEND }).isVisible()))
    const colors = await colorsOf(light)
    const ratio = (entry) => (entry === null ? 0 : contrast(entry.color, entry.background))
    check('S6 light theme: the checkbox row and the effort select are legible on the dialog (contrast >= 4.5 each)', ratio(colors.label) >= 4.5 && ratio(colors.select) >= 4.5, `label ${ratio(colors.label).toFixed(1)}, select ${ratio(colors.select).toFixed(1)}`)
    // 0.8.3: the select must be legible on its OWN paint, not on whatever surface happens to sit behind it (the 0.8.2
    // look was white-on-white in dark, its items readable only on hover). Computed styles, resting AND focused.
    await selectLegibility(light, 'S6 light theme', { dark: false })
    advise('S6 light theme: the surrounding heading and hint stay legible too (>= 4.5 / >= 3, skipped when the redesigned dialog does not draw them)', (colors.heading === null || ratio(colors.heading) >= 4.5) && (colors.hint === null || ratio(colors.hint) >= 3), `heading ${colors.heading === null ? 'absent' : ratio(colors.heading).toFixed(1)}, hint ${colors.hint === null ? 'absent' : ratio(colors.hint).toFixed(1)}`)
    await shot(light, 'S6-light')
  })
  await light.context.close()

  // a short laptop screen, in both themes: the model on, the effort select and the skill box present
  for (const scheme of ['dark', 'light']) {
    const small = await newPage(`S6-small-${scheme}`, { scheme, viewport: { width: 1024, height: 600 } })
    await section(`S6-small-${scheme}`, small, async () => {
      await open(small)
      await ask(small, T[11])
      const dlg = dialog(small)
      await dlg.getByRole('switch').click()
      const worker = await pickWorker(small)
      check(`S6 ${scheme} 1024x600: the picker accepts the model (the dialog is at its fullest)`, worker !== undefined, await modelShown(small))
      await small.page.waitForTimeout(600)
      const box = await dlg.boundingBox()
      const sendBox = await dlg.getByRole('button', { name: SEND }).boundingBox()
      const label = `S6 ${scheme} 1024x600 (model on, effort select live)`
      check(`${label}: the dialog is not taller than the viewport and is inside it`, box !== null && box.height <= 600 && box.y >= 0 && box.y + box.height <= 600, JSON.stringify(box))
      check(`${label}: "${SEND}" is inside the viewport and the dialog`, sendBox !== null && box !== null && sendBox.y >= box.y && sendBox.y + sendBox.height <= Math.min(600, box.y + box.height), JSON.stringify(sendBox))
      check(`${label}: the skill box is present, CHECKED and ENABLED, with the effort select above it`, (await skillBox(small).count()) === 1 && await skillBox(small).isChecked() && !(await skillBox(small).isDisabled()) && (await effortSelect(small)) !== undefined)
      // 0.8.3: the select's OWN computed paint, in this theme too (dark is where the white-on-white was reported).
      await selectLegibility(small, label, { dark: scheme === 'dark' })
      const info = await skillBox(small).evaluate((element) => {
        for (let node = element.parentElement; node !== null && node !== document.body; node = node.parentElement) {
          const style = getComputedStyle(node)
          if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1) return { scrolls: true, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }
        }
        return { scrolls: false }
      })
      // The redesigned dialog may well fit without scrolling (the effort block is gone): only a scrolling stack is asked
      // to keep the box reachable, and a stack that fits is reported instead of failed.
      if (info.scrolls) {
        await skillBox(small).scrollIntoViewIfNeeded()
        const placed = await skillBox(small).evaluate((element) => {
          const rect = element.getBoundingClientRect()
          const dialogRect = document.querySelector('[role=dialog]').getBoundingClientRect()
          const footer = [...document.querySelectorAll('[role=dialog] button')].find((button) => button.textContent === 'Send with these options')?.getBoundingClientRect()
          return { top: rect.top, bottom: rect.bottom, dialogTop: dialogRect.top, footerTop: footer?.top ?? 0 }
        })
        check(`${label}: the stack scrolls and, scrolled to the end, the checkbox is fully visible above the footer buttons`, placed.top >= placed.dialogTop - 1 && placed.bottom <= placed.footerTop + 1, JSON.stringify({ ...info, ...placed }))
      } else {
        advise(`${label}: the content is SHORTER than its box, so nothing has to scroll (the stack fits whole)`, true, JSON.stringify(info))
      }
      const state = await skillBox(small).isChecked()
      const labelHandle = skillLabel(small)
      if (await labelHandle.count() > 0) await labelHandle.first().click({ timeout: 4_000 })
      else {
        const rect = await skillBox(small).boundingBox()
        await small.page.mouse.click(rect.x + rect.width + 24, rect.y + rect.height / 2)
      }
      check(`${label}: a real click on the checkbox label toggles it (nothing covers it)`, (await skillBox(small).isChecked()) === !state)
      if (await labelHandle.count() > 0) await labelHandle.first().click({ timeout: 4_000 })
      else {
        const rect = await skillBox(small).boundingBox()
        await small.page.mouse.click(rect.x + rect.width + 24, rect.y + rect.height / 2)
      }
      await shot(small, `S6-small-${scheme}`)
    })
    await small.context.close()
  }
}

// ------------------------------------------------------------------------------------------------ S8: wire compatibility

async function wire() {
  const s = await newPage('S8-wire')
  const pattern = '**/dsh-orquestrator/config*'
  let mode = 'passthrough'
  await s.page.route(pattern, async (route) => {
    if (mode === 'passthrough') return route.continue()
    if (mode === 'error' && route.request().method() === 'GET') return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'internal', message: 'injected failure' }) })
    const response = await route.fetch()
    const json = await response.json()
    if (mode === 'absent') delete json.skill
    if (mode === 'unavailable') json.skill = { name: SKILL, available: false }
    if (mode === 'malformed') json.skill = { name: 'Not A Name!', available: true }
    await route.fulfill({ response, json })
  })
  await open(s)

  /** One message under one route behaviour: the dialog must show no skill section, and a confirm must send no token. */
  const noSection = async (name, behaviour, text, how) => {
    mode = behaviour
    if (behaviour === 'error') s.t.expecting = true
    await ask(s, text)
    const dlg = dialog(s)
    await dlg.getByRole('switch').waitFor({ state: 'visible', timeout: 8_000 })
    check(`S8 ${name}: the dialog still asks (the subagent switch is there)`, (await dlg.getByRole('switch').count()) === 1)
    check(`S8 ${name}: NO skill section and NO checkbox`, (await dlg.getByRole('checkbox').count()) === 0 && (await dlg.getByRole('heading', { name: SKILL_TITLE }).count()) === 0 && (await dlg.getByText(TOKEN).count()) === 0, await dlg.getByRole('checkbox').count())
    await shot(s, `S8-${slug(name)}`)
    if (how === 'confirm') {
      await sendWith(s)
      const result = await landed(s, text)
      check(`S8 ${name}: the message went out as typed, with no token and no injection`, result.turn?.users[0]?.text === text && result.turn?.injections.length === 0, JSON.stringify(result.turn?.users[0]?.text))
    } else {
      // 0.8.3: this path cancels the send instead — nothing goes out, and the draft comes back to the composer.
      await s.page.keyboard.press('Escape')
      await dlg.waitFor({ state: 'hidden', timeout: 8_000 })
      const gone = await absent(s, text)
      check(`S8 ${name}: Escape cancels the send (nothing in the log, no bubble) and the draft stays in the composer`, gone.ok && !(await bubbleHolds(s, text)).held && (await composerText(s)) === normal(text), `log: ${gone.detail}; composer=${JSON.stringify(await composerText(s))}`)
    }
    s.t.expecting = false
  }

  await section('S8-absent', s, () => noSection('a host without the skill field (older than 0.8)', 'absent', T[0], 'confirm'))
  const seen = s.t.wire.filter((entry) => entry.method === 'GET').at(-1)
  check('S8 the page really received an answer without the skill field', seen !== undefined && seen.skill === '<absent>', JSON.stringify(seen?.skill))
  await section('S8-unavailable', s, () => noSection('a host that says available: false', 'unavailable', T[1], 'confirm'))
  check('S8 a send with no skill on offer does not touch the remembered answer', (await memory(s)) === null, await memory(s))
  await section('S8-malformed', s, () => noSection('a malformed offer (name "Not A Name!")', 'malformed', T[2], 'escape'))
  await section('S8-error', s, () => noSection('a configuration route that fails (HTTP 500)', 'error', T[3], 'confirm'))

  // The unmodified route: the section is back (ticked by default, not gated by the switch), and a confirm carries the token.
  await section('S8-passthrough', s, async () => {
    mode = 'passthrough'
    await s.page.unroute(pattern)
    await ask(s, T[4])
    const dlg = dialog(s)
    check('S8 unmodified route: the skill checkbox is back (exactly one)', (await dlg.getByRole('checkbox').count()) === 1 && (await skillBox(s).count()) === 1)
    check('S8 unmodified route: the box opens CHECKED and ENABLED with the switch off', await skillBox(s).isChecked() && !(await skillBox(s).isDisabled()))
    await dialog(s).getByRole('switch').click()
    const worker = await pickWorker(s)
    check('S8 unmodified route: the picker accepts the model, and the box is untouched by the switch', worker !== undefined && await skillBox(s).isChecked() && !(await skillBox(s).isDisabled()))
    await shot(s, 'S8-unmodified')
    await sendWith(s)
    const result = await landed(s, withToken(T[4]))
    check('S8 unmodified route: confirm sends the token and DSH injects the skill', result.turn?.users[0]?.text === withToken(T[4]) && result.turn?.injections.length === 1, JSON.stringify(result.turn?.users[0]?.text))
  })

  // A save that fails: the dialog stays open with the error, the user's answer is kept, nothing is sent, and a retry sends it.
  await section('S8-save-fails', s, async () => {
    s.t.expecting = true
    await s.page.route(pattern, (route) => (route.request().method() === 'POST'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'internal', message: 'disk full (injected)' }) })
      : route.continue()))
    await ask(s, T[5])
    const dlg = dialog(s)
    const before = turnsOf(readEvents(s.sessionId)).length
    await skillBox(s).uncheck()
    await dlg.getByRole('button', { name: SEND }).click()
    await s.page.waitForTimeout(1_500)
    check('S8 a failing save keeps the dialog open with an alert, and the answer the user gave (unticked) is still there', (await dlg.isVisible()) && (await dlg.getByRole('alert').count()) === 1 && !(await skillBox(s).isChecked()), await dlg.getByRole('alert').allInnerTexts())
    check('S8 a failing save sends nothing and remembers nothing new (still "on" from the last confirm)', turnsOf(readEvents(s.sessionId)).length === before && (await memory(s)) === 'on', await memory(s))
    await shot(s, 'S8-save-failed')
    await s.page.unroute(pattern)
    s.t.expecting = false
    await skillBox(s).check()
    await sendWith(s)
    const result = await landed(s, withToken(T[5]))
    check('S8 after the retry the message goes out with the token and the skill is injected', result.turn?.users[0]?.text === withToken(T[5]) && result.turn?.injections.length === 1, JSON.stringify(result.turn?.users[0]?.text))
  })
  await s.context.close()
}

// ------------------------------------------------------------------------------------------------ X: a message sent while a turn runs

async function queued() {
  const s = await newPage('X-queue')
  await open(s)
  const FIRST = 'Run the shell command: sleep 15 ; then reply with exactly the word: slept'
  await section('X-queue', s, async () => {
    await ask(s, FIRST)
    check('X-queue the first dialog has the box CHECKED and ENABLED (the switch is off and no longer gates it)', await skillBox(s).isChecked() && !(await skillBox(s).isDisabled()))
    await sendWith(s)
    await s.page.getByRole('button', { name: 'Stop generating' }).waitFor({ state: 'visible', timeout: 20_000 })
    await s.page.waitForTimeout(2_500)
    await ask(s, T[12])
    check('X-queue the dialog also opens while a turn is running (the box is still CHECKED and ENABLED)', await skillBox(s).isChecked() && !(await skillBox(s).isDisabled()))
    await dialog(s).getByRole('switch').click()
    const worker = await pickWorker(s)
    check('X-queue the model is picked on the queued dialog too', worker !== undefined, await modelShown(s))
    await sendWith(s)
    // Both messages are found BY THEIR TEXT, never by a turn index: the running turn and the queued one are attributed
    // by what the log really holds, whichever order they land in (a turn count put the wrong turn's evidence on a check).
    const first = await landed(s, withToken(FIRST), 120_000)
    check('X-queue the first message went out as typed with the token, and DSH injected the skill in ITS turn', first.turn?.users[0]?.text === withToken(FIRST) && first.turn?.injections.length === 1, JSON.stringify(first.turn?.users[0]?.text))
    const second = await landed(s, withToken(T[12]), 120_000)
    check('X-queue the message sent during the run carries the token, and DSH injects the skill when its turn starts', second.turn?.users[0]?.text === withToken(T[12]) && second.turn?.injections.length === 1, JSON.stringify(second.turn?.users[0]?.text))
  })
  await s.context.close()
}

// ------------------------------------------------------------------------------------------------ the capability strip and the effort select

/** The dialog raised on a page whose model catalog the fixture answers, with the switch ON and a model picked. */
async function dialogWithModel(s) {
  await ask(s, T[0])
  await dialog(s).getByRole('switch').click()
  // The picker is progressive disclosure: wait for it to mount, so the first pick is never read as "not offered".
  for (let waited = 0; waited < 5_000 && await modelSelect(s) === undefined && await dialog(s).locator('button[aria-haspopup]').count() === 0; waited += 200) await s.page.waitForTimeout(200)
  return dialog(s)
}

/**
 * `page.route` on the browser-side model catalog: the fixture makes every icon's mark known, so the strip is asserted
 * per model instead of "something appeared". The score badge is only ever matched loosely (its label is localized).
 */
async function facts() {
  const s = await newPage('F-facts')
  await s.page.route(MODELS_ROUTE, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIXTURE_CATALOG) }))
  await open(s)

  await section('F1', s, async () => {
    await dialogWithModel(s)
    const evidence = await effortSectionEvidence(s)
    const effort = await effortSelect(s)
    check('F1 the effort control is a plain native <select>, and NO Show/Hide button, heading or paragraph surrounds it', (await dialog(s).locator('select').count()) >= 1 && evidence.showHide.length === 0 && evidence.headings.length === 0 && evidence.paragraphs.length === 0, JSON.stringify(evidence))
    check('F1 with no model picked yet, the select shows its NEUTRAL first option', effort !== undefined && effort.selected === 0 && levelOf(filledOptions(effort)[0] ?? '') === undefined, JSON.stringify({ selected: effort?.selected, options: effort?.options }))
    const anchor = effort === undefined ? null : await effortAnchor(s, effort.index)
    check('F1 with the switch on but no model picked, the effort select is still ON SCREEN, directly under the model picker', effort !== undefined && effort.visible && anchor !== null && anchor.anchor !== null, JSON.stringify(anchor))
    advise('F1 the select is enabled as soon as the effective model has a ladder (a neutral-only select only means "no model yet")', effort !== undefined && !(await effort.handle.isDisabled()), `disabled=${String(effort === undefined ? 'no select' : await effort.handle.isDisabled())}`)
  })

  const worker = await pickWorker(s)
  if (worker === undefined) {
    skip('F2/F3 the home\'s own subagent model', `this home offers none of ${WORKER_CANDIDATES.map((candidate) => candidate.label).join(' / ')}`)
  } else {
    shapes.F_worker = { label: worker.label, id: worker.id }
  }
  const exercised = []
  const seen = []
  for (const base of STRIP_CASES) {
    // The worker case is the route this home really carries; if that route is one of the named cases too, the two
    // simply assert the same fixture twice (the pair is then excluded from the "ladder follows the model" comparison).
    const scenario = base.picker === undefined
      ? { ...base, ...(STRIP_FACTS[worker?.id ?? ''] ?? {}), picker: worker?.name, id: worker?.id, label: worker === undefined ? base.label : `${base.label} (${worker.label})` }
      : base
    await section(`F2-${slug(scenario.label)}`, s, async () => {
      // Every case picks a model in the SAME open dialog: that is what makes "it changed with the model" observable.
      if (scenario.picker === undefined) return
      if ((await dialog(s).count()) === 0) await dialogWithModel(s)
      const picked = await pickModel(s, scenario.picker)
      if (!picked) {
        skip(`F2/F3 ${scenario.label}`, `this home's model catalog does not offer a model matching ${String(scenario.picker)}`)
        return
      }
      exercised.push(scenario)
      const effort = await effortSelect(s)
      check(`F2 ${scenario.label}: AUTO-MAX — the fresh pick sets the effort to the LAST option (the model's highest level), never the neutral one`, effort !== undefined && effort.selected > 0 && effort.selected === filledOptions(effort).length - 1, JSON.stringify({ selected: effort?.selected, options: effort?.options }))
      check(`F2 ${scenario.label}: the other options are the ladder's own levels, rendered low to high`, effort !== undefined && filledOptions(effort).slice(1).every((text) => levelOf(text) !== undefined) && filledOptions(effort).slice(1).map((text) => LEVELS.indexOf(levelOf(text) ?? '')).every((rank, index, ranks) => index === 0 || rank > ranks[index - 1]), JSON.stringify(effort?.options))
      const ladders = declaredLadders(scenario.id)
      if (ladders.length === 0) {
        skip(`F2 ${scenario.label}: the ladder size against the home's settings`, `no reasoningEfforts declared for ${scenario.id} in ${String(process.env.DSH_HOME)}/settings.yaml`)
      } else {
        const wanted = ladders.map((levels) => levels.length + 1)
        const matched = wanted.includes(filledOptions(effort).length)
        check(`F2 ${scenario.label}: the select offers EXACTLY the declared ladder plus ONE neutral option (${wanted.join(' or ')} options, the home's own settings being the witness) and the first is not a level`, effort !== undefined && matched && levelOf(filledOptions(effort)[0] ?? '') === undefined, `${String(filledOptions(effort).length)} options (${JSON.stringify(filledOptions(effort))}) vs declared ${ladders.map((levels) => levels.join(',')).join(' / ')}`)
        seen.push({ label: scenario.label, id: scenario.id, options: filledOptions(effort) })
      }
      const anchor = effort === undefined ? null : await effortAnchor(s, effort.index)
      check(`F2 ${scenario.label}: the select sits immediately below the model select`, anchor !== null && anchor.anchor !== null && (anchor.anchor.haspopup !== null || anchor.anchor.models === true || /model|modelo|模型/i.test(anchor.anchor.name)) && anchor.gap !== null && anchor.gap <= 200, JSON.stringify(anchor))

      const strip = await stripWhenReady(s)
      const judgement = marksMatch(strip.items, scenario)
      check(`F3 ${scenario.label}: the four modality icons are there (audio, photo, text, video), marked per the model's modalities`, strip.items.length === 4 && judgement.ok, `${String(strip.items.length)} icons: ${stripSignals(strip.items)} :: ${judgement.why}`)
      check(`F3 ${scenario.label}: the score badge names its benchmark (loosely: Terminal-Bench 4 / Intelligence)`, strip.badge.some((text) => SCORE_LABEL.test(text)), JSON.stringify(strip.badge))
      advise(`F3 ${scenario.label}: the badge carries the fixture's own number (${scenario.score}) when it reports an index`, !strip.badge.some((text) => /intelligence|inteligência|智能/i.test(text)) || strip.badge.some((text) => text.includes(scenario.score)), JSON.stringify(strip.badge))
      shapes[`F3_${slug(scenario.label)}`] = { fixture: scenario.asset, items: strip.items.map((item) => ({ modality: item.modality, name: item.name, opacity: item.opacity, attributes: item.attributes, classes: item.classes, html: item.html })), badge: strip.badge }
      await shot(s, `F3-${slug(scenario.label)}`)
    })
  }
  check('F3 this home\'s catalog offered at least one model the fixture knows (the strip is really asserted)', exercised.length > 0, JSON.stringify(exercised.map((scenario) => scenario.label)))
  check('F3 at least one exercised model has modalities OFF, so the dimmed state was asserted and not just "four icons are there"', exercised.some((scenario) => scenario.off.length > 0), JSON.stringify(exercised.map((scenario) => ({ model: scenario.label, off: scenario.off }))))
  // Only a pair whose DECLARED ladders differ can witness "the ladder follows the model": two models whose settings
  // declare the same levels are expected to draw the same options, so demanding a difference there is a check that can
  // never pass (this home's DeepSeek and MiMo declare off..max alike; found by the 0.8.2 verifier).
  const declared = new Map(seen.map((item) => [item.id, declaredLadders(item.id).map((levels) => levels.join(',')).join(' / ')]))
  const pairs = seen.flatMap((item, index) => seen.slice(index + 1)
    .filter((other) => other.id !== item.id && (declared.get(item.id) ?? '') !== (declared.get(other.id) ?? ''))
    .map((other) => [item, other]))
  check('F2 the ladder follows the MODEL: two models whose DECLARED ladders differ do not show the same option set', pairs.length === 0 || pairs.some(([left, right]) => left.options.join('|') !== right.options.join('|')), JSON.stringify({ compared: seen.map((item) => ({ model: item.id, declared: declared.get(item.id), options: item.options })), differingPairs: pairs.length }))

  // ---- F5 (0.8.3): the score badge ACROSS THE EFFORT LADDER. Neither source of the headline varies with the effort for
  // the models of this home: the intercepted catalog carries ONE intelligence index per model (OpenRouter has no
  // per-effort intelligence at all) and the committed Terminal-Bench 4 snapshot keeps one row per model (GLM-5.3 =
  // 41.82), so the documented rule — "the value at the model's MAX when the effort has none of its own" — makes the badge
  // CONSTANT over the whole ladder, the neutral first option included. One arm per KIND of headline witnesses that; a
  // value that really MOVES needs a multi-effort snapshot model this home's picker does not offer, and is a SKIP (the
  // data layer's unit tests cover it with the real rows).
  await section('F5', s, async () => {
    skip('F5 the badge VALUE moving with the effort (low vs max)', 'every model of this home resolves to one number: GLM-5.3 has a single Terminal-Bench 4 row (41.82) and every Intelligence model one scalar; the only multi-effort rows (GPT-6 Astra: low 50.61 / medium 54.24 / max 58.18) belong to a model this home\'s picker does not offer — the data layer\'s unit tests cover that case with the real rows')
    const cases = exercised.filter((scenario) => scenario.picker !== undefined && BADGE_FACTS[scenario.asset ?? ''] !== undefined)
    if (cases.length === 0) {
      skip('F5 the badge across the effort ladder', 'no exercised model resolves to a fixture asset whose badge value is known')
      return
    }
    // One arm per KIND of headline (a Terminal-Bench 4 badge and an Intelligence badge): the first case of each kind.
    const arms = cases.filter((scenario, index) => cases.findIndex((other) => BADGE_FACTS[other.asset].kind === BADGE_FACTS[scenario.asset].kind) === index)
    if ((await dialog(s).count()) === 0) await dialogWithModel(s)
    for (const scenario of arms) {
      if (!(await pickModel(s, scenario.picker))) continue
      const wanted = BADGE_FACTS[scenario.asset]
      const options = filledOptions(await effortSelect(s))
      if (options.length < 2) {
        skip(`F5 ${scenario.label}: the badge across the effort ladder`, `this home's ladder for ${String(scenario.id)} offers fewer than two options (${JSON.stringify(options)})`)
        continue
      }
      const top = options.length - 1
      await (await effortSelect(s)).handle.selectOption({ index: top })
      const strip = await stripWhenReady(s)
      if (!strip.badge.some((text) => SCORE_LABEL.test(text))) {
        skip(`F5 ${scenario.label}: the badge across the effort ladder`, 'this fixture model shows no score badge at all')
        continue
      }
      const atTop = strip.badge
      const kind = wanted.kind === 'terminal-bench' ? 'Terminal-Bench 4' : 'Intelligence'
      check(`F5 ${scenario.label}: at the model's highest level the badge is well-formed (it names its benchmark) and shows ${String(wanted.value)} from its ${kind} headline`, atTop.some((text) => wanted.label.test(text)) && badgeHas(atTop, wanted.value), JSON.stringify({ ladder: options, badge: atTop, why: wanted.why }))
      // Every OTHER option, the neutral first one included, one by one: the badge must still be there, still name its
      // benchmark and still show the SAME number. That equality with the value at max IS the documented fallback, so a
      // badge that dropped the strip or resolved to any other number fails here.
      const walked = []
      for (const index of options.map((_, at) => at).filter((at) => at !== top)) {
        await (await effortSelect(s)).handle.selectOption({ index })
        const here = await badgeWhen(s, (badge) => badgeHas(badge, wanted.value))
        walked.push({ option: options[index], badge: here, named: here.some((text) => wanted.label.test(text)), same: badgeHas(here, wanted.value) })
      }
      check(`F5 ${scenario.label}: the badge keeps the SAME value ${String(wanted.value)} and its benchmark's name at EVERY other option of the ladder, the neutral first option (${JSON.stringify(options[0])}) included — ${walked.map((item) => `${item.option}=${item.badge.join('/')}`).join(' | ')}`, walked.every((item) => item.same && item.named), JSON.stringify(walked))
      console.log(`DEBUG F5 ${scenario.label}: badge at ${JSON.stringify(options[top])} ${JSON.stringify(atTop)} / at the neutral option ${JSON.stringify(options[0])} ${JSON.stringify(walked[0]?.badge ?? [])}`)
      await (await effortSelect(s)).handle.selectOption({ index: top })
      const back = await badgeWhen(s, (badge) => badgeHas(badge, wanted.value))
      check(`F5 ${scenario.label}: back at the highest level the badge shows ${String(wanted.value)} again`, badgeHas(back, wanted.value), JSON.stringify({ atTop, back }))
      const after = await stripOf(s)
      check(`F5 ${scenario.label}: the four modality icons are untouched by the whole effort round trip (highest -> every option -> highest)`, after.items.length === 4, JSON.stringify({ icons: after.items.length, items: stripSignals(after.items) }))
      shapes[`F5_${slug(scenario.label)}`] = { fixture: scenario.asset, expects: { ...wanted, label: String(wanted.label) }, options, atTop, walked, back }
      await shot(s, `F5-${slug(scenario.label)}`)
    }
  })

  if (await dialog(s).count() > 0) {
    await s.page.keyboard.press('Escape')
    await dialog(s).waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => undefined)
    // 0.8.3: Escape here cancels the ask; nothing goes out (the 0.6.0 check asserted the opposite and waited a minute).
    const gone = await absent(s, T[0], 2_000)
    check('F the cancel that closes the facts dialog sent NOTHING and left the draft in the composer', gone.ok && (await composerText(s)) === T[0], `log: ${gone.detail}; composer=${JSON.stringify(await composerText(s))}`)
  }
  await s.context.close()

  // The live pass: no interception at all, so whatever the real catalog answers is REPORTED, never asserted.
  const live = await newPage('F-live')
  live.t.expecting = true // a network failure on this page must not be counted against the plugin (S9)
  await open(live)
  await section('F4', live, async () => {
    await dialogWithModel(live)
    const picked = (await pickWorker(live)) !== undefined
    const strip = await stripWhenReady(live)
    advise('F4 live catalog (no interception): the strip rendered what the live /models answered for DeepSeek V4.1 Flash', picked && strip.items.length === 4, `${String(strip.items.length)} icons: ${stripSignals(strip.items)} :: badge ${JSON.stringify(strip.badge)}`)
    advise('F4 live catalog: the score badge was there and named its benchmark', strip.badge.some((text) => SCORE_LABEL.test(text)), JSON.stringify(strip.badge))
    // The live half, REPORTED here and never asserted: this page reads the real catalog, where the intelligence index is
    // ONE scalar per model, so the badge is expected to show the same number at every level (the documented fallback).
    // F5 asserts that value and its constancy against the fixture's own number; here it is only printed.
    const liveSelect = await effortSelect(live)
    if (liveSelect !== undefined && liveSelect.options.length > 2) {
      await liveSelect.handle.selectOption({ index: 1 })
      await live.page.waitForTimeout(800)
      const moved = (await stripOf(live)).badge
      advise('F4 live catalog: the badge at the ladder\'s lowest level (reported, never asserted: one scalar per model means the number is expected NOT to move)', moved.length > 0, `${JSON.stringify(strip.badge)} -> at ${JSON.stringify(liveSelect.options[1])} ${JSON.stringify(moved)}`)
      await liveSelect.handle.selectOption({ index: liveSelect.options.length - 1 })
      await live.page.waitForTimeout(400)
    } else {
      console.log(`DEBUG F4 live catalog: no level to move the effort select to (options: ${JSON.stringify(liveSelect?.options)})`)
    }
    shapes.F4_live = { picked, items: strip.items.map((item) => ({ modality: item.modality, name: item.name, opacity: item.opacity })), badge: strip.badge }
    await shot(live, 'F4-live')
    await live.page.keyboard.press('Escape')
    await dialog(live).waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => undefined)
  })
  live.t.expecting = false
  await live.context.close()
}

// ------------------------------------------------------------------------------------------------ run

const failuresOf = (tracker) => ({
  uncaught: tracker.uncaught,
  // The shell asks for a file-manager icon the Linux build does not ship: not this plugin's request.
  // The capability strip reads the public openrouter.ai catalog from the page; a hiccup of that CDN is foreign too
  // (the strip degrades to "nothing known"), so a console line that names it is not this plugin's failure either.
  consoleErrors: tracker.consoleErrors.filter((entry) => !entry.expected && !entry.text.includes('openrouter.ai') && !(tracker.failed.length > 0 && tracker.failed.every((item) => item.path.startsWith('/open-in-app/icon/') || item.expected) && entry.text.startsWith('Failed to load resource'))),
  failedOrq: tracker.failed.filter((item) => item.path.includes('/dsh-orquestrator/') && !item.expected),
})

let crashed
try {
  if (steps.has('conversation')) await conversation()
  if (steps.has('facts')) await facts()
  if (steps.has('child')) await child()
  if (steps.has('themes')) await themes()
  if (steps.has('wire')) await wire()
  if (steps.has('queue')) await queued()
} catch (error) {
  crashed = scrub(error?.stack ?? error)
  check('the run reached its end without an unhandled exception', false, crashed.split('\n')[0])
}

const collected = trackers.map((tracker) => ({ label: tracker.label, ...failuresOf(tracker) }))
const uncaught = collected.flatMap((item) => item.uncaught.map((text) => `${item.label}: ${text}`))
const consoleErrors = collected.flatMap((item) => item.consoleErrors.map((entry) => `${item.label}: ${entry.text}`))
const failedOrq = collected.flatMap((item) => item.failedOrq.map((entry) => `${item.label}: ${entry.method} ${entry.path} -> ${String(entry.status)}`))
check('S9 no uncaught page errors in any step', uncaught.length === 0, uncaught.join(' | '))
check('S9 no console errors in any step (the known foreign /open-in-app/icon/ 404s, the injected HTTP 500s and the aborted subagent prompts excluded)', consoleErrors.length === 0, consoleErrors.join(' | '))
check('S9 no failed /dsh-orquestrator/ responses in any step (the deliberately injected HTTP 500s excluded)', failedOrq.length === 0, failedOrq.join(' | '))

writeFileSync(join(out, `${phase}.report.json`), JSON.stringify({
  phase,
  steps: [...steps],
  checks,
  advice,
  skipped,
  eventShapes: shapes,
  trackers: trackers.map((tracker) => ({
    label: tracker.label,
    uncaught: tracker.uncaught,
    consoleErrors: tracker.consoleErrors,
    failedResponses: tracker.failed,
    wire: tracker.wire.map((entry) => ({ method: entry.method, status: entry.status, skill: entry.skill, config: entry.config === null ? null : (entry.config === undefined ? undefined : 'set'), body: entry.body === null ? null : String(entry.body).slice(0, 300) })),
  })),
  crashed,
}, null, 2))
const failed = checks.filter((item) => !item.ok)
console.log(`\n${phase}: ${String(checks.length - failed.length)}/${String(checks.length)} checks passed; pages=${String(trackers.length)}; uncaught=${String(uncaught.length)}; failed /dsh-orquestrator/=${String(failedOrq.length)}`)
console.log(`advice (not counted): ${String(advice.filter((item) => item.ok).length)}/${String(advice.length)} ok; skipped: ${String(skipped.length)}`)
if (shapes.S2_userMessage !== undefined) console.log(`SHAPE S2 user/message: ${shapes.S2_userMessage}`)
if (shapes.S3_userMessage !== undefined) console.log(`SHAPE S3 user/message: ${shapes.S3_userMessage}`)
if (shapes.S3_injectedMessage !== undefined) console.log(`SHAPE S3 injected   : ${shapes.S3_injectedMessage}`)
await browser.close()
process.exit(failed.length === 0 ? 0 : 1)
