// A controller's explanation as a transient hint beside the lines it revealed: what is shown, and what ends it. It
// lasts only while the reader looks at those lines: an edit in the file, the caret leaving the lines, Esc or the next
// reveal ends it. Nothing is saved. No vscode (unit-tested in test/bridgeHint.test.ts; bridge/hint.ts draws it).
import { plain } from '../text'

/** What is shown: `text` (Markdown) beside lines start..end (0-based, inclusive) of the file `uri`. */
export interface HintState { uri: string; start: number; end: number; text: string; author: string }

/** What the reader did in a file. `line`: where the caret is now (0-based). (Esc and the command: dismiss().) */
export type HintEvent =
  | { kind: 'edit'; uri: string }
  | { kind: 'selection'; uri: string; line: number }

/** The longest label beside the line; the hover has the whole text. */
export const LABEL_MAX = 120

/** The text beside the line: its first line, plain, cut to LABEL_MAX. */
export const hintLabel = (text: string) => plain(text, LABEL_MAX)

/** Whether `e` ends a hint shown at `shown`: an edit in its file, or the caret out of its lines (in its file). */
export function endsHint(shown: HintState, e: HintEvent): boolean {
  if (e.uri !== shown.uri) return false
  return e.kind === 'edit' || e.line < shown.start || e.line > shown.end
}

/** The hint shown, if any; `changed` is told each time it appears, is replaced or goes. */
export class TransientHint {
  private shown: HintState | undefined

  constructor(private readonly changed: (state: HintState | undefined) => void) {}

  /** Shows a hint, replacing the one before. */
  show(state: HintState): void {
    this.shown = { ...state }
    this.changed(this.state)
  }

  /** Ends the hint, if `e` ends it. */
  notice(e: HintEvent): void {
    if (this.shown && endsHint(this.shown, e)) this.dismiss()
  }

  /** Ends the hint whatever it is (Esc, the command, a reveal without text). */
  dismiss(): void {
    if (!this.shown) return
    this.shown = undefined
    this.changed(undefined)
  }

  get state(): HintState | undefined { return this.shown && { ...this.shown } }
}
