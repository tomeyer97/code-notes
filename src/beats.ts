import * as vscode from 'vscode'
import { JBeat } from './journeyModel'
import { findLine, followLine, shiftLine } from './beatLine'

// A step's animation: the beat on screen lights the one line that does what it shows, nothing else
// (values are the step's value hints: valueHints.ts).

/** What a beat request did: lit its line, lit nothing (no code, or its line is gone), or a newer request took over. */
export type BeatShown = 'lit' | 'none' | 'superseded'

export class Beats implements vscode.Disposable {
  private here: { uri: string; line: number; text: string } | undefined
  /**
   * One look per meaning: the step's lines have a thin bar and a faint tint, a clicked code link a fill
   * (codeLinks.ts); the beat's line a box with a thick left edge in the cursor's colour and no fill, so it reads as
   * "here, now" over the step's tint and never as a link. Theme colours only.
   */
  private readonly deco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true, borderWidth: '1px 1px 1px 4px', borderStyle: 'solid', borderColor: new vscode.ThemeColor('editorCursor.foreground'),
    overviewRulerColor: new vscode.ThemeColor('editorCursor.foreground'), overviewRulerLane: vscode.OverviewRulerLane.Center,
  })
  private readonly subs: vscode.Disposable[]
  /** The newest request wins (beats can be stepped through faster than files open). */
  private seq = 0
  private follow: ReturnType<typeof setTimeout> | undefined

  constructor(private log: vscode.LogOutputChannel) {
    this.subs = [
      this.deco,
      vscode.window.onDidChangeVisibleTextEditors(() => this.paint()),
      // The lit line follows edits to its file.
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (!this.here || e.document.uri.toString() !== this.here.uri || !e.contentChanges.length) return
        // Moved at once by the lines added or removed above it; its text checked once the typing pauses.
        this.here.line = shiftLine(this.here.line, e.contentChanges.map((c) => ({ start: c.range.start.line, end: c.range.end.line, text: c.text })))
        this.paint()
        clearTimeout(this.follow)
        this.follow = setTimeout(() => this.refind(e.document), 150)
      }),
    ]
  }

  private refind(doc: vscode.TextDocument): void {
    const h = this.here
    if (!h || doc.uri.toString() !== h.uri) return
    const lines = Array.from({ length: doc.lineCount }, (_, i) => doc.lineAt(i).text)
    const at = followLine(lines, h.line, h.text, [])
    this.here = at < 0 ? undefined : { ...h, line: at }
    this.paint()
  }

  /** The lit line with a few lines around it (1-based numbers), as last found; nothing lit: nothing. */
  get preview(): { file: string; line: number; from: number; lines: string[] } | undefined { return this.here ? this.around : undefined }
  private around: { file: string; line: number; from: number; lines: string[] } | undefined

  /** For tests: what is lit. */
  get lit(): { uri: string; line: number } | undefined { return this.here && { uri: this.here.uri, line: this.here.line } }

  private paint(): void {
    for (const e of vscode.window.visibleTextEditors) {
      e.setDecorations(this.deco, this.here && e.document.uri.toString() === this.here.uri ? [new vscode.Range(this.here.line, 0, this.here.line, 0)] : [])
    }
  }

  /** Nothing lit; a request still opening its file is dropped. */
  clear(): void { this.seq++; clearTimeout(this.follow); if (this.here) { this.here = undefined; this.paint() } }

  /** Lights the beat's line in the code group (the panel keeps the focus); no beat, or no code: nothing is lit. */
  async show(folder: vscode.Uri, beat: JBeat | undefined, renames: Map<string, string>, column: () => vscode.ViewColumn | undefined): Promise<BeatShown> {
    const mine = ++this.seq
    const c = beat?.code
    const none = (): BeatShown => { this.here = undefined; this.paint(); return 'none' }
    if (!c || typeof c.file !== 'string' || !Number.isInteger(c.line)) return none()
    const uri = vscode.Uri.joinPath(folder, renames.get(c.file) ?? c.file)
    let doc: vscode.TextDocument
    try { doc = await vscode.workspace.openTextDocument(uri) } catch { this.log.info(`animation: ${c.file} can't be opened`); return mine === this.seq ? none() : 'superseded' }
    if (mine !== this.seq) return 'superseded'
    const lines = Array.from({ length: doc.lineCount }, (_, i) => doc.lineAt(i).text)
    const at = findLine(lines, c.line, String(c.text ?? ''))
    if (at < 0) { this.log.info(`animation: the line at ${c.file}:${c.line} changed; nothing lit`); return none() }
    this.here = { uri: uri.toString(), line: at, text: String(c.text ?? '') }
    // The lines around it, for the panel's own small view of the code (no looking left and right).
    const from = Math.max(0, at - 3), to = Math.min(lines.length - 1, at + 3)
    this.around = { file: c.file, line: at + 1, from: from + 1, lines: lines.slice(from, to + 1) }
    return (await this.bring(doc, column)) ? 'lit' : 'superseded'
  }

  /** The lit line on screen again (the step's own reveal ran after it:). */
  async again(column: () => vscode.ViewColumn | undefined): Promise<void> {
    if (!this.here) return
    const mine = this.seq
    let doc: vscode.TextDocument
    try { doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(this.here.uri)) } catch { return }
    if (mine === this.seq) await this.bring(doc, column)
  }

  private async bring(doc: vscode.TextDocument, column: () => vscode.ViewColumn | undefined): Promise<boolean> {
    const mine = this.seq
    const col = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === doc.uri.toString())?.viewColumn ?? column()
    const ed = await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true, ...(col ? { viewColumn: col } : {}) })
    if (mine !== this.seq || !this.here) return false
    const at = this.here.line
    // The caret on the lit line: one lit line, never the current-line band left elsewhere by the step.
    ed.selection = new vscode.Selection(at, 0, at, 0)
    ed.revealRange(new vscode.Range(Math.max(0, at - 6), 0, Math.min(doc.lineCount - 1, at + 6), 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
    this.paint()
    return true
  }

  dispose(): void { clearTimeout(this.follow); for (const s of this.subs) s.dispose() }
}
