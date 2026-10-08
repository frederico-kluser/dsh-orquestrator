#!/usr/bin/env node
/**
 * Browser end-to-end checks of the dsh-orquestrator modal against a REAL DSH
 * web server (run on the validation machine with an isolated DSH_HOME).
 *
 *   DSH_URL=<authenticated dsh web URL> OUT_DIR=<dir> PHASE=<name> node ui-e2e.mjs
 *   PHASE=<name> scripts/e2e/with-server.sh node scripts/e2e/ui-e2e.mjs    starts that isolated server (and DSH_URL) for you
 *
 * PHASE:
 *   cancel    a new task raises the modal (one switch, no "do not ask again"); Escape/Cancel sends it as stock DSH
 *   small     a short laptop screen with the model and the effort block open: the actions stay reachable
 *   light     light theme, keyboard focus trap, Esc handling while a menu is open
 *   command   /orquestrar opens the configure dialog, Save persists, and the next send asks again (pre-filled)
 *   effort    reasoning-effort block (recommended levels, explicit pick) and the model notes; no model run needed
 *   confirm   choose the subagent model, send, and read the child back from the DSH session logs (needs ORQ_SESSIONS_DIR)
 *   readme    README screenshots: a realistic task, the dialog empty and then with a model chosen. The browser is closed
 *             without answering the dialog, so the task is never sent to a model (`readme` is dark, `readme-light` light)
 *   workflow  the choice made in the dialog (stored through the route, not a `defaults` config) governs the agents
 *             of a `workflow` the main agent starts; needs ORQ_SESSIONS_DIR (the DSH home's sessions directory of
 *             this server's workspace, which is the LAST workspace any DSH registered in that home, not the directory the
 *             server was started in) so the children's route, effort and token cap are read back from the logs
 *
 * Models: ONLY the three target models are ever picked or run. The main agent is the DSH home's
 * default model (GLM 5.3); the dialog picks DeepSeek V4.1 Flash for subagents (the `TRIO` patterns below). The
 * phases that need no model run only click through the dialog.
 *
 * Writes <OUT_DIR>/<phase>.report.json (one entry per check) and screenshots.
 * The token in DSH_URL is a per-process credential: it is never written out.
 */
import { chromium } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const url = process.env.DSH_URL
const out = process.env.OUT_DIR ?? '.'
const phase = process.env.PHASE ?? 'cancel'
if (url === undefined) throw new Error('DSH_URL is required')
mkdirSync(out, { recursive: true })

const COMPOSER = /Describe what you want to build/
/** The three target models, as the dialog's catalog names them and as the wire carries them. */
const TRIO = {
  worker: /DeepSeek V4\.1 Flash \(Azure\)/,
  workerId: 'DeepSeek-V4.1-Flash',
  mimo: /MiMo-V2\.6-Pro/i,
  glm: /GLM 5\.3/,
}
const DIALOG = 'Orchestrate subagents'
const checks = []
const wire = []

const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 400) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  [${String(detail).slice(0, 200)}]`}`)
}

// CHROME_PATH points at a Chrome/Chromium binary when there is no system Chrome (the default `channel: 'chrome'`).
const chromePath = process.env.CHROME_PATH
const browser = await chromium.launch(chromePath === undefined ? { channel: 'chrome', headless: true } : { executablePath: chromePath, headless: true, args: ['--no-sandbox'] })
const scheme = phase === 'light' || phase === 'readme-light' ? 'light' : 'dark'
const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: scheme })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 300)))
page.on('console', (message) => { if (message.type() === 'error') pageErrors.push(`console: ${message.text().slice(0, 200)}`) })
const failedUrls = []
// The shell asks for a file-manager icon the Linux build does not ship; it is not this plugin's request.
const relevantErrors = () => {
  const foreign = failedUrls.length > 0 && failedUrls.every((entry) => entry.includes(' /open-in-app/icon/'))
  return pageErrors.filter((error) => !(foreign && error.startsWith('console: Failed to load resource')))
}
page.on('response', (response) => {
  // Name the URL behind a console "Failed to load resource": the token never reaches the report.
  if (response.status() >= 400) failedUrls.push(`${String(response.status())} ${new URL(response.url()).pathname}`)
})
page.on('request', (request) => {
  if (!request.url().includes('/dsh-orquestrator/config')) return
  wire.push({ method: request.method(), path: new URL(request.url()).pathname, query: new URL(request.url()).search, body: request.postData() ?? null })
})
page.on('response', (response) => {
  if (!response.url().includes('/dsh-orquestrator/config')) return
  const entry = [...wire].reverse().find((item) => item.status === undefined)
  if (entry !== undefined) entry.status = response.status()
})

const shot = async (name) => { await page.screenshot({ path: `${out}/${phase}-${name}.png` }) }
const composer = () => page.getByRole('textbox', { name: COMPOSER })
const dialog = () => page.getByRole('dialog', { name: DIALOG })

async function open() {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await composer().waitFor({ state: 'visible', timeout: 30_000 })
}

async function newSession() {
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  await composer().waitFor({ state: 'visible', timeout: 15_000 })
}

async function typeTask(text) {
  await composer().click()
  await page.keyboard.type(text, { delay: 5 })
}

async function finish() {
  writeFileSync(`${out}/${phase}.report.json`, JSON.stringify({ phase, checks, wire, pageErrors, failedResponses: failedUrls }, null, 2))
  const failed = checks.filter((item) => !item.ok)
  console.log(`\n${phase}: ${String(checks.length - failed.length)}/${String(checks.length)} checks passed; wire=${String(wire.length)} requests; pageErrors=${String(pageErrors.length)}`)
  await browser.close()
  process.exit(failed.length === 0 ? 0 : 1)
}

const TASK_CANCEL = 'Reply with exactly the word: stock'

if (phase === 'cancel') {
  await open()
  await shot('01-home')
  await typeTask(TASK_CANCEL)
  await page.keyboard.press('Enter')

  const visible = await dialog().waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false)
  check('modal appears when a new task is sent from the composer', visible)
  await shot('02-modal')
  if (visible) {
    check('title and gate description shown', await dialog().getByText('Cancel sends the task as usual.').isVisible())
    check('task preview shows what is being sent', await dialog().getByText(TASK_CANCEL).isVisible())
    const switches = dialog().getByRole('switch')
    check('one switch (the subagent model); there is no reviewer', (await switches.count()) === 1 && (await dialog().getByText(/reviewer/i).count()) === 0, await switches.count())
    check('the switch starts off', (await switches.nth(0).getAttribute('aria-checked')) === 'false')
    // 0.8.0: the one checkbox is the orchestration skill (checked by default); nothing offers to stop asking.
    const boxes = dialog().getByRole('checkbox')
    check('there is no "do not ask again" checkbox: the modal always asks', (await dialog().getByRole('checkbox', { name: /ask again|remember|do not ask/i }).count()) === 0 && (await boxes.count()) <= 1, await boxes.count())
    check('primary action is focused', await dialog().getByRole('button', { name: 'Send with these options' }).evaluate((element) => element === document.activeElement))

    await page.keyboard.press('Escape')
    await dialog().waitFor({ state: 'hidden', timeout: 8_000 }).then(() => check('Escape closes the modal', true), () => check('Escape closes the modal', false))
  }
  // The task must have been sent anyway (stock behavior): the user message shows in the transcript.
  const sent = await page.getByText(TASK_CANCEL).first().isVisible().catch(() => false)
  await page.waitForTimeout(2500)
  check('after Cancel/Escape the task is sent as stock DSH', sent || (await page.getByText(TASK_CANCEL).count()) > 0)
  await shot('03-after-cancel')
  const config = wire.filter((item) => item.method === 'POST')
  check('cancel wrote null (no orchestration stored)', config.length >= 1 && config.every((item) => JSON.parse(item.body ?? '{}').config === null), JSON.stringify(config.map((item) => ({ s: item.status, b: item.body?.slice(0, 80) }))))
  check('no page errors', relevantErrors().length === 0, relevantErrors().join(' | '))
  await finish()
}


/** Open a picker (by the text of its trigger), then choose the entry whose text matches. */
async function pick(triggerText, entryPattern) {
  await dialog().getByRole('button', { name: triggerText }).first().click()
  const entry = page.getByRole('menuitem', { name: entryPattern }).or(page.getByRole('option', { name: entryPattern })).or(page.locator('[role=menu]').getByText(entryPattern)).first()
  await entry.waitFor({ state: 'visible', timeout: 8_000 })
  await entry.click()
}

const TASK_WORKFLOW = `Use the workflow tool exactly once, with exactly this meta and exactly this script, and change nothing in them.

meta: {"name":"echo-two","description":"Ask two agents for one word each","phases":[{"title":"Ask"}]}

script:
const words = await parallel([
  () => agent('Reply with exactly the single word ALPHA and nothing else.', { label: 'alpha', phase: 'Ask' }),
  () => agent('Reply with exactly the single word BETA and nothing else.', { label: 'beta', phase: 'Ask' }),
])
return words

When the workflow tool returns, reply with its result verbatim and nothing else.`

/** Subagent children created at or after `since`, read back from the DSH session logs: route, effort, token cap and last stop. */
function childrenSince(sessionsDir, since) {
  const rows = []
  for (const id of readdirSync(sessionsDir)) {
    if (id.startsWith('session-')) continue
    try {
      const events = execFileSync('zstd', ['-dc', join(sessionsDir, id, 'session.v3.jsonl.zstd')], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      const header = events[0] ?? {}
      if (header.origin !== 'subagent' || !(header.createdAt >= since)) continue
      const config = events.find((event) => event.type === 'request/header')?.data?.header?.config ?? {}
      const end = events.findLast((event) => event.type === 'turn/end')
      rows.push({ id: id.slice(0, 8), route: `${config.provider ?? '?'}/${config.model ?? '?'}`, effort: config.reasoningEffort, maxTokens: config.maxTokens, ended: end?.data?.reason?.kind })
    } catch { /* a session still being written: read it on the next poll */ }
  }
  return rows
}

if (phase === 'workflow') {
  const sessionsDir = process.env.ORQ_SESSIONS_DIR
  if (sessionsDir === undefined) throw new Error('ORQ_SESSIONS_DIR is required for the workflow phase')
  const since = Date.now()
  await open()
  await newSession() // the gate asks for a NEW task: an earlier conversation on this server would be a follow-up
  // The task has line breaks: typing them would press Enter and send its first line alone, so the text is filled in whole.
  await composer().click()
  await composer().fill(TASK_WORKFLOW)
  await page.keyboard.press('Enter')
  await dialog().waitFor({ state: 'visible', timeout: 15_000 })
  check('modal appears for the workflow task', true)
  const switches = dialog().getByRole('switch')
  await switches.nth(0).click()
  await pick(/Choose a model/, TRIO.worker)
  check('subagent model chosen: DeepSeek V4.1 Flash', await dialog().getByRole('button', { name: TRIO.worker }).first().isVisible())
  check('the dialog says the choice covers the agents a workflow starts', (await dialog().innerText()).replace(/\s+/g, ' ').includes('Applies to every subagent, including the agents a workflow starts.'))
  await shot('01-modal-subagent-model')
  await dialog().getByRole('button', { name: 'Send with these options' }).click()
  await dialog().waitFor({ state: 'hidden', timeout: 8_000 }).then(() => check('modal closes after confirm', true), () => check('modal closes after confirm', false))
  const posts = wire.filter((item) => item.method === 'POST')
  const saved = posts.length > 0 ? JSON.parse(posts.at(-1).body ?? '{}').config : null
  check('POST stored the subagent model (a stored choice, not a `defaults` config), the legacy reviewer block disabled', saved?.subagentModel?.model === TRIO.workerId && saved?.reviewer?.enabled === false, JSON.stringify(saved))

  // The main agent now calls the workflow tool; its two agents appear as child sessions in the DSH logs.
  let rows = []
  for (let waited = 0; waited < 240_000; waited += 3_000) {
    rows = childrenSince(sessionsDir, since)
    if (rows.length >= 2 && rows.every((row) => row.ended !== undefined)) break
    await page.waitForTimeout(3_000)
  }
  console.log('DEBUG children read back from the session logs:', JSON.stringify(rows))
  await shot('02-after-workflow')
  check('the workflow started two agents', rows.length === 2, rows.length)
  check('both ran on DeepSeek V4.1 Flash, not on the main agent\'s model', rows.length > 0 && rows.every((row) => row.route === `azure-opencode/${TRIO.workerId}`), JSON.stringify(rows.map((row) => row.route)))
  check('both at the recommended effort (medium) with the 64 000-token cap', rows.length > 0 && rows.every((row) => row.effort === 'medium' && row.maxTokens === 64000), JSON.stringify(rows.map((row) => [row.effort, row.maxTokens])))
  check('both finished', rows.length > 0 && rows.every((row) => row.ended === 'completed'), JSON.stringify(rows.map((row) => row.ended)))
  check('no page errors', relevantErrors().length === 0, relevantErrors().join(' | '))
  await finish()
}

const TASK_CONFIRM = 'Use the subagent tool exactly once, with run_in_background set to false, to answer this question: "What is 17 plus 25?" When the subagent tool returns, reply with its result verbatim and nothing else.'

if (phase === 'confirm') {
  const sessionsDir = process.env.ORQ_SESSIONS_DIR
  if (sessionsDir === undefined) throw new Error('ORQ_SESSIONS_DIR is required for the confirm phase')
  const since = Date.now()
  await open()
  await newSession()
  await typeTask(TASK_CONFIRM)
  await page.keyboard.press('Enter')
  await dialog().waitFor({ state: 'visible', timeout: 15_000 })
  check('modal appears for the delegation task', true)

  const switches = dialog().getByRole('switch')
  await switches.nth(0).click()
  check('the switch reveals the model picker and the scope line', (await dialog().getByText('Model for subagents').isVisible()) && (await dialog().getByText('including the agents a workflow starts').isVisible()))
  check('confirm is disabled until a subagent model is chosen', await dialog().getByRole('button', { name: 'Send with these options' }).isDisabled())
  await pick(/Choose a model/, TRIO.worker)
  check('subagent model chosen', await dialog().getByRole('button', { name: TRIO.worker }).first().isVisible())
  await page.waitForTimeout(400)
  await shot('01-modal-filled')
  check('confirm is enabled', await dialog().getByRole('button', { name: 'Send with these options' }).isEnabled())

  await dialog().getByRole('button', { name: 'Send with these options' }).click()
  await dialog().waitFor({ state: 'hidden', timeout: 8_000 }).then(() => check('modal closes after confirm', true), () => check('modal closes after confirm', false))
  const posts = wire.filter((item) => item.method === 'POST')
  const saved = posts.length > 0 ? JSON.parse(posts.at(-1).body ?? '{}').config : null
  check('POST carried the chosen route, and only the disabled legacy reviewer block besides', saved !== null && saved.subagentModel?.model === TRIO.workerId && saved.workerEffort === null && saved.reviewer?.enabled === false && Object.keys(saved).sort().join() === 'reviewer,subagentModel,version,workerEffort', JSON.stringify(saved))
  check('host accepted the config (200)', posts.at(-1)?.status === 200, posts.at(-1)?.status)
  await shot('02-running')

  // The real thing: the main agent (GLM 5.3) delegates and the subagent runs on DeepSeek V4.1 Flash.
  let rows = []
  for (let waited = 0; waited < 240_000; waited += 3_000) {
    rows = childrenSince(sessionsDir, since)
    if (rows.length >= 1 && rows.every((row) => row.ended !== undefined)) break
    await page.waitForTimeout(3_000)
  }
  console.log('DEBUG children read back from the session logs:', JSON.stringify(rows))
  await page.waitForTimeout(1500)
  await shot('03-delivered')
  check('the main agent started one subagent', rows.length === 1, rows.length)
  check('it ran on DeepSeek V4.1 Flash, not on the main agent\'s model', rows.length === 1 && rows[0].route === `azure-opencode/${TRIO.workerId}`, JSON.stringify(rows.map((row) => row.route)))
  check('at the recommended effort (medium) with the 64 000-token cap', rows.length === 1 && rows[0].effort === 'medium' && rows[0].maxTokens === 64000, JSON.stringify(rows.map((row) => [row.effort, row.maxTokens])))
  check('it finished and the transcript shows its answer (42)', rows.length === 1 && rows[0].ended === 'completed' && /42/.test(await page.locator('body').innerText()))
  check('no page errors', relevantErrors().length === 0, relevantErrors().join(' | '))
  await finish()
}

if (phase === 'light') {
  await open()
  await typeTask('Reply with exactly the word: light')
  await page.keyboard.press('Enter')
  await dialog().waitFor({ state: 'visible', timeout: 15_000 })
  await shot('01-modal-light')
  check('modal renders in the light theme', await dialog().isVisible())

  // Focus stays inside the dialog while tabbing (a modal must trap focus).
  let escaped = 0
  for (let index = 0; index < 14; index += 1) {
    await page.keyboard.press('Tab')
    const inside = await page.evaluate(() => document.activeElement !== null && document.activeElement.closest('[role=dialog]') !== null)
    if (!inside) escaped += 1
  }
  check('Tab never leaves the dialog (focus trap)', escaped === 0, `${String(escaped)} of 14 tabs escaped`)
  console.log('DEBUG dialog visible after tabs:', await dialog().isVisible(), '| text:', (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 160))

  // Escape belongs to an open menu first; the dialog survives and closes on the next Escape.
  const switches = dialog().getByRole('switch')
  await switches.nth(0).click({ timeout: 5000 }).catch((error) => console.log('DEBUG switch click failed:', String(error).slice(0, 200)))
  await page.waitForTimeout(600)
  await shot('01b-after-switch')
  console.log('DEBUG dialog text after switch:', (await dialog().innerText().catch(() => 'no dialog')).replace(/\s+/g, ' ').slice(0, 300))
  await dialog().getByRole('button', { name: /Choose a model/ }).first().click()
  await page.getByRole('menuitem').or(page.getByRole('option')).or(page.locator('[role=menu] *')).first().waitFor({ state: 'visible', timeout: 8_000 })
  await shot('02-menu-open-light')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  check('Escape closes the open menu but keeps the dialog', await dialog().isVisible())
  await page.keyboard.press('Escape')
  await dialog().waitFor({ state: 'hidden', timeout: 8_000 }).then(() => check('a second Escape closes the dialog', true), () => check('a second Escape closes the dialog', false))
  check('no page errors', relevantErrors().length === 0, relevantErrors().join(' | '))
  await finish()
}

if (phase === 'command') {
  await open()
  await newSession()
  await typeTask('/orquestrar')
  await page.waitForTimeout(800)
  await shot('01-palette')
  const listed = await page.getByText('Orchestrate subagents').first().isVisible().catch(() => false)
  check('the /orquestrar command is offered by the slash palette', listed)
  await page.keyboard.press('Enter')
  const opened = await dialog().waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)
  check('the command opens the dialog in configure mode', opened && (await dialog().getByText('The options apply from the next task.').isVisible()))
  await shot('02-configure')
  if (opened) {
    await dialog().getByRole('switch').nth(0).click()
    await pick(/Choose a model/, TRIO.worker)
    await dialog().getByRole('button', { name: 'Save' }).click()
    await dialog().waitFor({ state: 'hidden', timeout: 8_000 }).then(() => check('Save closes the dialog', true), () => check('Save closes the dialog', false))
    const posts = wire.filter((item) => item.method === 'POST')
    const saved = posts.length > 0 ? JSON.parse(posts.at(-1).body ?? '{}').config : null
    check('Save stored the subagent model and no "remember" flag', saved?.subagentModel?.model === TRIO.workerId && !('remember' in saved), JSON.stringify(saved))
    // There is no "do not ask again", so the next task raises the modal again, pre-filled.
    await typeTask('Reply with exactly the word: asks')
    await page.keyboard.press('Enter')
    const asked = await dialog().waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false)
    check('the next task raises the modal again (nothing can silence it)', asked)
    check('the dialog is pre-filled with the saved choice (switch on, DeepSeek V4.1 Flash)', asked && (await dialog().getByRole('switch').nth(0).getAttribute('aria-checked')) === 'true' && (await dialog().getByRole('button', { name: TRIO.worker }).first().isVisible()))
    await shot('03-asks-again')
    await page.keyboard.press('Escape')
  }
  check('no page errors', relevantErrors().length === 0, relevantErrors().join(' | '))
  await finish()
}

if (phase === 'effort') {
  // What "recommended" shows per model, the explicit pick that reaches the wire, and the advice notes.
  // It runs no delegation: it only clicks through the dialog, and only ever with the three target models.
  await open()
  await typeTask('Reply with exactly the word: effort')
  await page.keyboard.press('Enter')
  await dialog().waitFor({ state: 'visible', timeout: 15_000 })
  const text = async () => (await dialog().innerText()).replace(/\s+/g, ' ')
  check('no effort block while the switch is off', !(await text()).includes('Reasoning effort'))

  await dialog().getByRole('switch').nth(0).click()
  check('no effort block until a model is chosen', !(await text()).includes('Reasoning effort'))
  await pick(/Choose a model/, TRIO.worker)
  check('the effort block appears once a model is chosen, collapsed, recommended', (await text()).includes('Reasoning effort') && (await text()).includes('Recommended level for the model'))
  check('the overthinking note is shown for the DeepSeek V4.1 Flash subagent', (await text()).includes('spend its whole token budget on one numeric edge case'))
  await dialog().getByRole('button', { name: 'Show', exact: true }).click()
  check('the effort is Recommended: Medium (the route itself defaults to max)', await dialog().getByRole('button', { name: /Recommended: Medium/ }).first().isVisible())
  await shot('01-deepseek-recommended')

  await pick(TRIO.worker, TRIO.glm)
  check('GLM 5.3 is Recommended: High (its ladder is low, high, max, capped at high)', await dialog().getByRole('button', { name: /Recommended: High/ }).first().isVisible())
  check('GLM 5.3 carries the text-only note', (await text()).includes('Text only: it cannot look at screenshots'))
  await shot('02-glm')

  await pick(TRIO.glm, TRIO.mimo)
  check('MiMo-V2.6-Pro is Recommended: Low, not Max', await dialog().getByRole('button', { name: /Recommended: Low/ }).first().isVisible())
  check('MiMo-V2.6-Pro carries the slow-at-high-effort note', (await text()).includes('about two minutes per turn at high effort'))
  await shot('03-mimo')

  // An explicit level: back on DeepSeek, the subagent at High.
  await pick(TRIO.mimo, TRIO.worker)
  await dialog().getByRole('button', { name: /Recommended: Medium/ }).first().click()
  await page.getByRole('menuitem', { name: /^High$/ }).first().click()
  check('picking a level marks the block as customized', (await text()).includes('Customized'))
  check('the picker now shows High', (await text()).includes('High'))
  await shot('04-explicit-high')

  await dialog().getByRole('button', { name: 'Send with these options' }).click()
  await dialog().waitFor({ state: 'hidden', timeout: 8_000 }).then(() => check('modal closes after confirm', true), () => check('modal closes after confirm', false))
  const posts = wire.filter((item) => item.method === 'POST')
  const saved = posts.length > 0 ? JSON.parse(posts.at(-1).body ?? '{}').config : null
  check('the wire carries the model and the explicit effort, the legacy reviewer block disabled', saved?.workerEffort === 'high' && saved?.subagentModel?.model === TRIO.workerId && saved?.reviewer?.enabled === false, JSON.stringify(saved))
  check('host accepted the config (200)', posts.at(-1)?.status === 200, posts.at(-1)?.status)

  // The dialog opens with the last confirmed choice, effort included.
  await newSession()
  await typeTask('Reply with exactly the word: again')
  await page.keyboard.press('Enter')
  await dialog().waitFor({ state: 'visible', timeout: 15_000 })
  check('the dialog reopens with the last confirmed choice and its explicit effort', (await text()).includes('DeepSeek V4.1 Flash (Azure)') && (await text()).includes('Customized'))
  await shot('05-reopened')
  await page.keyboard.press('Escape')
  check('no page errors', relevantErrors().length === 0, relevantErrors().join(' | '))
  await finish()
}

if (phase === 'readme' || phase === 'readme-light') {
  await open()
  await newSession()
  await typeTask('Add input validation to the signup form and cover it with tests')
  await page.keyboard.press('Enter')
  await dialog().waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForTimeout(400)
  await shot('01-empty')
  check('the dialog is up, with one switch', (await dialog().getByRole('switch').count()) === 1)
  if (phase === 'readme') {
    await dialog().getByRole('switch').nth(0).click()
    await pick(/Choose a model/, TRIO.worker)
    await page.waitForTimeout(400)
    await shot('02-filled')
    check('a model is chosen', await dialog().getByRole('button', { name: TRIO.worker }).first().isVisible())
  }
  // No answer on purpose: closing the browser leaves the dialog unanswered, so the task is never sent.
  await finish()
}

if (phase === 'small') {
  // A short laptop screen with the model chosen and the effort block open: the actions must stay reachable.
  await page.setViewportSize({ width: 1024, height: 600 })
  await open()
  await typeTask('Reply with exactly the word: small')
  await page.keyboard.press('Enter')
  await dialog().waitFor({ state: 'visible', timeout: 15_000 })
  await dialog().getByRole('switch').nth(0).click()
  await pick(/Choose a model/, TRIO.worker)
  await dialog().getByRole('button', { name: 'Show', exact: true }).click()
  await page.waitForTimeout(600)
  await shot('01-open-600px')
  const box = await dialog().boundingBox()
  const send = dialog().getByRole('button', { name: 'Send with these options' })
  const sendBox = await send.boundingBox()
  check('dialog is not taller than the viewport', box !== null && box.height <= 600, JSON.stringify(box))
  check('primary action is inside the viewport', sendBox !== null && sendBox.y >= 0 && sendBox.y + sendBox.height <= 600, JSON.stringify(sendBox))
  await page.keyboard.press('Escape')
  check('no page errors', relevantErrors().length === 0, relevantErrors().join(' | '))
  await finish()
}

console.error(`unknown phase: ${phase}`)
process.exit(2)
