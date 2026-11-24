// What went wrong, in the Check view's plain words: writing the questions, grading an answer (by cause), a check file
// that isn't JSON (where). No vscode API here (unit-tested in test/checkModel.test.ts).
import type { AskErrorKind } from '../platform/agent/claude'

/** Where the engine's JSON error is, when it says so: "… (line 3 column 5)" (newer V8) or "… at position 42". */
const JSON_LINE_COL = /line (\d+) column (\d+)/
const JSON_POSITION = /position (\d+)/
/**
 * The engine's words without the place and the quoted text: "Expected ':' after property name in JSON at position 6
 * (line 2 column 5)" → "Expected ':' after property name"; "Unexpected token '}', "{"a":}" is not valid JSON" →
 * "Unexpected token '}'".
 */
const JSON_WHAT = /^(Unexpected token[^,]*|[^(]*?)(?:,.*| in JSON.*| at position.*|\(.*)$/s

/** A JSON.parse error of `text` as a line for the Check view ("Line 3: expected double-quoted property name."). */
export function jsonErrorAt(message: string, text: string | undefined): { line: number; col: number; text: string } | undefined {
  let lc = JSON_LINE_COL.exec(message)?.slice(1).map(Number)
  const pos = JSON_POSITION.exec(message)?.[1]
  if (!lc && pos !== undefined && typeof text === 'string') lc = lineColAt(text, Number(pos))
  if (!lc) return undefined
  const what = message.replace(JSON_WHAT, '$1').trim().replace(/\.$/, '')
  return { line: lc[0], col: lc[1], text: `Line ${lc[0]}: ${what ? `${what[0].toLowerCase()}${what.slice(1)}` : 'not valid JSON'}.` }
}
/** 1-based line and column of offset `pos` in `text`. */
function lineColAt(text: string, pos: number): [number, number] {
  const before = text.slice(0, pos).split('\n')
  return [before.length, before.at(-1)!.length + 1]
}

/** Why grading failed, in the same plain words as writing (the answer is kept either way). */
export function gradeFailure(error: string, kind?: AskErrorKind): string {
  const cause = causeOf(error, kind)
  const why = cause === 'no-cli' ? "Claude Code wasn't found"
    : cause === 'busy' || cause === 'auth' ? CAUSE_TEXT[cause].replace(/\.$/, '')
    : "Claude couldn't check it"
  return `${why}; your answer is saved.`
}

/** A failed call to Claude, by cause: from the extension's own `kind`, else from Claude's or the system's words. */
type Cause = 'no-cli' | 'model' | 'busy' | 'auth' | 'other'
function causeOf(error: string, kind?: AskErrorKind): Cause {
  // Not installed, or not where the setting says (the extension couldn't start it; or the system said ENOENT).
  if (kind === 'no-cli' || /ENOENT/i.test(error)) return 'no-cli'
  if (/model/i.test(error)) return 'model'
  if (/rate.?limit|overloaded|429|529/i.test(error)) return 'busy'
  if (/auth|log ?in|api key|401|403/i.test(error)) return 'auth'
  return 'other'
}
const CAUSE_TEXT = { 'no-cli': "Claude Code wasn't found.", busy: 'Claude is busy right now.', auth: "Claude Code isn't signed in." }

/**
 * Why writing the questions failed, in plain words for the Check view (never the script's or the CLI's own advice):
 * `error` from Claude (`errorKind`: what the extension knows about it), or `text`, the writer's reply when it wrote
 * nothing.
 */
export function writeFailure(o: { error?: string; errorKind?: AskErrorKind; text?: string; model?: string }): { text: string; setting?: boolean; path?: boolean } {
  const e = String(o.error ?? '')
  if (e) {
    const cause = causeOf(e, o.errorKind)
    // Install it, or set its path (and a reviewer's approval waives the check).
    if (cause === 'no-cli') return { text: CAUSE_TEXT['no-cli'], path: true }
    if (cause === 'model') return { text: `Claude couldn't use the model${o.model ? ` "${o.model}"` : ''}.`, setting: true }
    if (cause === 'busy' || cause === 'auth') return { text: CAUSE_TEXT[cause] }
    return { text: `Claude couldn't write the questions: ${e.split(/(?<=[.!?])\s/)[0].replace(/\s*Run --?\S+.*$/i, '').slice(0, 120)}` }
  }
  const t = String(o.text ?? '')
  if (/UNCOMMITTED/.test(t)) return { text: 'Commit your change first: questions are about committed code.' }
  if (/NOTHING/.test(t)) return { text: 'No code lines changed: nothing to ask.' }
  return { text: "Claude couldn't write questions for this change." }
}
