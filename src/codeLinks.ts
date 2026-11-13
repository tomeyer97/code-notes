import * as vscode from 'vscode'
import { StepLink } from './codeLinkText'
import { findLine, followLine, shiftLine } from './beatLine'

// Code links: a click on a linked phrase of the step's card lights that phrase's lines and brings them
// into view. Nothing is marked before a click (VS Code tells an extension nothing about hovering a link in a comment,
// and marking every linked segment all the time was too much).

/** Where the step's card hangs (its file, its 0-based line): a link into that file stays near it. */
export interface CardAt { uri: string; line: number }

export class CodeLinks implements vscode.Disposable {
  /** `visible`: the links whose phrase is on the card now (those behind "More" only while it is open). */
  private step: { key: string; folder: vscode.Uri; links: StepLink[]; renames: Map<string, string>; visible: Set<number> } | undefined
  /** Where each link's lines are now (by index), per file URI; missing: not found. */
  private at = new Map<number, { uri: string; start: number; end: number }>()
  private active = -1
  /** One look per meaning: a clicked link's lines carry a fill; the beat's line a bar (beats.ts), the step a tint. */
  private readonly strong = vscode.window.createTextEditorDecorationType({
    isWholeLine: true, backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('symbolIcon.functionForeground'), overviewRulerLane: vscode.OverviewRulerLane.Center,
  })
  private readonly subs: vscode.Disposable[]
  private seq = 0
  /** The way back, above the lit lines: "← Back to step 4"; only when the card is not on screen with them. */
  private backTitle = ''
  private back = false
  private readonly lens = new vscode.EventEmitter<void>()
  /** Something lit or the way back changed (value hints leave the Back row to it:). */
  readonly onDidChange = this.lens.event
  /** Selections this class makes itself, so they do not count as the reader moving away. */
  private own = 0
  private follow: ReturnType<typeof setTimeout> | undefined

  constructor(private log: vscode.LogOutputChannel) {
    this.subs = [this.strong, this.lens, vscode.window.onDidChangeVisibleTextEditors(() => this.paint()),
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, {
        onDidChangeCodeLenses: this.lens.event,
        provideCodeLenses: (doc) => {
          const b = this.backAt
          if (!b || b.uri !== doc.uri.toString() || b.line >= doc.lineCount) return []
          return [new vscode.CodeLens(new vscode.Range(b.line, 0, b.line, 0), { title: this.backTitle, command: 'codeNotes.codeLinkBack' })]
        },
      }),
      // VS Code's Go Back (or any move of the caret out of the lit lines, or to another file) ends the link.
      vscode.window.onDidChangeTextEditorSelection((e) => {
        const a = this.at.get(this.active)
        if (!a || Date.now() < this.own || e.textEditor.document.uri.scheme !== 'file') return
        const line = e.selections[0]?.active.line ?? -1
        if (e.textEditor.document.uri.toString() !== a.uri || line < a.start || line > a.end) this.unlight()
      }),
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        const a = this.at.get(this.active)
        if (a && ed && Date.now() >= this.own && ed.document.uri.scheme === 'file' && ed.document.uri.toString() !== a.uri) this.unlight()
      }),
      // The lines follow edits to their file: moved at once, their text checked once the typing pauses.
      vscode.workspace.onDidChangeTextDocument((e) => {
        const u = e.document.uri.toString()
        if (!e.contentChanges.length || ![...this.at.values()].some((a) => a.uri === u)) return
        const edits = e.contentChanges.map((c) => ({ start: c.range.start.line, end: c.range.end.line, text: c.text }))
        for (const a of this.at.values()) if (a.uri === u) { const len = a.end - a.start; a.start = shiftLine(a.start, edits); a.end = a.start + len }
        this.paint()
        clearTimeout(this.follow)
        this.follow = setTimeout(() => this.refind(e.document), 150)
      })]
  }

  private refind(doc: vscode.TextDocument): void {
    const u = doc.uri.toString(), links = this.step?.links
    if (!links) return
    const lines = Array.from({ length: doc.lineCount }, (_, k) => doc.lineAt(k).text)
    for (const [i, a] of [...this.at]) {
      if (a.uri !== u) continue
      const start = followLine(lines, a.start, links[i]?.text ?? '', [])
      if (start < 0) { this.at.delete(i); if (this.active === i) { this.active = -1; this.back = false } continue }
      a.end = Math.min(doc.lineCount - 1, start + (a.end - a.start)); a.start = start
    }
    this.paint()
  }

  /** The Back row's place, while it is shown: the lit lines' first line. */
  get backAt(): { uri: string; line: number } | undefined {
    const a = this.at.get(this.active)
    return a && this.back ? { uri: a.uri, line: a.start } : undefined
  }

  /** For tests. */
  get state(): { key?: string; active: number; at: Record<number, { uri: string; start: number; end: number }>; visible: number[]; back: boolean } {
    return { key: this.step?.key, active: this.active, at: Object.fromEntries([...this.at].map(([i, a]) => [i, { ...a }])), visible: [...(this.step?.visible ?? [])].sort(), back: !!this.backAt }
  }

  private paint(): void {
    for (const e of vscode.window.visibleTextEditors) {
      const u = e.document.uri.toString()
      // Only the clicked phrase's lines (nothing is marked passively; too much was lit).
      const a = this.at.get(this.active)
      e.setDecorations(this.strong, a && a.uri === u ? [new vscode.Range(a.start, 0, a.end, 0)] : [])
    }
    this.lens.fire()
  }

  private async locate(i: number): Promise<{ uri: vscode.Uri; start: number; end: number } | undefined> {
    const st = this.step, l = st?.links[i]
    if (!st || !l) return undefined
    const uri = vscode.Uri.joinPath(st.folder, st.renames.get(l.file) ?? l.file)
    let doc: vscode.TextDocument
    try { doc = await vscode.workspace.openTextDocument(uri) } catch { return undefined }
    const lines = Array.from({ length: doc.lineCount }, (_, k) => doc.lineAt(k).text)
    // No text to go by: the lines as written.
    const start = l.text.trim() ? findLine(lines, l.start, l.text) : Math.min(l.start, doc.lineCount) - 1
    if (start < 0) return undefined
    return { uri, start, end: Math.min(doc.lineCount - 1, start + (l.end - l.start)) }
  }

  /** The step shown (its card is being drawn): which of its phrases are on the card. The same step again changes nothing else. */
  present(key: string, folder: vscode.Uri, links: StepLink[], renames: Map<string, string>, visible: number[]): void {
    if (this.step?.key === key && JSON.stringify(this.step.links) === JSON.stringify(links)) {
      // The same step, drawn again (More opened or closed): only which phrases are on the card changed.
      this.step.visible = new Set(visible)
      if (this.active >= 0 && !this.step.visible.has(this.active)) { this.active = -1; this.back = false }
      this.paint()
      return
    }
    const mine = ++this.seq
    this.step = { key, folder, links, renames, visible: new Set(visible) }
    this.at.clear()
    this.active = -1
    this.back = false
    this.paint()
    void Promise.all(links.map((_l, i) => this.locate(i))).then((found) => {
      if (mine !== this.seq) return
      found.forEach((a, i) => { if (a) this.at.set(i, { uri: a.uri.toString(), start: a.start, end: a.end }); else this.log.info(`code link "${links[i].phrase}": its lines at ${links[i].file}:${links[i].start} changed; not marked`) })
      this.paint()
    })
  }

  /** Phrase `i` is the one lit now (a second click turns it off:). */
  isLit(key: string, i: number): boolean { return this.step?.key === key && this.active === i && i >= 0 }

  /**
   * A click on phrase `i`: its lines lit and in view, in the code group. A link into the card's own file scrolls as
   * little as it can, and needs no way back while the card is on screen with it.
   */
  async open(key: string, i: number, column: () => vscode.ViewColumn | undefined, backTitle: string, card?: CardAt): Promise<void> {
    if (this.step?.key !== key) return
    const a = await this.locate(i)
    if (!a) { void vscode.window.setStatusBarMessage('The code this phrase points at changed.', 4000); return }
    this.at.set(i, { uri: a.uri.toString(), start: a.start, end: a.end })
    this.active = i
    this.backTitle = backTitle
    this.back = false
    this.own = Date.now() + 400
    const col = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === a.uri.toString())?.viewColumn ?? column()
    const ed = await vscode.window.showTextDocument(a.uri, { preview: true, preserveFocus: false, ...(col ? { viewColumn: col } : {}) })
    ed.selection = new vscode.Selection(a.start, 0, a.start, 0)
    // Long enough for the events of this open and this caret to arrive; a move by the reader after counts.
    this.own = Date.now() + 150
    const same = !!card && card.uri === a.uri.toString()
    ed.revealRange(new vscode.Range(Math.max(0, a.start - 3), 0, Math.min(ed.document.lineCount - 1, a.end + 3), 0), same ? vscode.TextEditorRevealType.Default : vscode.TextEditorRevealType.InCenterIfOutsideViewport)
    this.paint()
    // The way back only when the card is not on screen with the lit lines (decided once the scroll has landed; a row
    // that came and went while reading would push the code about).
    await new Promise((r) => setTimeout(r, 120))
    if (this.active !== i || this.step?.key !== key) return
    this.back = !(same && ed.visibleRanges.some((r) => r.start.line <= card!.line && r.end.line >= card!.line))
    this.paint()
  }

  /** Back at the step: no phrase is lit (nothing stays marked). */
  unlight(): void { if (this.active >= 0) { this.active = -1; this.back = false; this.paint() } }

  clear(): void { this.seq++; this.step = undefined; this.at.clear(); this.active = -1; this.back = false; this.paint() }

  dispose(): void { clearTimeout(this.follow); for (const s of this.subs) s.dispose() }
}
