#!/usr/bin/env node
/**
 * What each session of a headless run was actually asked to do, read from the
 * DSH session logs (not from the plugin's own logs):
 *
 *   node session-config.mjs <run-name> [root] [--session <main-session-id-prefix>]
 *
 * A headless run is identified by the session id in the first line of its
 * `events.jsonl`; a run driven from the browser has none, so pass `--session`.
 * Sessions of other runs that share the workspace directory are left out.
 *
 * One row per session of the run (the main agent and each subagent child):
 * the route and the reasoning effort / output-token ceiling of its model
 * requests, how long it ran, and how many model requests and tool calls it
 * made. Nothing secret is read.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const sessionFlag = argv.indexOf('--session')
const sessionPrefix = sessionFlag === -1 ? undefined : argv[sessionFlag + 1]
const [name, rootArg] = argv.filter((arg, index) => !arg.startsWith('--') && (sessionFlag === -1 || index !== sessionFlag + 1))
if (name === undefined) {
  console.error('usage: session-config.mjs <run-name> [root] [--session <main-session-id-prefix>]')
  process.exit(2)
}
const root = rootArg ?? '/tmp/orq-validation-local'
const sessionsRoot = join(root, 'home', 'sessions')
const dir = readdirSync(sessionsRoot).map((entry) => join(sessionsRoot, entry)).find((entry) => entry.includes(`-runs-${name}-workspace--`))
if (dir === undefined) {
  console.error(`no sessions found for run ${name} under ${sessionsRoot}`)
  process.exit(1)
}

const read = (id) => execFileSync('zstd', ['-dc', join(dir, id, 'session.v3.jsonl.zstd')], { maxBuffer: 1 << 29 })
  .toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))

// The run's main session: from the headless events file, else the flag, else every session in the directory.
let mainId = sessionPrefix
if (mainId === undefined) {
  try {
    mainId = JSON.parse(readFileSync(join(root, 'runs', name, 'events.jsonl'), 'utf8').split('\n')[0] ?? '{}').sessionId
  } catch {
    mainId = undefined
  }
}

const rows = []
for (const id of readdirSync(dir).filter((entry) => !entry.startsWith('.'))) {
  const events = read(id)
  const header = events[0] ?? {}
  if (mainId !== undefined && !id.startsWith(mainId) && !String(header.parentSession ?? '').startsWith(mainId)) continue
  const requests = events.filter((event) => event.type === 'request/header')
  const config = requests[0]?.data?.header?.config ?? {}
  const times = events.map((event) => event.time).filter((time) => typeof time === 'number')
  rows.push({
    id: id.slice(0, 16),
    role: header.parentSession === undefined ? 'main' : 'subagent',
    route: `${config.provider ?? '?'}/${config.model ?? '?'}`,
    effort: config.reasoningEffort ?? '(route default or none)',
    maxTokens: config.maxTokens ?? '(model window)',
    requests: requests.length,
    calls: events.filter((event) => event.type === 'tool/call').length,
    seconds: times.length === 0 ? 0 : Math.round((Math.max(...times) - Math.min(...times)) / 1000),
    startedAt: times.length === 0 ? 0 : Math.min(...times),
  })
}
rows.sort((a, b) => a.startedAt - b.startedAt)

console.log(`## ${name}: what each session was asked\n`)
console.log('| Session | Role | Route | Reasoning effort | Max output tokens | Requests | Tool calls | Seconds |')
console.log('| --- | --- | --- | --- | --- | ---: | ---: | ---: |')
for (const row of rows) {
  console.log(`| \`${row.id}\` | ${row.role} | ${row.route} | ${row.effort} | ${String(row.maxTokens)} | ${String(row.requests)} | ${String(row.calls)} | ${String(row.seconds)} |`)
}
