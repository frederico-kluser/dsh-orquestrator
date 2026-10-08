import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PromptPartLike } from '../../src/client/host-types.ts'
import { hasSkillToken, withSkillToken } from '../../src/client/skill-token.ts'

const NAME = 'orchestrate-subagents'
const TOKEN = `/${NAME}`

const text = (value: string): PromptPartLike => ({ type: 'text', text: value })
const image: PromptPartLike = { type: 'image' }
const file: PromptPartLike = { type: 'file' }

/** DSH's own scanner (`SKILL_GESTURE` in `@deepseek-ai/dsh-tool-skill`), to check that what we write is what the host reads. */
const DSH_SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g
const gesturesIn = (parts: readonly PromptPartLike[]): string[] => parts
  .flatMap(part => (part.type === 'text' && typeof part.text === 'string' ? [...part.text.matchAll(DSH_SKILL_GESTURE)] : []))
  .map(match => match[2] ?? '')

/**
 * DSH's fallback conversation title (`fallbackSessionTitle`, with the base bundle's `fallbackMaxWords: 5` and
 * `fallbackMaxBytes: 40`): the first five words of the first message, cut at 40 bytes.
 */
const fallbackTitle = (value: string): string => {
  const words = value.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 5).join(' ')
  return Buffer.from(words, 'utf8').subarray(0, 40).toString('utf8')
}

/** Freeze an array of parts and every part in it, so that a mutation throws (the modules are strict ESM). */
function freeze<T extends PromptPartLike>(parts: T[]): T[] {
  for (const part of parts) Object.freeze(part)
  return Object.freeze(parts) as T[]
}

describe('hasSkillToken', () => {
  it('finds the token as a whole word: alone, first, last, between words and after a line break', () => {
    for (const value of [
      TOKEN,
      `${TOKEN} build it`,
      `build it ${TOKEN}`,
      `build ${TOKEN} it`,
      `build it\n${TOKEN}\nplease`,
      `build it\t${TOKEN}\r\n`,
      `${TOKEN}\n`,
      `\u00a0${TOKEN}`,
    ]) {
      assert.equal(hasSkillToken([text(value)], NAME), true, JSON.stringify(value))
    }
  })

  it('does not take a longer word, a path, a punctuated token or another skill for it', () => {
    for (const value of [
      '',
      'build it',
      NAME,
      `${TOKEN}-more`,
      `${TOKEN}s`,
      `${TOKEN},`,
      `${TOKEN}.`,
      `(${TOKEN})`,
      `(${TOKEN} go`, // only the left boundary is wrong
      `"${TOKEN} go`,
      `:${TOKEN} go`,
      `-${TOKEN} go`,
      `go ${TOKEN}!`, // only the right boundary is wrong
      `go ${TOKEN})`,
      `go ${TOKEN}:`,
      `x${TOKEN}`,
      `src${TOKEN}/index.ts`,
      `/${NAME}/index.ts`,
      `/${TOKEN}`,
      `${TOKEN}/`,
      '/orchestrate',
      '/subagents',
      `/${NAME.toUpperCase()}`,
      '@/orchestrate-subagents',
    ]) {
      assert.equal(hasSkillToken([text(value)], NAME), false, JSON.stringify(value))
    }
  })

  it('looks at every text part and at text parts only', () => {
    assert.equal(hasSkillToken([text('one'), image, text(`two ${TOKEN}`)], NAME), true)
    assert.equal(hasSkillToken([{ type: 'image', text: TOKEN }, { type: 'file', text: TOKEN }], NAME), false)
    assert.equal(hasSkillToken([{ type: 'text' }], NAME), false) // a text part with no string is no text at all
    assert.equal(hasSkillToken([], NAME), false)
    assert.equal(hasSkillToken([image, file], NAME), false)
  })

  it('treats the name literally, never as a pattern', () => {
    assert.equal(hasSkillToken([text('/a.b')], 'a.b'), true)
    assert.equal(hasSkillToken([text('/axb')], 'a.b'), false)
    assert.equal(hasSkillToken([text('/a+')], 'a+'), true)
    assert.equal(hasSkillToken([text('/aaa')], 'a+'), false)
    assert.equal(hasSkillToken([text('/x')], '(x|y)'), false)
    assert.equal(hasSkillToken([text('/(x|y)')], '(x|y)'), true)
    assert.equal(hasSkillToken([text('/[a]')], '[a]'), true)
    assert.equal(hasSkillToken([text('/a')], '[a]'), false)
    assert.equal(hasSkillToken([text('/a\\b')], 'a\\b'), true)
  })

  it('agrees with the scanner DSH runs on a user message', () => {
    for (const value of [TOKEN, `fix ${TOKEN} now`, `${TOKEN}-more`, `a${TOKEN}`, `${TOKEN}!`, `/usr/bin ${TOKEN}`, `5/8 ${TOKEN}`, '/orchestrate']) {
      assert.equal(hasSkillToken([text(value)], NAME), gesturesIn([text(value)]).includes(NAME), JSON.stringify(value))
    }
  })

  it('is stateless between calls', () => {
    const parts = [text(`go ${TOKEN}`)]
    for (let i = 0; i < 4; i += 1) assert.equal(hasSkillToken(parts, NAME), true)
  })
})

describe('withSkillToken', () => {
  it('puts the token on a line of its own after the last text part', () => {
    assert.deepEqual(withSkillToken([text('build the thing')], NAME), [text(`build the thing\n${TOKEN}`)])
    assert.deepEqual(withSkillToken([text('  indented\nand two lines')], NAME), [text(`  indented\nand two lines\n${TOKEN}`)])
    assert.deepEqual(withSkillToken([text('/other-skill do the thing')], NAME), [text(`/other-skill do the thing\n${TOKEN}`)])
  })

  it('does not add a second separator when the text already ends with whitespace', () => {
    assert.deepEqual(withSkillToken([text('multi\nline\n')], NAME), [text(`multi\nline\n${TOKEN}`)])
    assert.deepEqual(withSkillToken([text('go ')], NAME), [text(`go ${TOKEN}`)])
    assert.deepEqual(withSkillToken([text('go\t')], NAME), [text(`go\t${TOKEN}`)])
  })

  it('writes just the token when the last text part is empty or only whitespace', () => {
    assert.deepEqual(withSkillToken([text('')], NAME), [text(TOKEN)])
    assert.deepEqual(withSkillToken([text('  \n\t ')], NAME), [text(TOKEN)])
    assert.deepEqual(withSkillToken([text('earlier text'), text(' ')], NAME), [text('earlier text'), text(TOKEN)])
  })

  it('leaves everything but the last text part alone', () => {
    const parts = [image, text('first'), text('second'), file]
    const result = withSkillToken(parts, NAME)
    assert.deepEqual(result, [image, text('first'), text(`second\n${TOKEN}`), file])
    assert.equal(result[0], image)
    assert.equal(result[1], parts[1])
    assert.equal(result[3], file)
  })

  it('keeps every other field of the text part it rewrites', () => {
    const rich = { type: 'text', text: 'hello', cache: true, name: 'x' } as PromptPartLike
    const [rewritten] = withSkillToken([rich], NAME)
    assert.deepEqual(rewritten, { type: 'text', text: `hello\n${TOKEN}`, cache: true, name: 'x' })
    assert.notEqual(rewritten, rich)
  })

  it('keeps the token out of the conversation title DSH derives from the first five words, for a message of five words or more', () => {
    for (const message of [
      'Add input validation to the signup form and cover it with tests',
      'one two three four five', // exactly five: the token is the sixth word
      'Fix the flaky\nlogin test in the auth service',
    ]) {
      const [part] = withSkillToken([text(message)], NAME)
      const title = fallbackTitle((part as { text: string }).text)
      assert.equal(title.includes('orchestrate'), false, title)
      assert.equal(title, fallbackTitle(message), 'the title is the one the message has without the skill')
    }
  })

  it('a message of fewer than five words still carries the token in its title: the limit of putting it last', () => {
    // Four words and the token make five, and the title takes five. Putting the token first would put it in the title
    // of every conversation instead, so last is the lesser cost; this pins that the limit is real, not that it is fine.
    for (const [message, title] of [
      ['add dark mode', 'add dark mode /orchestrate-subagents'],
      ['fix the flaky test', 'fix the flaky test /orchestrate-subagent'], // the 40-byte cap cuts the last letter
      ['go', 'go /orchestrate-subagents'],
    ] as const) {
      const [part] = withSkillToken([text(message)], NAME)
      assert.equal(fallbackTitle((part as { text: string }).text), title)
    }
  })

  it('adds a text part in front of a prompt that has only attachments', () => {
    const parts = [image, file]
    const result = withSkillToken(parts, NAME)
    assert.deepEqual(result, [text(TOKEN), image, file])
    assert.equal(result[1], image)
    assert.equal(result[2], file)
    assert.deepEqual(withSkillToken([], NAME), [text(TOKEN)])
    // A text part without a string is not a text part: the token gets a part of its own.
    const hollow = { type: 'text' } as PromptPartLike
    assert.deepEqual(withSkillToken([hollow], NAME), [text(TOKEN), hollow])
  })

  it('returns a copy, the same parts, when the token is already there, so it never doubles', () => {
    const parts = [image, text(`go ${TOKEN} now`), text('tail')]
    const result = withSkillToken(parts, NAME)
    assert.notEqual(result, parts)
    assert.equal(result.length, parts.length)
    result.forEach((part, index) => { assert.equal(part, parts[index]) })
    // Applying it again to its own output changes nothing, and the token stays alone.
    const once = withSkillToken([text('do it')], NAME)
    const twice = withSkillToken(once, NAME)
    assert.deepEqual(twice, once)
    assert.deepEqual(gesturesIn(twice), [NAME])
  })

  it('never mutates its input, arrays or parts', () => {
    const cases: PromptPartLike[][] = [
      [text('build it')],
      [text('')],
      [image, file],
      [],
      [image, text('x'), text('y')],
      [text(`already ${TOKEN}`)],
    ]
    for (const parts of cases) {
      const before = structuredClone(parts)
      const frozen = freeze(parts)
      assert.doesNotThrow(() => withSkillToken(frozen, NAME))
      assert.deepEqual(frozen, before)
    }
  })

  it('always leaves a token that DSH reads as exactly this skill, whatever the text was', () => {
    for (const value of ['go', '', '   ', `${TOKEN}-more`, `a${TOKEN}`, `${TOKEN}!`, '/other', 'multi\nline\n', `x ${TOKEN}`, 'ends with a url https://example.com/orchestrate-subagents']) {
      const result = withSkillToken([text(value)], NAME)
      assert.equal(hasSkillToken(result, NAME), true, JSON.stringify(value))
      assert.equal(gesturesIn(result).filter(name => name === NAME).length, 1, JSON.stringify(value))
    }
    assert.equal(hasSkillToken(withSkillToken([image], NAME), NAME), true)
  })

  it('treats the name literally when it writes the token too', () => {
    assert.deepEqual(withSkillToken([text('go')], 'a.b'), [text('go\n/a.b')])
    assert.deepEqual(withSkillToken([text('/axb go')], 'a.b'), [text('/axb go\n/a.b')])
  })
})
