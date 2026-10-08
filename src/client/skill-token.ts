/**
 * The skill token: how the dialog's checkbox applies a skill to the message
 * being sent. DSH treats a whitespace-bounded `/name` token anywhere in a text
 * block of a user message as a skill invocation (`SKILL_GESTURE` in
 * `@deepseek-ai/dsh-tool-skill`): the host then injects that skill's full
 * instructions into the step. These two pure functions read and write exactly
 * that token, with exactly that boundary rule, so a prompt that goes out with
 * the token is a prompt the host will recognise, and the user never types it.
 *
 * Neither function mutates what it is given: the parts that reach the caller
 * are the caller's own objects, except the one text part that gets the token,
 * which is replaced by a copy.
 * @module dsh-orquestrator/client/skill-token
 */

import type { PromptPartLike } from './host-types.ts'

/** A text part: type `text` with a string payload (the only parts the host scans for a skill token). */
type TextPartLike = PromptPartLike & { readonly text: string }

/** Whether a part is a text part. */
function isTextPart(part: PromptPartLike): part is TextPartLike {
  return part.type === 'text' && typeof part.text === 'string'
}

/** Escape a string for literal use inside a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whether a prompt already carries a skill's token.
 * @param content - the prompt parts.
 * @param name - the skill name (kebab-case), without the leading slash.
 * @returns true when some text part contains `/name` as a whole word, that is
 * preceded by whitespace or the start of the text and followed by whitespace or
 * the end of it (so `/name-more`, `a/name`, `//name` and `/name,` do not count).
 */
export function hasSkillToken(content: readonly PromptPartLike[], name: string): boolean {
  const token = new RegExp(`(^|\\s)/${escapeRegExp(name)}(?=\\s|$)`)
  return content.some(part => isTextPart(part) && token.test(part.text))
}

/**
 * Put a skill's token at the end of a prompt's text, on a line of its own.
 *
 * The last text part gets the token after its text: on a new line, or right
 * after the whitespace the text already ends with (just the token when that
 * text is empty or only whitespace). A prompt with no text part at all, such as
 * one that carries only attachments, gets a new text part holding the token in
 * front of the original parts. A prompt that already carries the token is
 * returned as it is, so applying the skill twice never doubles the token.
 *
 * The end, not the start, because DSH names a conversation after the first words
 * of its first message: a token in front would put `/orchestrate-subagents` in
 * the title of every conversation that applies the skill.
 * @param content - the prompt parts; never modified.
 * @param name - the skill name (kebab-case), without the leading slash.
 * @returns a new array, in the same order, whose parts are the input's own
 * objects except the one text part that was rewritten (a copy) or the one that
 * was added.
 */
export function withSkillToken(content: readonly PromptPartLike[], name: string): PromptPartLike[] {
  if (hasSkillToken(content, name)) return [...content]
  const token = `/${name}`
  const last = content.findLastIndex(isTextPart)
  if (last === -1) return [{ type: 'text', text: token }, ...content]
  return content.map((part, index) => {
    if (index !== last || !isTextPart(part)) return part
    return { ...part, text: appendToken(part.text, token) }
  })
}

/** The text with the token after it: on a new line, unless the text is empty or already ends with whitespace. */
function appendToken(text: string, token: string): string {
  if (text.trim() === '') return token
  return /\s$/.test(text) ? `${text}${token}` : `${text}\n${token}`
}
