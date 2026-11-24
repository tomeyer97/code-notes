import * as vscode from 'vscode'
import { setDecorations } from '../platform/editorDecorations'
import { fileLines } from '../platform/documents'
import type { StepLink } from '../core/format/journeyModel'
import { findLine } from '../core/anchors/lineFollow'
import { TrackedLine, TrackedLines } from '../platform/followEdits'
import { showInCodeGroup, stepFileUri } from '../journeys/codeGroup'
import { fireAndForget } from '../platform/run'
import { HiddenCmd } from '../platform/commands'

// Code links: a click on a linked phrase of the step's card lights that phrase's lines and brings them
// into view. Nothing is marked before a click (VS Code tells an extension nothing about hovering a link in a comment,
// and marking every linked segment all the time was too much).

/** Where the step's card hangs (its file, its 0-based line): a link into that file stays near it. */
export interface CardAt { uri: string; line: number }

/** Where a link's lines are now: 0-based, inclusive. */
type LinkLines = { uri: string; start: number; end: number }
/** Link `i`'s lines as followed through edits: they start at `line` and run `len` lines further. */
interface FoundLink extends TrackedLine { i: number; len: number }

/** A click's own selection events (the editor coming to the front, the caret) arrive within this long… */
const OWN_OPEN_MS = 400
/** …and, once the document is shown, the caret's own; a move by the reader after that counts. */
const OWN_AFTER_SHOW_MS = 150
/** How long to wait for a scroll to land before the way back is decided without it. */
const SCROLL_WAIT_MS = 1000
/** Lines kept in view above and below the lit lines. */
const REVEAL_MARGIN = 3

export class CodeLinks implements vscode.Disposable {
  /** `visible`: the links whose phrase is on the card now (those behind "More" only while it is open). */
  private step: { key: string; folder: vscode.Uri; links: StepLink[]; renames: Map<string, string>; visible: Set<number> } | undefined
  /** Where each found link's lines are now; a link not found has none. They follow edits to their file. */
  private readonly found = new TrackedLines<FoundLink>(() => this.paint(), {
    onFound: (f, doc) => { f.len = Math.min(doc.lineCount - 1, f.line + f.len) - f.line },
    onLost: (f) => { if (this.active === f.i) this.unlit() },
  })
  /** The clicked link (-1: none). */
  private active = -1
  /** The way back, above the lit lines: "← Back to step 4"; only when the card is not on screen with them. */
  private backRow: { title: string; tip: string } | undefined
  /** One look per meaning: a clicked link's lines carry a fill; the beat's line a bar (beats.ts), the step a tint. */
  private readonly strong = vscode.window.createTextEditorDecorationType({
    isWholeLine: true, backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('symbolIcon.functionForeground'), overviewRulerLane: vscode.OverviewRulerLane.Center,
  })
  private readonly subs: vscode.Disposable[]
  /** The newest step presented wins (its links are looked for while the next may come). */
  private seq = 0
  private readonly lens = new vscode.EventEmitter<void>()
  /** Something lit or the way back changed (value hints leave the Back row to it:). */
  readonly onDidChange = this.lens.event
  /** What the lenses showed last: they are asked for again only when it changes. */
  private lensSig = ''
  /** Selections this class makes itself, until this time, do not count as the reader moving away. */
  private own = 0

  constructor(private log: vscode.LogOutputChannel) {
    const backLenses = { onDidChangeCodeLenses: this.lens.event, provideCodeLenses: (doc: vscode.TextDocument) => this.backLens(doc) }
    this.subs = [this.strong, this.lens, this.found,
      vscode.window.onDidChangeVisibleTextEditors(() => this.paint()),
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, backLenses),
      vscode.window.onDidChangeTextEditorSelection((e) => this.onSelection(e)),
      vscode.window.onDidChangeActiveTextEditor((ed) => this.onActiveEditor(ed)),
    ]
  }

  /** Link `i`'s lines, when it was found. */
  private linesOf(i: number): LinkLines | undefined {
    const f = this.found.items.find((x) => x.i === i)
    return f && { uri: f.uri, start: f.line, end: f.line + f.len }
  }

  /** Link `i` was found at `a` (again). */
  private setFound(i: number, a: { uri: vscode.Uri; start: number; end: number }, text: string): void {
    const f: FoundLink = { i, uri: a.uri.toString(), line: a.start, len: a.end - a.start, text }
    const known = this.found.items.some((x) => x.i === i)
    this.found.set(known ? this.found.items.map((x) => (x.i === i ? f : x)) : [...this.found.items, f])
  }

  /** No link is lit (no way back either); nothing repainted. */
  private unlit(): void {
    this.active = -1
    this.backRow = undefined
  }

  /** The Back row, above the lit lines. */
  private backLens(doc: vscode.TextDocument): vscode.CodeLens[] {
    const b = this.backAt
    if (!b || !this.backRow || b.uri !== doc.uri.toString() || b.line >= doc.lineCount) return []
    const { title, tip } = this.backRow
    const command = { title, command: HiddenCmd.codeLinkBack, ...(tip ? { tooltip: tip } : {}) }
    return [new vscode.CodeLens(new vscode.Range(b.line, 0, b.line, 0), command)]
  }

  /** VS Code's Go Back (or any move of the caret out of the lit lines, or to another file) ends the link. */
  private onSelection(e: vscode.TextEditorSelectionChangeEvent): void {
    const a = this.linesOf(this.active)
    if (!a || Date.now() < this.own || e.textEditor.document.uri.scheme !== 'file') return
    const line = e.selections[0]?.active.line ?? -1
    if (e.textEditor.document.uri.toString() !== a.uri || line < a.start || line > a.end) this.unlight()
  }

  private onActiveEditor(ed: vscode.TextEditor | undefined): void {
    const a = this.linesOf(this.active)
    if (!a || !ed || Date.now() < this.own) return
    if (ed.document.uri.scheme === 'file' && ed.document.uri.toString() !== a.uri) this.unlight()
  }

  /** The Back row's place, while it is shown: the lit lines' first line. */
  get backAt(): { uri: string; line: number } | undefined {
    const a = this.linesOf(this.active)
    return a && this.backRow ? { uri: a.uri, line: a.start } : undefined
  }

  /** For tests. */
  get state(): { key?: string; active: number; at: Record<number, LinkLines>; visible: number[]; back: boolean } {
    const at = Object.fromEntries(this.found.items.map((f) => [f.i, this.linesOf(f.i)!]))
    return { key: this.step?.key, active: this.active, at, visible: [...(this.step?.visible ?? [])].sort(), back: !!this.backAt }
  }

  private paint(): void {
    // Only the clicked phrase's lines (nothing is marked passively; too much was lit).
    const a = this.linesOf(this.active)
    for (const e of vscode.window.visibleTextEditors) {
      const on = a && a.uri === e.document.uri.toString()
      setDecorations(e, this.strong, on ? [new vscode.Range(a.start, 0, a.end, 0)] : [])
    }
    // The lenses only when what they show changed (each change makes the window ask every visible editor again).
    const sig = JSON.stringify([this.backAt, this.backRow?.title, this.active, a])
    if (sig !== this.lensSig) {
      this.lensSig = sig
      this.lens.fire()
    }
  }

  /** Where link `i`'s lines are in its file now, read without opening it. */
  private async locate(i: number): Promise<{ uri: vscode.Uri; start: number; end: number } | undefined> {
    const st = this.step, l = st?.links[i]
    if (!st || !l) return undefined
    const uri = stepFileUri(st.folder, st.renames, l.file)
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
      if (this.active >= 0 && !this.step.visible.has(this.active)) this.unlit()
      this.paint()
      return
    }
    const mine = ++this.seq
    this.step = { key, folder, links, renames, visible: new Set(visible) }
    this.found.set([])
    this.unlit()
    this.paint()
    fireAndForget(Promise.all(links.map((_l, i) => this.locate(i))).then((found) => {
      if (mine !== this.seq) return
      found.forEach((a, i) => {
        if (a) this.setFound(i, a, links[i].text)
        else this.log.info(`code link "${links[i].phrase}": its lines at ${links[i].file}:${links[i].start} changed; not marked`)
      })
      this.paint()
    }), 'codeLinks: Promise.all')
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
    const text = this.step.links[i]?.text ?? ''
    const a = await this.locate(i)
    if (!a) {
      void vscode.window.setStatusBarMessage('The code this phrase points at changed.', 4000)
      return
    }
    this.setFound(i, a, text)
    this.active = i
    this.backRow = undefined
    this.own = Date.now() + OWN_OPEN_MS
    const keepFocus = !!o.keepFocus
    // On screen already and the keyboard stays where it is: nothing to show (no wait for the window), only lit and
    // scrolled. Otherwise the caret goes with the show (one call, not a show and then a caret).
    const selection = keepFocus ? undefined : new vscode.Selection(a.start, 0, a.start, 0)
    const ed = await showInCodeGroup(a.uri, column, { keepFocus, reuseVisible: keepFocus, selection })
    this.own = Date.now() + OWN_AFTER_SHOW_MS
    const same = !!card && card.uri === a.uri.toString()
    const want = new vscode.Range(Math.max(0, a.start - REVEAL_MARGIN), 0, Math.min(ed.document.lineCount - 1, a.end + REVEAL_MARGIN), 0)
    // Will the editor scroll? Only then is there anything to wait for before the way back is decided.
    const scrolls = !ed.visibleRanges.some((r) => r.contains(want))
    const scrolled = same && scrolls ? waitForScroll(ed) : undefined
    ed.revealRange(want, same ? vscode.TextEditorRevealType.Default : vscode.TextEditorRevealType.InCenterIfOutsideViewport)
    this.paint()
    // The way back only when the card is not on screen with the lit lines (decided once the scroll has landed; a row
    // that came and went while reading would push the code about). Another file: the card is out of sight. No title:
    // nowhere to go back to, no Back row.
    if (scrolled) await scrolled
    if (this.active !== i || this.step?.key !== key) return
    const cardShown = same && cardInView(ed, card!)
    this.backRow = backTitle && !cardShown ? { title: backTitle, tip: o.backTip ?? '' } : undefined
    this.paint()
  }

  /** Back at the step: no phrase is lit (nothing stays marked). */
  unlight(): void {
    if (this.active < 0) return
    this.unlit()
    this.paint()
  }

  clear(): void {
    this.seq++
    this.step = undefined
    this.found.set([])
    this.unlit()
    this.paint()
  }

  dispose(): void { for (const s of this.subs) s.dispose() }
}

/** Resolves once `ed` scrolled, or after SCROLL_WAIT_MS when it doesn't. Start it before the reveal. */
function waitForScroll(ed: vscode.TextEditor): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => { clearTimeout(t); sub.dispose(); resolve() }
    const sub = vscode.window.onDidChangeTextEditorVisibleRanges((e) => { if (e.textEditor === ed) done() })
    const t = setTimeout(done, SCROLL_WAIT_MS)
  })
}

/** The card's line is on screen in `ed`. */
function cardInView(ed: vscode.TextEditor, card: CardAt): boolean {
  return ed.visibleRanges.some((r) => r.start.line <= card.line && r.end.line >= card.line)
}
