#!/usr/bin/env node
/**
 * Browser end-to-end checks of the dsh-orquestrator modal against a REAL DSH
 * web server (run on the validation machine with an isolated DSH_HOME).
 *
 *   DSH_URL=<authenticated dsh web URL> OUT_DIR=<dir> PHASE=<name> node ui-e2e.mjs
 *
 * PHASE:
 *   cancel    a new task raises the modal; Escape/Cancel sends it as stock DSH
 *   confirm   choose subagent + reviewer models, send, wait for "Reviewed delivery"
 *   light     light theme, keyboard focus trap, Esc handling while a menu is open
 *   command   /orquestrar opens the configure dialog, Save persists, next send skips the modal
 *
 * Writes <OUT_DIR>/<phase>.report.json (one entry per check) and screenshots.
 * The token in DSH_URL is a per-process credential: it is never written out.
 */
import { chromium } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'

const url = process.env.DSH_URL
const out = process.env.OUT_DIR ?? '.'
const phase = process.env.PHASE ?? 'cancel'
if (url === undefined) throw new Error('DSH_URL is required')
mkdirSync(out, { recursive: true })

const COMPOSER = /Describe what you want to build/
const DIALOG = 'Orchestrate subagents'
const checks = []
const wire = []

const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 400) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  [${String(detail).slice(0, 200)}]`}`)
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const scheme = phase === 'light' ? 'light' : 'dark'
const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: scheme })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 300)))
page.on('console', (message) => { if (message.type() === 'error') pageErrors.push(`console: ${message.text().slice(0, 200)}`) })
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
  writeFileSync(`${out}/${phase}.report.json`, JSON.stringify({ phase, checks, wire, pageErrors }, null, 2))
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
    check('two switches (subagent model, reviewer)', (await switches.count()) === 2, await switches.count())
    check('both switches start off', (await switches.nth(0).getAttribute('aria-checked')) === 'false' && (await switches.nth(1).getAttribute('aria-checked')) === 'false')
    check('remember checkbox present and unchecked', (await dialog().getByRole('checkbox').isChecked()) === false)
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
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
  await finish()
}


/** Open a picker (by the text of its trigger), then choose the entry whose text matches. */
async function pick(triggerText, entryPattern) {
  await dialog().getByRole('button', { name: triggerText }).first().click()
  const entry = page.getByRole('menuitem', { name: entryPattern }).or(page.getByRole('option', { name: entryPattern })).or(page.locator('[role=menu]').getByText(entryPattern)).first()
  await entry.waitFor({ state: 'visible', timeout: 8_000 })
  await entry.click()
}

const TASK_CONFIRM = 'Use the subagent tool exactly once to do this work: in the current directory create wordcount.js (CommonJS) exporting wordCount(text) that returns how many words the text has, where a word is a run of non-whitespace characters, hyphenated words count as one, and an empty or whitespace-only string returns 0. Also create wordcount.test.js with node:test cases covering those rules. Run the tests with `node --test`. When the subagent tool returns, reply with its result verbatim and nothing else.'

if (phase === 'confirm') {
  await open()
  await typeTask(TASK_CONFIRM)
  await page.keyboard.press('Enter')
  await dialog().waitFor({ state: 'visible', timeout: 15_000 })
  check('modal appears for the delegation task', true)

  const switches = dialog().getByRole('switch')
  await switches.nth(0).click()
  check('subagent switch on reveals the model picker', await dialog().getByText('Model for subagents').isVisible())
  check('confirm is disabled until a subagent model is chosen', await dialog().getByRole('button', { name: 'Send with these options' }).isDisabled())
  await pick(/Choose a model/, /Gemini 3\.8 Flash/i)
  check('subagent model chosen', await dialog().getByRole('button', { name: /Gemini 3\.8 Flash/i }).first().isVisible())

  await switches.nth(1).click()
  check('reviewer switch reveals the four-step description and its picker', (await dialog().getByText('Fixes only what is actually broken').isVisible()) && (await dialog().getByText('Model for the reviewer').isVisible()))
  check('reviewer defaults to "same as the subagent"', await dialog().getByRole('button', { name: /Same model as the subagent/ }).isVisible())
  await pick(/Same model as the subagent/, /haiku[- ]4[.-]5/i)
  await page.waitForTimeout(400)
  await shot('01-modal-filled')
  check('confirm is enabled', await dialog().getByRole('button', { name: 'Send with these options' }).isEnabled())

  await dialog().getByRole('button', { name: 'Send with these options' }).click()
  await dialog().waitFor({ state: 'hidden', timeout: 8_000 }).then(() => check('modal closes after confirm', true), () => check('modal closes after confirm', false))
  const posts = wire.filter((item) => item.method === 'POST')
  const saved = posts.length > 0 ? JSON.parse(posts.at(-1).body ?? '{}').config : null
  check('POST stored the chosen routes', saved !== null && saved.subagentModel?.model === 'google/gemini-3.8-flash' && saved.reviewer?.enabled === true && /haiku/i.test(saved.reviewer?.model?.model ?? ''), JSON.stringify(saved))
  check('host accepted the config (200)', posts.at(-1)?.status === 200, posts.at(-1)?.status)
  await shot('02-running')

  // The real thing: the main agent delegates, the worker runs on Gemini, the reviewer on Haiku,
  // and the tool result the main agent receives is the reviewer's report.
  const delivered = await page.getByText('Reviewed delivery', { exact: false }).first().waitFor({ state: 'visible', timeout: 20 * 60_000 }).then(() => true, () => false)
  check('the main agent received a "Reviewed delivery" result', delivered)
  await page.waitForTimeout(1500)
  await shot('03-delivered')
  const transcript = await page.locator('body').innerText()
  check('the transcript carries a reviewer verdict', /verdict:\s*(APPROVED|APPROVED_WITH_FIXES|NOT_RESOLVED)/i.test(transcript))
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
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
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
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
    await dialog().getByRole('switch').nth(1).click()
    await dialog().getByRole('checkbox').check()
    await dialog().getByRole('button', { name: 'Save' }).click()
    await dialog().waitFor({ state: 'hidden', timeout: 8_000 }).then(() => check('Save closes the dialog', true), () => check('Save closes the dialog', false))
    const posts = wire.filter((item) => item.method === 'POST')
    const saved = posts.length > 0 ? JSON.parse(posts.at(-1).body ?? '{}').config : null
    check('Save stored reviewer + "do not ask again"', saved?.reviewer?.enabled === true && saved?.remember === true, JSON.stringify(saved))
    // With "do not ask again" on, the next task goes out without a modal.
    await typeTask('Reply with exactly the word: quiet')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(4000)
    check('the next task is sent without a modal', !(await dialog().isVisible().catch(() => false)))
    await shot('03-quiet')
  }
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
  await finish()
}

if (phase === 'small') {
  // A short laptop screen with both sections open: the actions must stay reachable.
  await page.setViewportSize({ width: 1024, height: 600 })
  await open()
  await typeTask('Reply with exactly the word: small')
  await page.keyboard.press('Enter')
  await dialog().waitFor({ state: 'visible', timeout: 15_000 })
  const switches = dialog().getByRole('switch')
  await switches.nth(0).click()
  await switches.nth(1).click()
  await page.waitForTimeout(600)
  await shot('01-both-open-600px')
  const box = await dialog().boundingBox()
  const send = dialog().getByRole('button', { name: 'Send with these options' })
  const sendBox = await send.boundingBox()
  check('dialog is not taller than the viewport', box !== null && box.height <= 600, JSON.stringify(box))
  check('primary action is inside the viewport', sendBox !== null && sendBox.y >= 0 && sendBox.y + sendBox.height <= 600, JSON.stringify(sendBox))
  const scrollable = await dialog().evaluate((el) => { const nodes = [el, ...el.querySelectorAll('*')]; return nodes.some((n) => n.scrollHeight > n.clientHeight + 1 && ['auto', 'scroll'].includes(getComputedStyle(n).overflowY)) })
  console.log('DEBUG scrollable region inside dialog:', scrollable)
  await page.keyboard.press('Escape')
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
  await finish()
}

if (phase === 'debug') {
  await open()
  await typeTask('Reply with exactly the word: debug')
  await page.keyboard.press('Enter')
  await dialog().waitFor({ state: 'visible', timeout: 15_000 })
  await dialog().getByRole('switch').nth(0).click()
  await dialog().getByRole('switch').nth(1).click()
  await page.waitForTimeout(800)
  await dialog().getByRole('button', { name: /Same model as the subagent/ }).first().click()
  await page.waitForTimeout(800)
  await shot('01-debug-after-switch')
  const items = await page.locator('[role=menu] *, [role=menuitem], [role=option], [role=listbox] *').evaluateAll((els) => els.map((el) => `${el.tagName.toLowerCase()}[${el.getAttribute('role') ?? ''}]:${(el.textContent ?? '').trim().slice(0, 50)}`).filter((t, i, a) => a.indexOf(t) === i).slice(0, 60))
  console.log('MENU', JSON.stringify(items))
  console.log((await dialog().innerText()).replace(/\s+/g, ' ').slice(0, 600))
  const buttons = await dialog().getByRole('button').evaluateAll((els) => els.map((el) => `${el.getAttribute('aria-label') ?? ''}|${(el.textContent ?? '').trim().slice(0, 40)}|disabled=${String(el.disabled)}`))
  console.log(JSON.stringify(buttons))
  await browser.close()
  process.exit(0)
}

console.error(`unknown phase: ${phase}`)
process.exit(2)
