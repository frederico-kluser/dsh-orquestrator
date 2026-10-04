#!/usr/bin/env node
/**
 * Markdown evidence summary of one headless validation run.
 *
 *   node summarize-run.mjs <run-name> [root]
 *
 * Reads $root/runs/<name>/ (result.txt, workspace/, stderr.log) and the run's
 * DSH sessions ($root/home/sessions/<encoded cwd>), and prints: timing, one row
 * per session (role, model, steps, tool calls), what the main agent received
 * from the `subagent` tool, its final answer, and the files the agents left.
 * Nothing secret is read: sessions hold prompts, tool calls and results only.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const [name, rootArg] = process.argv.slice(2)
if (name === undefined) {
  console.error('usage: summarize-run.mjs <run-name> [root]')
  process.exit(2)
}
const root = rootArg ?? '/Volumes/Ext2TB/dsh-orq-validation'
const runDir = join(root, 'runs', name)
const sessionsRoot = join(root, 'home', 'sessions')
const sessionDir = readdirSync(sessionsRoot).map((entry) => join(sessionsRoot, entry)).find((entry) => entry.includes(`-runs-${name}-workspace--`))

const clip = (text, max) => {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}...` : flat
}
// Collect every `text` string nested in a tool-result / message content tree.
const textOf = (node) => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object') return typeof node.text === 'string' ? node.text : textOf(node.content)
  return ''
}
const read = (id) => execFileSync('zstd', ['-dc', join(sessionDir, id, 'session.v3.jsonl.zstd')], { maxBuffer: 1 << 29 })
  .toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))

const result = existsSync(join(runDir, 'result.txt')) ? readFileSync(join(runDir, 'result.txt'), 'utf8').trim() : 'no result.txt'
// A headless run's first event names its main session; the workspace folder may also hold other sessions (a browser run shares it).
let mainId
try { mainId = JSON.parse(readFileSync(join(runDir, 'events.jsonl'), 'utf8').split('\n')[0] ?? '{}').sessionId } catch { mainId = undefined }
const all = readdirSync(sessionDir).filter((id) => !id.startsWith('.')).map((id) => ({ id, entries: read(id) }))
const sessions = all.filter(({ id, entries }) => mainId === undefined || id === mainId || entries[0]?.parentSession === mainId)
sessions.sort((a, b) => (a.entries[0]?.createdAt ?? 0) - (b.entries[0]?.createdAt ?? 0))

const modelsOf = (entries) => {
  const seen = new Set()
  for (const entry of entries) {
    const model = entry.data?.message?.source
    if (model?.provider !== undefined && model?.model !== undefined) seen.add(`${model.provider}/${model.model}`)
  }
  return [...seen].join(', ') || 'n/a'
}

const lines = [`## ${name}`, '', `Result: \`${result}\``, '', '| Session | Role | Model | Steps | Tool calls | Started (UTC) |', '| --- | --- | --- | --- | --- | --- |']
for (const { id, entries } of sessions) {
  const header = entries[0]
  const role = header.origin === 'subagent' ? `subagent (depth ${String(header.delegationDepth)})` : 'main'
  const steps = entries.filter((entry) => entry.type === 'step/end').length
  const calls = entries.filter((entry) => entry.type === 'tool/call').length
  lines.push(`| \`${id.slice(0, 16)}\` | ${role} | ${modelsOf(entries)} | ${String(steps)} | ${String(calls)} | ${new Date(header.createdAt).toISOString().slice(11, 19)} |`)
}

const main = sessions.find(({ entries }) => entries[0]?.origin === undefined)
if (main !== undefined) {
  const call = main.entries.find((entry) => entry.type === 'tool/call' && entry.data?.name === 'subagent')
  if (call !== undefined) {
    let args = {}
    try { args = JSON.parse(call.data.arguments) } catch { /* keep empty */ }
    lines.push('', `Main agent called \`subagent\` with \`run_in_background: ${String(args.run_in_background)}\`, description "${clip(args.description ?? '', 80)}".`)
  }
  const results = main.entries.filter((entry) => entry.type === 'tool/result')
  const toolNames = new Map(main.entries.filter((entry) => entry.type === 'tool/call').map((entry) => [entry.data.callId, entry.data.name]))
  for (const entry of results) {
    const tool = toolNames.get(entry.data.message?.source?.callId) ?? 'tool'
    lines.push('', `The \`${tool}\` tool result the main agent received (first 900 characters):`, '', '```text', clip(textOf(entry.data.message.content), 900), '```')
  }
  const final = [...main.entries].reverse().find((entry) => entry.type === 'assistant/message' && textOf(entry.data.message.content.filter((part) => part.type === 'text')).trim() !== '')
  if (final !== undefined) lines.push('', 'Main agent final answer (first 400 characters):', '', '```text', clip(textOf(final.data.message.content.filter((part) => part.type === 'text')), 400), '```')
}

const workspace = join(runDir, 'workspace')
if (existsSync(workspace)) {
  const files = readdirSync(workspace).filter((entry) => entry !== '.git')
  lines.push('', `Workspace after the run: ${files.map((file) => `\`${file}\``).join(', ')}`)
}
const errLog = join(runDir, 'stderr.log')
if (existsSync(errLog)) {
  const plugin = readFileSync(errLog, 'utf8').split('\n').filter((line) => line.includes('dsh-orquestrator'))
  if (plugin.length > 0) lines.push('', 'Plugin log lines:', '', '```text', ...plugin.slice(0, 6).map((line) => clip(line, 240)), '```')
}
console.log(lines.join('\n'))
