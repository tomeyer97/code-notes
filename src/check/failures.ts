// What went wrong, in the Check view's plain words: writing the questions, grading an answer (by cause), a check file
// that isn't JSON (where). No vscode API here (unit-tested in test/checkModel.test.ts and test/checkFailures.test.ts).
import type { AskErrorKind } from '../platform/agent/claude'

// ---------- a check file that isn't JSON ----------

/** Where the engine's JSON error is, when it says so: "… (line 3 column 5)" (newer V8) or "… at position 42". */
const JSON_LINE_COL = /line (\d+) column (\d+)/
const JSON_POSITION = /position (\d+)/
/** The source text an engine quotes after a comma: "Unexpected token '}', "{"a":}" is not valid JSON". */
const JSON_QUOTED = /, ".*$/s
/** Where it is, as the engine words it: " in JSON at position 6 (line 2 column 5)", " at position 6", " (line 2 …)". */
const JSON_PLACE = / (?:in JSON|at position|\().*$/s

/** A JSON.parse error of `text` as a line for the Check view ("Line 3: expected double-quoted property name."). */
export function jsonErrorAt(message: string, text: string | undefined): { line: number; col: number; text: string } | undefined {
  const at = placeOf(message, text)
  if (!at) return undefined
  const [line, col] = at
  return { line, col, text: `Line ${line}: ${jsonWhat(message)}.` }
}

/** The line and column the message names, or the ones of the offset it names in `text`. */
function placeOf(message: string, text: string | undefined): [number, number] | undefined {
  const lc = JSON_LINE_COL.exec(message)
  if (lc) return [Number(lc[1]), Number(lc[2])]
  const pos = JSON_POSITION.exec(message)?.[1]
  return pos !== undefined && typeof text === 'string' ? lineColAt(text, Number(pos)) : undefined
}

/** The engine's words without the quoted text and the place, lower-cased: "expected ':' after property name". */
function jsonWhat(message: string): string {
  const what = message.replace(JSON_QUOTED, '').replace(JSON_PLACE, '').trim().replace(/\.$/, '')
  return what ? `${what[0].toLowerCase()}${what.slice(1)}` : 'not valid JSON'
}

/** 1-based line and column of offset `pos` in `text`. */
function lineColAt(text: string, pos: number): [number, number] {
  const before = text.slice(0, pos).split('\n')
  return [before.length, (before.at(-1) ?? '').length + 1]
}

// ---------- a failed call to Claude ----------

/** A failed call to Claude, by cause. */
export type Cause = 'no-cli' | 'model' | 'busy' | 'auth' | 'other'

/**
 * The causes read from Claude's or the system's words, first match wins. Claude Code reports these only as text; the
 * extension's own `AskErrorKind` comes first (causeOf).
 */
const CAUSE_WORDS: { cause: Cause; words: RegExp }[] = [
  // Not installed, or not where the setting says (the system said ENOENT).
  { cause: 'no-cli', words: /ENOENT/i },
  { cause: 'model', words: /model/i },
  { cause: 'busy', words: /rate.?limit|overloaded|429|529/i },
  { cause: 'auth', words: /auth|log ?in|api key|401|403/i },
]

/** Why a call to Claude failed: the extension's own `kind` when it has one, else the first cause its words name. */
export function causeOf(error: string, kind?: AskErrorKind): Cause {
  if (kind === 'no-cli') return 'no-cli'
  return CAUSE_WORDS.find((c) => c.words.test(error))?.cause ?? 'other'
}

/** What a cause is called in the Check view, without the final period (it is used mid-sentence too). */
const CAUSE_PHRASE = {
  'no-cli': "Claude Code wasn't found",
  busy: 'Claude is busy right now',
  auth: "Claude Code isn't signed in",
} as const

const sentence = (phrase: string) => `${phrase}.`

/** Why grading failed, in the same plain words as writing (the answer is kept either way). */
export function gradeFailure(error: string, kind?: AskErrorKind): string {
  const cause = causeOf(error, kind)
  const why = cause === 'no-cli' || cause === 'busy' || cause === 'auth' ? CAUSE_PHRASE[cause] : "Claude couldn't check it"
  return `${why}; your answer is saved.`
}

// ---------- writing the questions ----------

/** Why writing the questions failed, for the Check view: the text, and the setting or path that may help. */
export interface WriteFailure { text: string; setting?: boolean; path?: boolean }

/**
 * The status words the skill's script prints when there is nothing to write (questions.mjs `start`; SKILL.md tells
 * Claude to reply with that one line), and what the view says then.
 */
const SKILL_STATUS: { word: string; text: string }[] = [
  { word: 'UNCOMMITTED', text: 'Commit your change first: questions are about committed code.' },
  { word: 'NOTHING', text: 'No code lines changed: nothing to ask.' },
]

/** The first sentence of an error, without the CLI's own advice ("Run --verbose to see more."), at most 120 characters. */
function firstSentence(error: string): string {
  const first = error.split(/(?<=[.!?])\s/)[0]
  return first.replace(/\s*Run --?\S+.*$/i, '').slice(0, 120)
}

/**
 * Why writing the questions failed, in plain words for the Check view (never the script's or the CLI's own advice):
 * `error` from Claude (`errorKind`: what the extension knows about it), or `text`, the writer's reply when it wrote
 * nothing.
 */
export function writeFailure(o: { error?: string; errorKind?: AskErrorKind; text?: string; model?: string }): WriteFailure {
  const e = String(o.error ?? '')
  if (e) return errorFailure(e, causeOf(e, o.errorKind), o.model)
  const t = String(o.text ?? '')
  const status = SKILL_STATUS.find((s) => t.includes(s.word))
  return { text: status?.text ?? "Claude couldn't write questions for this change." }
}

/** A failed run, by cause: install Claude Code or set its path, pick another model, or the error's first sentence. */
function errorFailure(error: string, cause: Cause, model: string | undefined): WriteFailure {
  switch (cause) {
    case 'no-cli': return { text: sentence(CAUSE_PHRASE['no-cli']), path: true }
    case 'model': return { text: `Claude couldn't use the model${model ? ` "${model}"` : ''}.`, setting: true }
    case 'busy':
    case 'auth': return { text: sentence(CAUSE_PHRASE[cause]) }
    case 'other': return { text: `Claude couldn't write the questions: ${firstSentence(error)}` }
  }
}
