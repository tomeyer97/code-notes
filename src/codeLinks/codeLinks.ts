import * as vscode from 'vscode'
import { fileLines } from '../platform/documents'
import type { StepLink } from '../core/format/journeyModel'
import { TrackedLine, TrackedLines } from '../platform/followEdits'
import { showInCodeGroup, stepFileUri } from '../journeys/codeGroup'
import { fireAndForget } from '../platform/run'
import { HiddenCmd } from '../platform/commands'
import { Latest } from './latest'
import { lineChanged, locateStepLine, sameLinks } from './lines'
import { BackRow, LitLines, LitRange, outside, revealAround } from './litLines'

// Code links: a click on a linked phrase of the step's card lights that phrase's lines and brings them
// into view. Nothing is marked before a click (VS Code tells an extension nothing about hovering a link in a comment,
// and marking every linked segment all the time was too much).

/** Where the step's card hangs (its file, its 0-based line): a link into that file stays near it. */
export interface CardAt { uri: string; line: number }

/** How a click shows its lines. */
export interface OpenOptions {
  /** The Back row's words and tooltip; none: nowhere to go back to, no Back row. */
  back?: { title: string; tip?: string }
  /** Where the card is: a link into its file scrolls as little as it can, with no way back while the card shows. */
  card?: CardAt
  /** The lines are only lit: the caret and the keyboard stay where they are. */
  keepFocus?: boolean
}

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
/** How long the status bar says a link's code is gone. */
const GONE_MESSAGE_MS = 4000

export class CodeLinks implements vscode.Disposable {
  /** `visible`: the links whose phrase is on the card now (those behind "More" only while it is open). */
  private step: { key: string; folder: vscode.Uri; links: StepLink[]; renames: Map<string, string>; visible: Set<number> } | undefined
  /** Where each found link's lines are now; a link not found has none. They follow edits to their file. */
  private readonly found = new TrackedLines<FoundLink>(() => this.lit.paint(), {
    onFound: (f, doc) => { f.len = Math.min(doc.lineCount - 1, f.line + f.len) - f.line },
    onLost: (f) => { if (this.active === f.i) this.unlit() },
  })
  /** The clicked link (-1: none). */
  private active = -1
  /** The way back, above the lit lines: "← Back to step 4"; only when the card is not on screen with them. */
  private backRow: BackRow | undefined
  private readonly lit = new LitLines(() => this.linesOf(this.active), () => this.backRow)
  private readonly subs: vscode.Disposable[]
  /** The newest step presented wins (its links are looked for while the next may come). */
  private readonly latest = new Latest()
  /** Something lit or the way back changed (the one lens provider asks again: lenses.ts). */
  readonly onDidChange = this.lit.onDidChange

  constructor(private log: vscode.LogOutputChannel) {
    this.subs = [this.lit, this.found,
      vscode.window.onDidChangeTextEditorSelection((e) => this.onSelection(e)),
      vscode.window.onDidChangeActiveTextEditor((ed) => this.onActiveEditor(ed)),
    ]
  }

  /** Link `i`'s lines, when it was found. */
  private linesOf(i: number): LitRange | undefined {
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

  /** The Back row in `doc`, above the lit lines. */
  lenses(doc: vscode.TextDocument): vscode.CodeLens[] { return this.lit.lenses(doc) }

  /** VS Code's Go Back (or any move of the caret out of the lit lines, or to another file) ends the link. */
  private onSelection(e: vscode.TextEditorSelectionChangeEvent): void {
    const a = this.linesOf(this.active)
    if (!a || this.lit.own.ours() || e.textEditor.document.uri.scheme !== 'file') return
    if (outside(a, e.textEditor.document.uri.toString(), e.selections[0]?.active.line ?? -1)) this.unlight()
  }

  private onActiveEditor(ed: vscode.TextEditor | undefined): void {
    const a = this.linesOf(this.active)
    if (!a || !ed || this.lit.own.ours()) return
    if (ed.document.uri.scheme === 'file' && ed.document.uri.toString() !== a.uri) this.unlight()
  }

  /** The Back row's place, while it is shown: the lit lines' first line. */
  get backAt(): { uri: string; line: number } | undefined { return this.lit.backAt }

  /** For tests. */
  get state(): { key?: string; active: number; at: Record<number, LitRange>; visible: number[]; back: boolean } {
    const at = Object.fromEntries(this.found.items.map((f) => [f.i, this.linesOf(f.i)!]))
    return { key: this.step?.key, active: this.active, at, visible: [...(this.step?.visible ?? [])].sort(), back: !!this.backAt }
  }

  /** Where link `i`'s lines are in its file now, read without opening it. */
  private async locate(i: number): Promise<{ uri: vscode.Uri; start: number; end: number } | undefined> {
    const st = this.step, l = st?.links[i]
    if (!st || !l) return undefined
    const uri = stepFileUri(st.folder, st.renames, l.file)
    // Its lines without opening it (an open is a round trip to the window; the click's show opens it anyway).
    const lines = await fileLines(uri)
    if (!lines) return undefined
    const start = locateStepLine(lines, { line: l.start, text: l.text })
    if (start < 0) return undefined
    return { uri, start, end: Math.min(lines.length - 1, start + (l.end - l.start)) }
  }

  /** The step shown (its card is being drawn): which of its phrases are on the card. The same step again changes nothing else. */
  present(key: string, folder: vscode.Uri, links: StepLink[], renames: Map<string, string>, visible: number[]): void {
    if (this.step?.key === key && sameLinks(this.step.links, links)) {
      // The same step, drawn again (More opened or closed): only which phrases are on the card changed.
      this.step.visible = new Set(visible)
      if (this.active >= 0 && !this.step.visible.has(this.active)) this.unlit()
      this.lit.paint()
      return
    }
    const run = this.latest.begin()
    this.step = { key, folder, links, renames, visible: new Set(visible) }
    this.found.set([])
    this.unlit()
    this.lit.paint()
    fireAndForget(Promise.all(links.map((_l, i) => this.locate(i))).then((found) => {
      if (!run.current) return
      found.forEach((a, i) => {
        const l = links[i]
        if (a) this.setFound(i, a, l.text)
        else this.log.info(lineChanged(`code link "${l.phrase}"`, `its lines at ${l.file}:${l.start}`, 'not marked'))
      })
      this.lit.paint()
    }), 'codeLinks: Promise.all')
  }

  /** Phrase `i` is the one lit now (a second click turns it off:). */
  isLit(key: string, i: number): boolean { return this.step?.key === key && this.active === i && i >= 0 }

  /** Phrase `i` of step `key` is still the one lit (a newer click or step may have come during an await). */
  private stillCurrent(key: string, i: number): boolean { return this.active === i && this.step?.key === key }

  /**
   * A click on phrase `i`: its lines lit and in view, in the code group, then the way back decided. A link into the
   * card's own file scrolls as little as it can, and needs no way back while the card is on screen with it.
   */
  async open(key: string, i: number, column: () => vscode.ViewColumn | undefined, o: OpenOptions = {}): Promise<void> {
    if (this.step?.key !== key) return
    const shown = await this.lightAndShow(i, column, o)
    if (!shown) return
    // Decided once the scroll has landed: a row that came and went while reading would push the code about.
    if (shown.scrolled) await shown.scrolled
    if (!this.stillCurrent(key, i)) return
    this.backRow = this.decideBackRow(shown.ed, o)
    this.lit.paint()
  }

  /** Phrase `i`'s lines lit and shown; `scrolled`: settles once a scroll the card's file needs has landed. */
  private async lightAndShow(i: number, column: () => vscode.ViewColumn | undefined, o: OpenOptions): Promise<{ ed: vscode.TextEditor; scrolled?: Promise<void> } | undefined> {
    const text = this.step?.links[i]?.text ?? ''
    const a = await this.locate(i)
    if (!a) {
      void vscode.window.setStatusBarMessage('The code this phrase points at changed.', GONE_MESSAGE_MS)
      return undefined
    }
    this.setFound(i, a, text)
    this.active = i
    this.backRow = undefined
    this.lit.own.set(OWN_OPEN_MS)
    const keepFocus = !!o.keepFocus
    // On screen already and the keyboard stays where it is: nothing to show (no wait for the window), only lit and
    // scrolled. Otherwise the caret goes with the show (one call, not a show and then a caret).
    const selection = keepFocus ? undefined : new vscode.Selection(a.start, 0, a.start, 0)
    const ed = await showInCodeGroup(a.uri, column, { keepFocus, reuseVisible: keepFocus, selection })
    this.lit.own.set(OWN_AFTER_SHOW_MS)
    const same = o.card?.uri === a.uri.toString()
    const want = new vscode.Range(Math.max(0, a.start - REVEAL_MARGIN), 0, Math.min(ed.document.lineCount - 1, a.end + REVEAL_MARGIN), 0)
    // Will the editor scroll? Only then is there anything to wait for before the way back is decided.
    const scrolls = !ed.visibleRanges.some((r) => r.contains(want))
    const scrolled = same && scrolls ? waitForScroll(ed) : undefined
    revealAround(ed, a.start, a.end, REVEAL_MARGIN, same ? vscode.TextEditorRevealType.Default : vscode.TextEditorRevealType.InCenterIfOutsideViewport)
    this.lit.paint()
    return { ed, scrolled }
  }

  /** The Back row only when the card is not on screen with the lit lines (another file: out of sight). */
  private decideBackRow(ed: vscode.TextEditor, o: OpenOptions): BackRow | undefined {
    const card = o.card
    const cardShown = !!card && card.uri === ed.document.uri.toString() && cardInView(ed, card)
    if (!o.back?.title || cardShown) return undefined
    return { title: o.back.title, command: HiddenCmd.codeLinkBack, tooltip: o.back.tip ?? '' }
  }

  /** Back at the step: no phrase is lit (nothing stays marked). */
  unlight(): void {
    if (this.active < 0) return
    this.unlit()
    this.lit.paint()
  }

  clear(): void {
    this.latest.cancel()
    this.step = undefined
    this.found.set([])
    this.unlit()
    this.lit.paint()
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
