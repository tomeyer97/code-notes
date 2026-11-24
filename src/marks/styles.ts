// How the walk and the marks draw on the code, in one place: a step's lines (the card's bar), a ref opened from the
// card, and a mark (a fill, focus or dim, within a line or of whole lines). One look per meaning; the colours are
// theme colours (package.json contributes codeNotes.*).
import * as vscode from 'vscode'

/** A mark: the focus (the newest, the one coloured thing on the code) or one before it (a lighter, grey tint); within a
 *  line (its characters) or whole lines (one block). Fills only: no borders, no bars, nothing in the scrollbar. */
export const MARK_STYLES = {
  focus: {
    backgroundColor: new vscode.ThemeColor('codeNotes.markBackground'), borderRadius: '2px',
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  },
  focusLines: { isWholeLine: true, backgroundColor: new vscode.ThemeColor('codeNotes.markBackground') },
  dim: {
    backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'), borderRadius: '2px',
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  },
  dimLines: { isWholeLine: true, backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground') },
} satisfies Record<string, vscode.DecorationRenderOptions>

/** The step card on the code: the step's lines (a bar and a faint tint), the same while the voice tells the step, a
 *  stale step's, and a reference opened from the card. */
export const STEP_STYLES = {
  // A faint tint too: clear which lines the step is about; selection and find stay on top.
  at: {
    isWholeLine: true, borderWidth: '0 0 0 2px', borderStyle: 'solid', borderColor: new vscode.ThemeColor('textLink.foreground'),
    backgroundColor: new vscode.ThemeColor('codeNotes.stepBackground'),
    overviewRulerColor: new vscode.ThemeColor('textLink.foreground'), overviewRulerLane: vscode.OverviewRulerLane.Center,
  },
  // While the voice tells the step: a thin grey bar, no tint, nothing in the scrollbar (the marks are the colour).
  quiet: {
    isWholeLine: true, borderWidth: '0 0 0 2px', borderStyle: 'solid', borderColor: new vscode.ThemeColor('editorLineNumber.activeForeground'),
  },
  stale: {
    isWholeLine: true, borderWidth: '0 0 0 2px', borderStyle: 'dashed', borderColor: new vscode.ThemeColor('editorWarning.foreground'),
    overviewRulerColor: new vscode.ThemeColor('editorWarning.foreground'), overviewRulerLane: vscode.OverviewRulerLane.Center,
  },
  ref: {
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('textLink.foreground'),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  },
} satisfies Record<string, vscode.DecorationRenderOptions>
