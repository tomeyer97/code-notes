import * as vscode from 'vscode'
import { setDecorations } from '../platform/editorDecorations'
import { JBeat } from '../core/format/journeyModel'
import { TrackedLine, TrackedLines } from '../platform/followEdits'
import { showInCodeGroup, stepFileUri } from '../journeys/codeGroup'
import { docLines } from '../platform/documents'
import { marksIn } from '../core/format/marks'
import { Latest } from './latest'
import { lineChanged, locateStepLine } from './lines'
import { revealAround } from './litLines'

// A step's animation: the beat on screen lights the one line that does what it shows, nothing else
// (values are the step's value hints: valueHints.ts). A beat with marks (tour/stepMarks.ts) leaves its line unboxed:
// the marks show what it is about.

/** What a beat request did: lit its line, lit nothing (no code, or its line is gone), or a newer request took over. */
export type BeatShown = 'lit' | 'none' | 'superseded'

/** How a beat is shown while a podcast plays: `follow` false while the reader looks around on their own (the follow
 *  lock: a beat is lit where it is, the editor not moved to it); `quiet` while the voice tells the step (its marks show
 *  what is said: the beat's line is known but not drawn, the caret not moved to it). */
export interface BeatsPolicy { follow(): boolean; quiet(): boolean }

const FREE: BeatsPolicy = { follow: () => true, quiet: () => false }

/** Lines around the lit line in the panel's own small view of the code. */
const PREVIEW_MARGIN = 3
/** Lines kept in view above and below the lit line in the editor. */
const REVEAL_MARGIN = 6

export class Beats implements vscode.Disposable {
  /** The lit line (at most one); it follows edits to its file. */
  private readonly litLine = new TrackedLines<TrackedLine>(() => this.paint())
  private get here(): TrackedLine | undefined { return this.litLine.items[0] }
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
  private readonly latest = new Latest()
  /** How a beat is shown while something else (the tour, its podcast) has a say: usePolicy. */
  private policy: BeatsPolicy = FREE
  /**
   * The beat on screen (0-based, in its step's scene), as the panel last sent it; none lit: undefined. The step's
   * marks read it (tour/card.ts). Set it with showAt; the field stays writable for the panel's walk handler.
   */
  index: number | undefined
  /** The beat asked for last: its marks, when it has any, are drawn instead of its line's box. */
  private current: JBeat | undefined

  /** The tour says how beats are shown (its podcast's voice and follow lock), until disposed. */
  usePolicy(p: BeatsPolicy): vscode.Disposable {
    this.policy = p
    return new vscode.Disposable(() => { if (this.policy === p) this.policy = FREE })
  }

  constructor(private log: vscode.LogOutputChannel) {
    this.subs = [this.deco, this.litLine, vscode.window.onDidChangeVisibleTextEditors(() => this.paint())]
  }

  /** The lit line with a few lines around it (1-based numbers), as last found; nothing lit: nothing. */
  get preview(): { file: string; line: number; from: number; lines: string[] } | undefined { return this.here ? this.around : undefined }
  private around: { file: string; line: number; from: number; lines: string[] } | undefined

  /** For tests: what is lit. */
  get lit(): { uri: string; line: number } | undefined { return this.here && { uri: this.here.uri, line: this.here.line } }

  /** For tests: the lit line has its box (not quiet, the beat has no marks). */
  get boxed(): boolean { return !!this.here && !this.policy.quiet() && !marksIn(this.current?.marks).length }

  /** The lit line drawn, or not (`quiet`, or the beat has marks). */
  paint(): void {
    const h = this.here
    const quiet = this.policy.quiet() || marksIn(this.current?.marks).length > 0
    for (const e of vscode.window.visibleTextEditors) {
      const on = h && !quiet && e.document.uri.toString() === h.uri
      setDecorations(e, this.deco, on ? [new vscode.Range(h.line, 0, h.line, 0)] : [])
    }
  }

  /** Nothing lit; a request still opening its file is dropped. */
  clear(): void {
    this.latest.cancel()
    this.litLine.cancel()
    this.index = undefined
    this.current = undefined
    if (!this.here) return
    this.litLine.set([])
    this.paint()
  }

  /** Beat `index` of the step's scene (none: -1 or undefined) is the one on screen; its line lit as `show` does. */
  showAt(index: number | undefined, folder: vscode.Uri, beat: JBeat | undefined, renames: Map<string, string>, column: () => vscode.ViewColumn | undefined): Promise<BeatShown> {
    this.index = index !== undefined && index >= 0 ? index : undefined
    return this.show(folder, beat, renames, column)
  }

  /** Lights the beat's line in the code group (the panel keeps the focus); no beat, or no code: nothing is lit. */
  async show(folder: vscode.Uri, beat: JBeat | undefined, renames: Map<string, string>, column: () => vscode.ViewColumn | undefined): Promise<BeatShown> {
    const run = this.latest.begin()
    this.current = beat
    const c = beat?.code
    const none = (): BeatShown => {
      this.litLine.set([])
      this.paint()
      return 'none'
    }
    if (!c || typeof c.file !== 'string' || !Number.isInteger(c.line)) return none()
    const uri = stepFileUri(folder, renames, c.file)
    let doc: vscode.TextDocument
    try {
      doc = await vscode.workspace.openTextDocument(uri)
    } catch {
      this.log.info(`animation: ${c.file} can't be opened`)
      return run.current ? none() : 'superseded'
    }
    if (!run.current) return 'superseded'
    const lines = docLines(doc)
    const text = String(c.text ?? '')
    // A beat with no text names no line (unlike a code link, which then goes by its line number).
    const at = locateStepLine(lines, { line: c.line, text }, 'gone')
    if (at < 0) {
      this.log.info(lineChanged('animation', `the line at ${c.file}:${c.line}`, 'nothing lit'))
      return none()
    }
    this.litLine.set([{ uri: uri.toString(), line: at, text }])
    // The lines around it, for the panel's own small view of the code (no looking left and right).
    const from = Math.max(0, at - PREVIEW_MARGIN), to = Math.min(lines.length - 1, at + PREVIEW_MARGIN)
    this.around = { file: c.file, line: at + 1, from: from + 1, lines: lines.slice(from, to + 1) }
    return (await this.bring(doc, column)) ? 'lit' : 'superseded'
  }

  /** The lit line on screen again (the step's own reveal ran after it:). */
  async again(column: () => vscode.ViewColumn | undefined): Promise<void> {
    if (!this.here) return
    const run = this.latest.join()
    let doc: vscode.TextDocument
    try { doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(this.here.uri)) } catch { return }
    if (run.current) await this.bring(doc, column)
  }

  private async bring(doc: vscode.TextDocument, column: () => vscode.ViewColumn | undefined): Promise<boolean> {
    const run = this.latest.join()
    // Not following: lit where it is (if its file is on screen), nothing moved.
    if (!this.policy.follow()) {
      this.paint()
      return true
    }
    const ed = await showInCodeGroup(doc, column, { keepFocus: true })
    if (!run.current || !this.here) return false
    const at = this.here.line
    // The caret on the lit line: one lit line, never the current-line band left elsewhere by the step (while it plays
    // the caret stays where it is).
    if (!this.policy.quiet()) ed.selection = new vscode.Selection(at, 0, at, 0)
    revealAround(ed, at, at, REVEAL_MARGIN)
    // From column 1: an editor scrolled sideways would show the lit line's end, or nothing.
    ed.revealRange(new vscode.Range(at, 0, at, 0), vscode.TextEditorRevealType.Default)
    this.paint()
    return true
  }

  dispose(): void { for (const s of this.subs) s.dispose() }
}
