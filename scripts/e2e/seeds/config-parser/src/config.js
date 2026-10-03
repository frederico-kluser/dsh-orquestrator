'use strict'

/**
 * Parse "key=value" text into an object.
 * - blank lines are skipped
 * - lines starting with '#' are comments and are skipped
 * - a line without '=' throws a SyntaxError naming the 1-based line number
 * - keys and values are trimmed; when a key repeats, the LAST value wins
 */
function parseConfig(text) {
  const result = {}
  const lines = String(text).split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line === '' || line.startsWith('#')) continue
    const equals = line.indexOf('=')
    if (equals === -1) throw new SyntaxError(`line ${index + 1}: expected key=value`)
    result[line.slice(0, equals).trim()] = line.slice(equals + 1).trim()
  }
  return result
}

module.exports = { parseConfig }
