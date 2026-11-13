import * as vscode from 'vscode'

// The tutorial's card about the step card (the tutorial shows things in the editor too): while it is up, the
// step's lines in the editor are boxed, so the eyes land on the card that sits right above them. An extension can't
// draw on the card itself (a comment thread), only on code lines.

export class TutorialSpot implements vscode.Disposable {
  private readonly color = new vscode.ThemeColor('focusBorder')
  private readonly kinds = (['1px 1px 0 1px', '0 1px', '0 1px 1px 1px', '1px'] as const).map((borderWidth) =>
    vscode.window.createTextEditorDecorationType({ isWholeLine: true, borderStyle: 'solid', borderColor: this.color, borderWidth }))
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
      const [top, mid, bottom, one] = this.kinds
      e.setDecorations(one, a && a.start === a.end ? line(a.start) : [])
      e.setDecorations(top, a && a.end > a.start ? line(a.start) : [])
      e.setDecorations(bottom, a && a.end > a.start ? line(a.end) : [])
      e.setDecorations(mid, a && a.end > a.start + 1 ? [new vscode.Range(a.start + 1, 0, a.end - 1, 0)] : [])
    }
  }

  dispose(): void { this.sub.dispose(); for (const k of this.kinds) k.dispose() }
}
