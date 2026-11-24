import * as vscode from 'vscode'
import { setDecorations } from '../platform/editorDecorations'
import { fireAndForget } from '../platform/run'
import { HiddenCmd } from '../platform/commands'

// Links from a chat with Claude Code to code ("[names what it commits](src/check.ts#L812-L830)"): the lines they open
// are lit the way a journey's code links are, with "← Back" above them to where the reader was.
//
// Claude Code's VS Code extension opens such a link by showing the file and selecting its lines from the API: start
// line, column 0, to the end line, column 0 (a single line: the caret at its start). VS Code reports a selection set by
// an extension with no kind, unlike the keyboard, the mouse or a command, so that shape with no kind is taken as a
// link. A single line is taken only right after its editor came to the front (a caret put at a line start by another
// extension, in an editor already in front, is too common to light).
//
// The other way in: vscode://<publisher>.code-notes/link?file=<path>&start=<n>&end=<n> (for a terminal; its query is read by
// linkUri.ts linkTarget).

interface Spot { uri: vscode.Uri; line: number; character: number }

/**
 * A stretch of time in which selections are the extension's own doing. There are two, with different reach:
 * - `extensionSelects` (this module): any part of the extension (a step's caret, a note opened) is about to select
 *   (ownSelection); such a selection is never taken as a chat link, but it still moves "where the reader was".
 * - `ClaudeLinks.moving`: this class moves the caret itself (lighting lines, going Back); every selection and editor
 *   change meanwhile is ignored altogether.
 */
class OwnTime {
  private until = 0
  /** Ours for `ms` from now. */
  set(ms: number): void { this.until = Date.now() + ms }
  /** Ours for at least `ms` from now (a longer stretch already set stands). */
  extend(ms: number): void { this.until = Math.max(this.until, Date.now() + ms) }
  /** Still ours. */
  ours(): boolean { return Date.now() < this.until }
  /** Over (past its end). */
  over(): boolean { return Date.now() > this.until }
}

/** How long a selection after ownSelection() is the extension's own. */
const OWN_SELECTION_MS = 800
/** Lighting lines or going Back: the editor coming to the front and the caret move are ours for this long… */
const MOVE_IGNORE_MS = 300
/** …and once the lines are revealed, the reveal's own selection events for this long. */
const REVEAL_IGNORE_MS = 150
/** A single-line selection counts as a link only this soon after its editor came to the front. */
const FRONT_FRESH_MS = 1000

const extensionSelects = new OwnTime()
/** The extension is about to put the caret somewhere itself. */
export function ownSelection(ms = OWN_SELECTION_MS): void { extensionSelects.extend(ms) }

export class ClaudeLinks implements vscode.Disposable {
  private lit: { uri: string; start: number; end: number } | undefined
  private back: Spot | undefined
  /** Where the reader was, per editor, before anything a link did. */
  private last: Spot | undefined
  private frontAt = 0
  /** This class is moving the caret: every selection and editor change is its own doing (see OwnTime). */
  private readonly moving = new OwnTime()
  private readonly fill = vscode.window.createTextEditorDecorationType({
    isWholeLine: true, backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('symbolIcon.functionForeground'), overviewRulerLane: vscode.OverviewRulerLane.Center,
  })
  private readonly lens = new vscode.EventEmitter<void>()
  private lensSig = ''
  private readonly subs: vscode.Disposable[]

  constructor(private log: vscode.LogOutputChannel, private enabled: () => boolean) {
    this.subs = [this.fill, this.lens,
      vscode.window.onDidChangeVisibleTextEditors(() => this.paint()),
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        this.frontAt = Date.now()
        const elsewhere = !!this.lit && !!ed && ed.document.uri.scheme === 'file' && ed.document.uri.toString() !== this.lit.uri
        if (elsewhere && this.moving.over()) this.unlight()
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => this.selected(e)),
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, {
        onDidChangeCodeLenses: this.lens.event,
        provideCodeLenses: (doc) => {
          const l = this.lit
          if (!l || l.uri !== doc.uri.toString() || l.start >= doc.lineCount) return []
          return [new vscode.CodeLens(new vscode.Range(l.start, 0, l.start, 0), { title: this.back ? '$(arrow-left) Back' : '$(close) Clear', command: HiddenCmd.claudeLinkBack })]
        },
      }),
      vscode.commands.registerCommand(HiddenCmd.claudeLinkBack, () => this.goBack()),
    ]
  }

  private selected(e: vscode.TextEditorSelectionChangeEvent): void {
    const doc = e.textEditor.document, s = e.selections[0]
    if (doc.uri.scheme !== 'file' || !s || this.moving.ours()) return
    // Claude Code's shape: one selection from column 0 to column 0.
    const shape = e.selections.length === 1 && s.start.character === 0 && s.end.character === 0
    const fresh = Date.now() - this.frontAt < FRONT_FRESH_MS
    const lines = s.end.line > s.start.line
    // VS Code up to 1.14x reports a selection set by another extension with no kind: several lines, or a caret in an
    // editor that has just come to the front.
    const oldVsCode = e.kind === undefined && (lines || (s.isEmpty && fresh))
    // Newer ones say Command (as for Go to Definition): only several whole lines of an editor just come to the front.
    const newVsCode = e.kind === vscode.TextEditorSelectionChangeKind.Command && lines && fresh
    const notOurs = !extensionSelects.ours()
    const linkLike = this.enabled() && shape && notOurs && (oldVsCode || newVsCode)
    if (linkLike) {
      // Claude Code selects up to column 0 of the end line: the end line is the link's last line.
      fireAndForget(this.light(doc.uri, s.start.line, s.end.line, true), 'claudeChatLinks: light')
      return
    }
    // The reader moved: out of the lit lines ends them; anywhere, it is where Back returns to next time.
    const l = this.lit
    if (l && (doc.uri.toString() !== l.uri || s.active.line < l.start || s.active.line > l.end)) this.unlight()
    if (!this.lit) this.last = { uri: doc.uri, line: s.active.line, character: s.active.character }
  }

  /** Lights lines start..end (0-based, inclusive) of `uri`; `opened`: the editor already shows them. */
  async light(uri: vscode.Uri, start: number, end: number, opened = false): Promise<void> {
    const prev = this.last
    this.back = prev && !(prev.uri.toString() === uri.toString() && prev.line >= start && prev.line <= end) ? prev : undefined
    this.ignoreSelectionsFor(MOVE_IGNORE_MS)
    // The caret at the first line, nothing selected: the fill shows the lines, and typing never replaces them. (With
    // the show when it is needed: one call into the window, not a show and then a caret.)
    const caret = new vscode.Selection(start, 0, start, 0)
    const ed = opened ? vscode.window.visibleTextEditors.find((x) => x.document.uri.toString() === uri.toString())
      : await vscode.window.showTextDocument(uri, { preview: true, selection: caret })
    if (!ed) return
    end = Math.max(start, Math.min(end, ed.document.lineCount - 1))
    this.lit = { uri: uri.toString(), start, end }
    if (opened) ed.selection = caret
    ed.revealRange(new vscode.Range(start, 0, end, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
    this.ignoreSelectionsFor(REVEAL_IGNORE_MS)
    this.log.info(`claude link: ${vscode.workspace.asRelativePath(uri)}:${start + 1}-${end + 1}`)
    this.paint()
  }

  private async goBack(): Promise<void> {
    const b = this.back
    this.unlight()
    if (!b) return
    this.ignoreSelectionsFor(MOVE_IGNORE_MS)
    const ed = await vscode.window.showTextDocument(b.uri, { preview: false, selection: new vscode.Selection(b.line, b.character, b.line, b.character) })
    ed.revealRange(new vscode.Range(b.line, 0, b.line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
  }

  /** This class moves the caret itself: what it causes for `ms` is not the reader's. */
  private ignoreSelectionsFor(ms: number): void { this.moving.set(ms) }

  unlight(): void { if (this.lit) { this.lit = undefined; this.back = undefined; this.paint() } }

  private paint(): void {
    for (const e of vscode.window.visibleTextEditors) {
      const l = this.lit
      setDecorations(e, this.fill, l && l.uri === e.document.uri.toString() ? [new vscode.Range(l.start, 0, l.end, 0)] : [])
    }
    // The lens only when it changed (each change makes the window ask every visible editor again).
    const sig = JSON.stringify([this.lit, !!this.back])
    if (sig !== this.lensSig) { this.lensSig = sig; this.lens.fire() }
  }

  /** For tests. */
  get state(): { lit?: { uri: string; start: number; end: number }; back: boolean } { return { lit: this.lit && { ...this.lit }, back: !!this.back } }

  dispose(): void { for (const s of this.subs) s.dispose() }
}
