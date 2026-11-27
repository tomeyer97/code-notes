import * as vscode from 'vscode'
import { fireAndForget } from '../platform/run'
import { HiddenCmd } from '../platform/commands'
import { isLinkSelection, SelectionKind } from './chatLinkGuess'
import { BackRow, LitLines, LitRange, outside, OwnTime } from './litLines'

// Links from a chat with Claude Code to code ("[names what it commits](src/check.ts#L812-L830)"): the lines they open
// are lit the way a journey's code links are, with "← Back" above them to where the reader was. Which selections are
// such links: chatLinkGuess.ts.
//
// The other way in: vscode://<publisher>.code-notes/link?file=<path>&start=<n>&end=<n> (for a terminal; its query is read by
// linkUri.ts linkTarget).

interface Spot { uri: vscode.Uri; line: number; character: number }

/** How long a selection after ownSelection() is the extension's own. */
const OWN_SELECTION_MS = 800
/** Lighting lines or going Back: the editor coming to the front and the caret move are ours for this long… */
const MOVE_IGNORE_MS = 300
/** …and once the lines are revealed, the reveal's own selection events for this long. */
const REVEAL_IGNORE_MS = 150
/** A single-line selection counts as a link only this soon after its editor came to the front. */
const FRONT_FRESH_MS = 1000

/**
 * Any part of the extension (a step's caret, a note opened) is about to select: such a selection is never taken as a
 * chat link, but it still moves "where the reader was". (ClaudeLinks' own moves are ignored altogether: LitLines.own.)
 */
const extensionSelects = new OwnTime()
/** The extension is about to put the caret somewhere itself. */
export function ownSelection(ms = OWN_SELECTION_MS): void { extensionSelects.extend(ms) }

const kindOf = (k: vscode.TextEditorSelectionChangeKind | undefined): SelectionKind =>
  k === undefined ? 'none' : k === vscode.TextEditorSelectionChangeKind.Command ? 'command' : 'other'

export class ClaudeLinks implements vscode.Disposable {
  private litNow: LitRange | undefined
  private back: Spot | undefined
  /** Where the reader was, per editor, before anything a link did. */
  private last: Spot | undefined
  private frontAt = 0
  /** Selection events seen (tests wait for one instead of a fixed time). */
  private selections = 0
  private readonly lit = new LitLines(() => this.litNow, (): BackRow => ({ title: this.back ? '$(arrow-left) Back' : '$(close) Clear', command: HiddenCmd.claudeLinkBack }))
  /** The Back row changed (the one lens provider asks again: lenses.ts). */
  readonly onDidChange = this.lit.onDidChange
  private readonly subs: vscode.Disposable[]

  constructor(private log: vscode.LogOutputChannel, private enabled: () => boolean) {
    this.subs = [this.lit,
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        this.frontAt = Date.now()
        const elsewhere = !!this.litNow && !!ed && ed.document.uri.scheme === 'file' && ed.document.uri.toString() !== this.litNow.uri
        if (elsewhere && this.lit.own.over()) this.unlight()
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => this.selected(e)),
    ]
  }

  /** The Back (or Clear) row in `doc`, above the lit lines. */
  lenses(doc: vscode.TextDocument): vscode.CodeLens[] { return this.lit.lenses(doc) }

  private selected(e: vscode.TextEditorSelectionChangeEvent): void {
    this.selections++
    const doc = e.textEditor.document, s = e.selections[0]
    if (doc.uri.scheme !== 'file' || !s || this.lit.own.ours()) return
    const link = this.enabled() && isLinkSelection({
      kind: kindOf(e.kind),
      shape: e.selections.length === 1 && s.start.character === 0 && s.end.character === 0,
      lines: s.end.line > s.start.line,
      caret: s.isEmpty,
      fresh: Date.now() - this.frontAt < FRONT_FRESH_MS,
      ours: extensionSelects.ours(),
    })
    if (link) {
      // Claude Code selects up to column 0 of the end line: the end line is the link's last line.
      fireAndForget(this.light(doc.uri, s.start.line, s.end.line, true), 'claudeChatLinks: light')
      return
    }
    // The reader moved: out of the lit lines ends them; anywhere, it is where Back returns to next time.
    if (this.litNow && outside(this.litNow, doc.uri.toString(), s.active.line)) this.unlight()
    if (!this.litNow) this.last = { uri: doc.uri, line: s.active.line, character: s.active.character }
  }

  /** Lights lines start..end (0-based, inclusive) of `uri`; `opened`: the editor already shows them. */
  async light(uri: vscode.Uri, start: number, end: number, opened = false): Promise<void> {
    const prev = this.last
    this.back = prev && !(prev.uri.toString() === uri.toString() && prev.line >= start && prev.line <= end) ? prev : undefined
    this.lit.own.set(MOVE_IGNORE_MS)
    // The caret at the first line, nothing selected: the fill shows the lines, and typing never replaces them. (With
    // the show when it is needed: one call into the window, not a show and then a caret.)
    const caret = new vscode.Selection(start, 0, start, 0)
    const ed = opened ? vscode.window.visibleTextEditors.find((x) => x.document.uri.toString() === uri.toString())
      : await vscode.window.showTextDocument(uri, { preview: true, selection: caret })
    if (!ed) return
    end = Math.max(start, Math.min(end, ed.document.lineCount - 1))
    this.litNow = { uri: uri.toString(), start, end }
    if (opened) ed.selection = caret
    ed.revealRange(new vscode.Range(start, 0, end, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
    this.lit.own.set(REVEAL_IGNORE_MS)
    this.log.info(`claude link: ${vscode.workspace.asRelativePath(uri)}:${start + 1}-${end + 1}`)
    this.lit.paint()
  }

  /** codeNotes.claudeLinkBack: back to where the reader was (or only out, with nowhere to go back to). */
  async goBack(): Promise<void> {
    const b = this.back
    this.unlight()
    if (!b) return
    this.lit.own.set(MOVE_IGNORE_MS)
    const ed = await vscode.window.showTextDocument(b.uri, { preview: false, selection: new vscode.Selection(b.line, b.character, b.line, b.character) })
    ed.revealRange(new vscode.Range(b.line, 0, b.line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
  }

  unlight(): void { if (this.litNow) { this.litNow = undefined; this.back = undefined; this.lit.paint() } }

  /** For tests: what is lit, whether Back has somewhere to go, and what the guess reads right now. */
  get state(): { lit?: LitRange; back: boolean; enabled: boolean; fresh: boolean; moving: boolean; selections: number } {
    return {
      lit: this.litNow && { ...this.litNow }, back: !!this.back, enabled: this.enabled(),
      fresh: Date.now() - this.frontAt < FRONT_FRESH_MS, moving: this.lit.own.ours(), selections: this.selections,
    }
  }

  dispose(): void { for (const s of this.subs) s.dispose() }
}
