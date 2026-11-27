// Text whose `names` in backticks are code: drawn as <code> (codeSpans), or said without the backticks (plainText).
// Plain DOM, textContent only. Used by the Check view (check.js, checkAnswer.js).
import { el } from './common.js'

/**
 * The pieces of `text`: plain text, and each `name` between backticks as a <code> element.
 * @param {string} text
 * @returns {(string | HTMLElement)[]}
 */
export function codeSpans(text) {
  /** @type {(string | HTMLElement)[]} */
  const out = []
  // Split at the backticks: every other piece is inside a pair.
  text.split('`').forEach((part, k) => {
    if (part) out.push(k % 2 ? el('code', null, part) : part)
  })
  return out
}

/**
 * `text` as a screen reader should hear it: the backticks dropped.
 * @param {string} text
 */
export const plainText = (text) => text.replace(/`/g, '')
