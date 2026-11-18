import * as vscode from 'vscode'
import { setDecorations } from './decorations'
import { fileLines } from './documents'
import { ownSelection } from './claudeChatLinks'
import { StepLink } from './codeLinkText'
import { LineEdit, findLine, followLine, shiftLine } from './beatLine'
import { EditFollower } from './followEdits'

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
  private backTip = ''
  private back = false
  private readonly lens = new vscode.EventEmitter<void>()
  /** Something lit or the way back changed (value hints leave the Back row to it:). */
  readonly onDidChange = this.lens.event
  /** Selections this class makes itself, so they do not count as the reader moving away. */
  private own = 0

  constructor(private log: vscode.LogOutputChannel) {
    this.subs = [this.strong, this.lens,
      vscode.window.onDidChangeVisibleTextEditors(() => this.paint()),
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, { onDidChangeCodeLenses: this.lens.event, provideCodeLenses: (doc) => this.backLens(doc) }),
      vscode.window.onDidChangeTextEditorSelection((e) => this.onSelection(e)),
      vscode.window.onDidChangeActiveTextEditor((ed) => this.onActiveEditor(ed)),
      // The lit lines follow edits to their file.
      new EditFollower((uri) => [...this.at.values()].some((a) => a.uri === uri), (edits, uri) => this.shift(uri, edits), (doc, lines) => this.refind(doc, lines)),
    ]
  }

  /** The Back row, above the lit lines. */
  private backLens(doc: vscode.TextDocument): vscode.CodeLens[] {
    const b = this.backAt
    if (!b || b.uri !== doc.uri.toString() || b.line >= doc.lineCount) return []
    return [new vscode.CodeLens(new vscode.Range(b.line, 0, b.line, 0), { title: this.backTitle, command: 'codeNotes.codeLinkBack', ...(this.backTip ? { tooltip: this.backTip } : {}) })]
  }

  /** VS Code's Go Back (or any move of the caret out of the lit lines, or to another file) ends the link. */
  private onSelection(e: vscode.TextEditorSelectionChangeEvent): void {
    const a = this.at.get(this.active)
    if (!a || Date.now() < this.own || e.textEditor.document.uri.scheme !== 'file') return
    const line = e.selections[0]?.active.line ?? -1
    if (e.textEditor.document.uri.toString() !== a.uri || line < a.start || line > a.end) this.unlight()
  }

  private onActiveEditor(ed: vscode.TextEditor | undefined): void {
    const a = this.at.get(this.active)
    if (a && ed && Date.now() >= this.own && ed.document.uri.scheme === 'file' && ed.document.uri.toString() !== a.uri) this.unlight()
  }

  private shift(uri: string, edits: LineEdit[]): void {
    for (const a of this.at.values()) {
      if (a.uri !== uri) continue
      const len = a.end - a.start
      a.start = shiftLine(a.start, edits)
      a.end = a.start + len
    }
    this.paint()
  }

  private refind(doc: vscode.TextDocument, lines: string[]): void {
    const u = doc.uri.toString(), links = this.step?.links
    if (!links) return
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
      setDecorations(e, this.strong, a && a.uri === u ? [new vscode.Range(a.start, 0, a.end, 0)] : [])
    }
    // The lenses only when what they show changed (each change makes the window ask every visible editor again).
    const sig = JSON.stringify([this.backAt, this.backTitle, this.active, this.at.get(this.active)])
    if (sig !== this.lensSig) { this.lensSig = sig; this.lens.fire() }
  }
  private lensSig = ''

  private async locate(i: number): Promise<{ uri: vscode.Uri; start: number; end: number } | undefined> {
    const st = this.step, l = st?.links[i]
    if (!st || !l) return undefined
    const uri = vscode.Uri.joinPath(st.folder, st.renames.get(l.file) ?? l.file)
    // Its lines without opening it (an open is a round trip to the window; the click's show opens it anyway).
    const lines = await fileLines(uri)
    if (!lines) return undefined
    // No text to go by: the lines as written.
    const start = l.text.trim() ? findLine(lines, l.start, l.text) : Math.min(l.start, lines.length) - 1
    if (start < 0) return undefined
    return { uri, start, end: Math.min(lines.length - 1, start + (l.end - l.start)) }
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
   * little as it can, and needs no way back while the card is on screen with it. `keepFocus`: the lines are only
   * lit, the caret and the keyboard stay where they are (a link in a thread being answered: typing must never land in
   * the code).
   */
  async open(key: string, i: number, column: () => vscode.ViewColumn | undefined, backTitle: string, card?: CardAt, o: { keepFocus?: boolean; backTip?: string } = {}): Promise<void> {
    if (this.step?.key !== key) return
    const a = await this.locate(i)
    if (!a) { void vscode.window.setStatusBarMessage('The code this phrase points at changed.', 4000); return }
    this.at.set(i, { uri: a.uri.toString(), start: a.start, end: a.end })
    this.active = i
    // No title: nowhere to go back to, no Back row.
    this.backTitle = backTitle
    this.backTip = o.backTip ?? ''
    this.back = false
    this.own = Date.now() + 400
    ownSelection()
    const shown = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === a.uri.toString())
    const col = shown?.viewColumn ?? column()
    // On screen already and the keyboard stays where it is: nothing to show (no wait for the window), only lit and
    // scrolled. Otherwise the caret goes with the show (one call, not a show and then a caret).
    const ed = shown && o.keepFocus ? shown
      : await vscode.window.showTextDocument(a.uri, { preview: true, preserveFocus: !!o.keepFocus, ...(col ? { viewColumn: col } : {}), ...(o.keepFocus ? {} : { selection: new vscode.Selection(a.start, 0, a.start, 0) }) })
    // Long enough for the events of this open and this caret to arrive; a move by the reader after counts.
    this.own = Date.now() + 150
    const same = !!card && card.uri === a.uri.toString()
    const want = new vscode.Range(Math.max(0, a.start - 3), 0, Math.min(ed.document.lineCount - 1, a.end + 3), 0)
    // Will the editor scroll? Only then is there anything to wait for before the way back is decided.
    const scrolls = !ed.visibleRanges.some((r) => r.contains(want))
    const scrolled = same && scrolls ? new Promise<void>((resolve) => {
      const done = () => { clearTimeout(t); sub.dispose(); resolve() }
      const sub = vscode.window.onDidChangeTextEditorVisibleRanges((e) => { if (e.textEditor === ed) done() })
      const t = setTimeout(done, 1000)
    }) : undefined
    ed.revealRange(want, same ? vscode.TextEditorRevealType.Default : vscode.TextEditorRevealType.InCenterIfOutsideViewport)
    this.paint()
    // The way back only when the card is not on screen with the lit lines (decided once the scroll has landed; a row
    // that came and went while reading would push the code about). Another file: the card is out of sight.
    if (scrolled) await scrolled
    if (this.active !== i || this.step?.key !== key) return
    this.back = !!this.backTitle && !(same && ed.visibleRanges.some((r) => r.start.line <= card!.line && r.end.line >= card!.line))
    this.paint()
  }

  /** Back at the step: no phrase is lit (nothing stays marked). */
  unlight(): void { if (this.active >= 0) { this.active = -1; this.back = false; this.paint() } }

  clear(): void { this.seq++; this.step = undefined; this.at.clear(); this.active = -1; this.back = false; this.paint() }

  dispose(): void { for (const s of this.subs) s.dispose() }
}
