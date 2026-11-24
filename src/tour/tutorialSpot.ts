import * as vscode from 'vscode'
import { setDecorations } from '../platform/editorDecorations'

// The tutorial's card about the step card (the tutorial shows things in the editor too): while it is up, the
// step's lines in the editor are boxed, so the eyes land on the card that sits right above them. An extension can't
// draw on the card itself (a comment thread), only on code lines.

/** The box's sides, as a line of it draws them (CSS border widths: top right bottom left): its first line, its middle
 *  lines, its last line, and a box of one line. */
const BOX_SIDES = { top: '1px 1px 0 1px', mid: '0 1px', bottom: '0 1px 1px 1px', one: '1px' } as const

/** One line of the box: whole lines, in the focus border's colour (where VS Code shows what has the focus). */
const boxLook = (borderWidth: string): vscode.DecorationRenderOptions =>
  ({ isWholeLine: true, borderStyle: 'solid', borderColor: new vscode.ThemeColor('focusBorder'), borderWidth })

export class TutorialSpot implements vscode.Disposable {
  private readonly kinds = {
    top: vscode.window.createTextEditorDecorationType(boxLook(BOX_SIDES.top)),
    mid: vscode.window.createTextEditorDecorationType(boxLook(BOX_SIDES.mid)),
    bottom: vscode.window.createTextEditorDecorationType(boxLook(BOX_SIDES.bottom)),
    one: vscode.window.createTextEditorDecorationType(boxLook(BOX_SIDES.one)),
  }
  private at: { uri: string; start: number; end: number } | undefined
  private readonly sub = vscode.window.onDidChangeVisibleTextEditors(() => this.paint())

  /** For tests: what is boxed. */
  get shown(): { uri: string; start: number; end: number } | undefined { return this.at }

  /** Boxes lines start..end (0-based) of a file, wherever it is shown. */
  show(uri: vscode.Uri, start: number, end: number): void { this.at = { uri: uri.toString(), start, end }; this.paint() }
  clear(): void { if (this.at) { this.at = undefined; this.paint() } }

  private paint(): void {
    for (const e of vscode.window.visibleTextEditors) {
      const a = this.at && e.document.uri.toString() === this.at.uri ? this.at : undefined
      const line = (n: number) => [new vscode.Range(n, 0, n, 0)]
      const { top, mid, bottom, one } = this.kinds
      const several = !!a && a.end > a.start
      setDecorations(e, one, a && a.start === a.end ? line(a.start) : [])
      setDecorations(e, top, several ? line(a.start) : [])
      setDecorations(e, bottom, several ? line(a.end) : [])
      setDecorations(e, mid, a && a.end > a.start + 1 ? [new vscode.Range(a.start + 1, 0, a.end - 1, 0)] : [])
    }
  }

  dispose(): void { this.sub.dispose(); for (const k of Object.values(this.kinds)) k.dispose() }
}
