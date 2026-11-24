// Bringing a range on screen without scrolling the code sideways more than it must.
import * as vscode from 'vscode'

/** An extension's reveal scrolls smoothly over a few frames: the line is drawn after this long (ms)… */
const LINE_DRAWN_MS = 200
/** …and a sideways scroll after this long. */
const SIDEWAYS_DRAWN_MS = 350

const drawn = (ms: number) => new Promise((res) => setTimeout(res, ms))

/**
 * `r`'s line brought on screen (centred) with column 1 (the indentation, the keywords) in view; only when `r` starts
 * beyond the editor's right edge does it scroll right, just enough to show it. `still()` false (the caller's reason
 * is gone), or the line scrolled away meanwhile, stops it.
 */
export async function revealKeepingIndent(e: vscode.TextEditor, r: vscode.Range, still: () => boolean): Promise<void> {
  const line = r.start.line
  const onScreen = () => still() && e.visibleRanges.some((v) => v.start.line <= line && line <= v.end.line)
  // VS Code scrolls sideways only to a line it has drawn: first the line on screen, then column 1 with the range's
  // first character (both, if they fit), then that character alone (if they didn't: the least scroll right).
  e.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
  await drawn(LINE_DRAWN_MS)
  if (!onScreen()) return
  e.revealRange(new vscode.Range(line, 0, line, r.start.character + 1), vscode.TextEditorRevealType.Default)
  if (r.start.character === 0) return
  await drawn(SIDEWAYS_DRAWN_MS)
  if (!onScreen()) return
  e.revealRange(new vscode.Range(line, r.start.character, line, r.start.character + 1), vscode.TextEditorRevealType.Default)
}
