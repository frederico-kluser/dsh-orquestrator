#!/usr/bin/env node
/**
 * Summarize the DSH sessions of one validation run (main + child sessions).
 *
 *   node analyze-sessions.mjs <sessions-dir> [--dump]
 *
 * <sessions-dir> is `$DSH_HOME/sessions/<encoded cwd>`; every child directory
 * holds `session.v3.jsonl.zstd`. Prints, per session: identity, lineage, the
 * entry-type histogram, the models seen in request configs, tool calls and the
 * closing assistant text. `--dump` also prints every entry (truncated).
 */
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const [dir, flag] = process.argv.slice(2)
if (dir === undefined) {
  console.error('usage: analyze-sessions.mjs <sessions-dir> [--dump]')
  process.exit(2)
}

const clip = (value, max = 240) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max)}...` : text
}

// The log is appended as several zstd frames; only the CLI decodes them all
// (node's one-shot zlib decoder stops after the first frame).
const readSession = (id) => {
  const raw = execFileSync('zstd', ['-dc', join(dir, id, 'session.v3.jsonl.zstd')], { maxBuffer: 1 << 29 }).toString('utf8')
  return raw.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line) } catch { return { type: 'unparseable', line: clip(line) } }
  })
}

const walk = (value, visit, path = '') => {
  visit(value, path)
  if (Array.isArray(value)) value.forEach((item, index) => walk(item, visit, `${path}[${String(index)}]`))
  else if (value !== null && typeof value === 'object') for (const [key, item] of Object.entries(value)) walk(item, visit, `${path}.${key}`)
}

const sessions = readdirSync(dir).filter((name) => !name.startsWith('.')).map((id) => ({ id, entries: readSession(id) }))
sessions.sort((a, b) => (a.entries[0]?.createdAt ?? 0) - (b.entries[0]?.createdAt ?? 0))

for (const { id, entries } of sessions) {
  const header = entries[0] ?? {}
  console.log(`\n=== ${id}`)
  console.log(`origin=${header.origin ?? 'main'} depth=${String(header.delegationDepth)} parent=${header.parentSession ?? '-'} created=${new Date(header.createdAt).toISOString()}`)
  const histogram = {}
  for (const entry of entries) histogram[entry.type] = (histogram[entry.type] ?? 0) + 1
  console.log(`entries=${String(entries.length)} types=${JSON.stringify(histogram)}`)

  const models = new Set()
  const tools = []
  let lastAssistant = ''
  for (const entry of entries) {
    walk(entry, (node, path) => {
      if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
        if (typeof node.provider === 'string' && typeof node.model === 'string') {
          models.add(`${node.provider}/${node.model}${typeof node.reasoningEffort === 'string' ? `@${node.reasoningEffort}` : ''}`)
        }
      }
      void path
    })
    const role = entry.role ?? entry.message?.role
    if (entry.type === 'message' && role === 'assistant') {
      const content = entry.content ?? entry.message?.content
      const text = Array.isArray(content) ? content.filter((part) => part?.type === 'text').map((part) => part.text).join('') : typeof content === 'string' ? content : ''
      if (text.trim() !== '') lastAssistant = text
    }
    const call = entry.toolCall ?? (entry.type === 'tool_call' ? entry : undefined)
    if (call !== undefined) tools.push(call.tool ?? call.name ?? call.toolName ?? '?')
  }
  console.log(`models=${JSON.stringify([...models])}`)
  console.log(`toolCalls=${JSON.stringify(tools.reduce((acc, name) => ({ ...acc, [name]: (acc[name] ?? 0) + 1 }), {}))}`)
  console.log(`lastAssistant: ${clip(lastAssistant.replace(/\s+/g, ' '), 400)}`)
  if (flag === '--dump') for (const [index, entry] of entries.entries()) console.log(`  [${String(index)}] ${clip(entry, 400)}`)
}
