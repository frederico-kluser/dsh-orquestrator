#!/usr/bin/env node
/**
 * Embeds the global skill's Markdown in a generated TypeScript module, so the published host bundle
 * (`lib/index.js`) carries the skill text and never reads it from disk at runtime:
 *
 *   node scripts/gen-skill.mjs [--source <SKILL.md>] [--out <file>] [--check]
 *
 * Without `--check` it writes the module and prints `gen-skill: wrote <out>`. With `--check` it writes nothing and
 * compares the module with what a fresh run would write: equal prints `gen-skill: up to date` (exit 0), anything else
 * (stale, or no file yet) prints the way out on stderr and exits 1. Any problem with the source (no frontmatter, a
 * missing or empty `name` or `description`, a value that spans several lines) is a one-line error and exit 1; a bad
 * command line exits 2.
 *
 * The defaults, `skills/orchestrate-subagents/SKILL.md` and `src/skill.generated.ts`, are resolved against the
 * repository root (the parent of `scripts/`), so the script behaves the same from any working directory. A path given
 * on the command line is resolved against the working directory, as for any command.
 *
 * The frontmatter is the plain subset the skill file uses, one `key: value` per line, split on the FIRST colon:
 *   - `name` and `description` are required, `when-to-use` is optional, every other key is ignored;
 *   - a value is a single-line plain scalar; one pair of matching surrounding quotes is stripped, nothing else is
 *     unescaped; a value that continues on another line (indentation, `>` or `|`) is an error, because it would
 *     silently truncate the text.
 * The body is everything after the closing `---` line, with line endings normalized to `\n`, leading blank lines
 * removed and trailing whitespace trimmed.
 *
 * The output is byte-for-byte deterministic: the same Markdown always yields the same file. Dependencies: none.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

/** The repository root: the parent of `scripts/`. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_SOURCE = 'skills/orchestrate-subagents/SKILL.md'
const DEFAULT_OUT = 'src/skill.generated.ts'
const USAGE = 'usage: node scripts/gen-skill.mjs [--source <SKILL.md>] [--out <file>] [--check]'

/** The frontmatter keys the generator reads; every other key is ignored. */
const KNOWN_KEYS = new Set(['name', 'description', 'when-to-use'])
/** `key: value` at the start of a line, split on the FIRST colon (the value may hold more of them, and any character: `s`). */
const KEY_LINE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)[ \t]*:(.*)$/s
/** A YAML block-scalar header (`>`, `|`, `>-`, `|+`, `>2`, ...): the value continues on the following lines. */
const BLOCK_SCALAR = /^[|>](?:[1-9][+-]?|[+-][1-9]?)?$/

/** A problem with the input or the command line, reported as one line instead of a stack trace. */
class UserError extends Error {}

/**
 * A path as the messages and the header comment show it: relative to the repository root with forward slashes,
 * or the absolute path when the file lies outside the repository.
 * @param {string} path - absolute path.
 * @returns {string} the display form.
 */
function display(path) {
  const rel = relative(ROOT, path)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return path
  return rel.split(sep).join('/')
}

/**
 * Strip one pair of matching surrounding quotes, and nothing else.
 * @param {string} value - a trimmed scalar.
 * @returns {string} the scalar without its quotes.
 */
function unquote(value) {
  const first = value[0]
  if (value.length >= 2 && (first === '"' || first === "'") && value.at(-1) === first) return value.slice(1, -1)
  return value
}

/**
 * Read the keys this generator knows from the lines between the two `---` lines.
 * @param {string[]} lines - the frontmatter lines (without the delimiters).
 * @param {string} label - the source path for messages.
 * @returns {Map<string, string>} the value of every known key that is present.
 */
function parseFrontmatter(lines, label) {
  /** @type {Map<string, string>} */
  const found = new Map()
  /** The key of the latest `key: value` line: an indented line after it belongs to its value. */
  let previous
  for (const [offset, line] of lines.entries()) {
    const where = `${label}:${String(offset + 2)}`
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (line.startsWith(' ') || line.startsWith('\t')) {
      if (previous === undefined) throw new UserError(`${where}: expected "key: value" in the frontmatter, found an indented line`)
      // The continuation of a key this script reads would silently truncate its value; the one of an ignored key
      // (a nested block such as `metadata:`) goes away with it.
      if (KNOWN_KEYS.has(previous)) throw new UserError(`${where}: the value of "${previous}" spans several lines; write it on one line`)
      continue
    }
    const match = KEY_LINE.exec(line)
    if (match === null) throw new UserError(`${where}: expected "key: value" in the frontmatter, found "${line.trim()}" (a value spanning several lines is not supported; write it on one line)`)
    const key = match[1] ?? ''
    const raw = (match[2] ?? '').trim()
    previous = key
    if (!KNOWN_KEYS.has(key)) continue
    if (found.has(key)) throw new UserError(`${where}: "${key}" is set twice in the frontmatter`)
    if (BLOCK_SCALAR.test(raw)) throw new UserError(`${where}: the value of "${key}" is a block scalar ("${raw}"); write it on one line`)
    found.set(key, unquote(raw))
  }
  return found
}

/**
 * Split a SKILL.md into the fields the host registers.
 * @param {string} text - the file's text.
 * @param {string} label - the source path for messages.
 * @returns {{ name: string, description: string, whenToUse?: string, content: string }} the parsed skill.
 */
function parseSkill(text, label) {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  if (lines[0] !== '---') throw new UserError(`${label}: no frontmatter: the first line must be "---"`)
  const closing = lines.indexOf('---', 1)
  if (closing === -1) throw new UserError(`${label}: the frontmatter is not closed: there is no second "---" line`)
  const found = parseFrontmatter(lines.slice(1, closing), label)
  for (const key of ['name', 'description']) {
    if ((found.get(key) ?? '').trim() === '') throw new UserError(`${label}: the frontmatter needs a non-empty "${key}"`)
  }
  const whenToUse = found.get('when-to-use')
  return {
    name: found.get('name') ?? '',
    description: found.get('description') ?? '',
    ...(whenToUse === undefined || whenToUse.trim() === '' ? {} : { whenToUse }),
    content: lines.slice(closing + 1).join('\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd(),
  }
}

/**
 * The text of the generated module. Every string literal is a JSON string, so no content can break out of it.
 * @param {{ name: string, description: string, whenToUse?: string, content: string }} skill - the parsed skill.
 * @param {string} sourceLabel - the source path shown in the header comment.
 * @returns {string} the module, ending in a single newline.
 */
function renderModule(skill, sourceLabel) {
  return [
    '/**',
    ` * GENERATED by scripts/gen-skill.mjs from ${sourceLabel}. Do not edit by hand:`,
    ' * edit the Markdown and run `node scripts/gen-skill.mjs`.',
    ' */',
    'export const SKILL_SOURCE = {',
    `  name: ${JSON.stringify(skill.name)},`,
    `  description: ${JSON.stringify(skill.description)},`,
    ...(skill.whenToUse === undefined ? [] : [`  whenToUse: ${JSON.stringify(skill.whenToUse)},`]),
    `  content: ${JSON.stringify(skill.content)},`,
    '} as const',
    '',
  ].join('\n')
}

/**
 * Read a text file, turning a failure into a one-line error.
 * @param {string} path - absolute path.
 * @returns {string} the file's text.
 */
function readSource(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    throw new UserError(`cannot read ${display(path)}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Parse the command line.
 * @returns the options, or undefined after reporting a bad command line (exit code 2).
 */
function parseCommandLine() {
  try {
    return parseArgs({
      args: process.argv.slice(2),
      options: {
        source: { type: 'string' },
        out: { type: 'string' },
        check: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
    }).values
  } catch (error) {
    console.error(`gen-skill: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
    process.exitCode = 2
    return undefined
  }
}

/** Parse the command line, generate, and write or check. */
function main() {
  const values = parseCommandLine()
  if (values === undefined) return
  if (values.help) {
    console.log(USAGE)
    return
  }

  try {
    const source = values.source === undefined ? resolve(ROOT, DEFAULT_SOURCE) : resolve(values.source)
    const out = values.out === undefined ? resolve(ROOT, DEFAULT_OUT) : resolve(values.out)
    const output = renderModule(parseSkill(readSource(source), display(source)), display(source))

    if (values.check) {
      if (existsSync(out) && readFileSync(out, 'utf8') === output) {
        console.log('gen-skill: up to date')
      } else {
        console.error(`gen-skill: ${display(out)} is out of date: run node scripts/gen-skill.mjs`)
        process.exitCode = 1
      }
      return
    }
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, output)
    console.log(`gen-skill: wrote ${display(out)}`)
  } catch (error) {
    if (!(error instanceof UserError)) throw error
    console.error(`gen-skill: ${error.message}`)
    process.exitCode = 1
  }
}

main()
