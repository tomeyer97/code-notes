// The step card: the running step's text above its code (a read-only comment thread), or in the map when the step
// has no code to sit on; the bar on the step's lines and the ref opened from the card. What it says is the step's view
// (stepView.ts, pure); this file puts it on screen.
import * as vscode from 'vscode'
import { beats, codeLinks, journeys, mapPanel, valueHints } from './ports'
import { chordKey } from '../platform/chordKey'
import { setDecorations } from '../platform/editorDecorations'
import { readLinks, readValues } from '../core/format/journeyModel'
import { LruMap } from '../core/lruMap'
import type { PanelCard } from '../protocol/map'
import { fileOf, LoadedJourney, StepAt } from '../journeys/steps'
import { askedOf, askedText } from '../sidebar/journeyRows'
import { refreshDecorations as refreshNoteDecorations } from '../notes/decorations'
import { linesOfUri } from '../platform/documents'
import { MarkPainter } from '../marks/lights'
import { STEP_STYLES } from '../marks/styles'
import { blocksOf } from '../platform/symbolBlocks'
import { nextStop, seeAlsoLink } from './checkTour'
import { TourProbe, TourState } from './state'
import type { Narration } from './api'
import { CardWidget } from './cardWidget'
import { cardLine, stepUri } from './stepPlace'
import { paintStepMarks, stepMarks } from './stepMarks'
import { refFiles, StepRef } from './stepText'
import {
  CARD_COMMANDS, cardMarkdown, commandRefLink, narratingMarkdown, panelCardOf, panelRefLink, stepLabel, StepView,
  stepView, StepViewState, TutorialMark,
} from './stepView'
import { fireAndForget } from '../platform/run'
import { folderFileKey } from '../platform/keys'

export type { TutorialMark } from './stepView'

/** What the card asks of the walk: where it is (the card is made before the walk, which holds it). */
export interface CardWalk {
  touring(): boolean
  tourJourney(): LoadedJourney | undefined
  isOn(lj: LoadedJourney, n: number): boolean
}

/** What the card is made with (createTour). */
export interface CardDeps {
  tour: TourState
  probe: TourProbe
  walk: CardWalk
  /** The podcast on step n of `lj`, when one is in the panel for it. */
  narration: (lj: LoadedJourney, n: number) => Narration | undefined
  /** What the map's tutorial points at on the card now (tutorial.ts). */
  tutorialMark: () => TutorialMark
  /** The step lenses are asked for again (the walk moved, a ref was opened). */
  lensesChanged: () => void
  log: vscode.LogOutputChannel
}

/** While a podcast plays, the line found for its header card, kept for this many (document version, step) pairs. */
const FN_LINES_KEPT = 50

/** A ref opened from the card: its document and lines (0-based). */
type RefHere = NonNullable<TourState['refHere']>

export class StepCard implements vscode.Disposable {
  /** How the step's lines were drawn last (tests): the bar and tint, the thin grey bar, or nothing. */
  look: 'tint' | 'quiet' | undefined

  /**
   * The card with its own comment controller (read-only threads: no menus, no reply box), its decorations and the
   * painter of the step's marks (a match that can't be found lights nothing).
   */
  static create(deps: CardDeps): StepCard {
    const controller = vscode.comments.createCommentController('codeNotes.journey', 'Journey')
    controller.options = { prompt: '', placeHolder: '' }
    const deco = {
      at: vscode.window.createTextEditorDecorationType(STEP_STYLES.at),
      quiet: vscode.window.createTextEditorDecorationType(STEP_STYLES.quiet),
      stale: vscode.window.createTextEditorDecorationType(STEP_STYLES.stale),
      ref: vscode.window.createTextEditorDecorationType(STEP_STYLES.ref),
    }
    return new StepCard(deps, controller, new CardWidget(controller), deco, new MarkPainter(deps.log, 'drop'))
  }

  private readonly tour: TourState

  private constructor(
    private readonly deps: CardDeps,
    private readonly controller: vscode.CommentController,
    private readonly widget: CardWidget,
    private readonly deco: Record<'at' | 'quiet' | 'stale' | 'ref', vscode.TextEditorDecorationType>,
    /** The step's marks and its beats' (stepMarks.ts), drawn as a podcast's are. */
    private readonly marks: MarkPainter,
  ) {
    this.tour = deps.tour
  }

  /** The card's comment thread, while it is inline. */
  get thread(): vscode.CommentThread | undefined { return this.widget.thread }

  /** What the integration tests read of the card: its thread (where, what it says), its marks and how the step's
   *  lines were drawn. */
  snapshot() {
    const t = this.thread
    return {
      marks: this.marks.lit(),
      stepLook: this.look,
      card: t && {
        file: t.uri.path,
        line: t.range?.start.line,
        label: t.label,
        title: t.label?.replace(/^\d+\/\d+ · /, ''),
        body: (t.comments[0]?.body as vscode.MarkdownString | undefined)?.value,
        canReply: t.canReply,
        expanded: t.collapsibleState === vscode.CommentThreadCollapsibleState.Expanded,
      },
    }
  }

  dispose(): void {
    this.clear()
    for (const d of [this.widget, this.controller, ...Object.values(this.deco), this.marks]) d.dispose()
  }

  /** The voice tells the walk's step now: the editor goes quiet (no step tint, beat box, value hints or note bars). */
  narrating(): boolean {
    const walk = this.deps.walk
    const lj = walk.touring() ? walk.tourJourney() : undefined
    return !!lj && !!this.deps.narration(lj, this.tour.step)?.playing
  }

  /** `e` shows the narrated code (the walk's group, or the step's file) while the voice tells the step. */
  narrates(e: vscode.TextEditor): boolean {
    if (!this.narrating()) return false
    const lj = this.deps.walk.tourJourney()!
    return (e.viewColumn !== undefined && e.viewColumn === this.tour.walkGroup?.viewColumn)
      || e.document.uri.toString() === stepUri(lj, this.tour.step).toString()
  }

  /** What the editor was last painted for: playing or not (a change repaints the notes, the step and the beat). */
  private paintedPlaying = false

  /** While it plays, the line the header card hangs under, by document version and step start (see playingLine). */
  private fnLines = new LruMap<string, number>(FN_LINES_KEPT)

  /**
   * One step card, inline above the code (no panel mode). Only a step with no code to sit on (its
   * file is gone, or its code was deleted, never pinned on unrelated code such as line 1) shows its card in
   * the map instead.
   */
  inMap(lj: LoadedJourney, n: number): boolean {
    return lj.key === this.tour.key && this.tour.step === n && (this.tour.fileGone || !!lj.at[n - 1]?.removed)
  }

  /** Files the step's text names that don't exist, and how many lines the others have: checked when the step opens. */
  async checkRefs(lj: LoadedJourney, n: number): Promise<void> {
    const { refGone, refLines } = this.tour
    const moved = journeys().renames(lj)
    for (const written of refFiles(lj.j.steps[n - 1])) {
      const f = moved.get(written) ?? written
      const k = folderFileKey(lj.folder.uri, f)
      const lines = await linesOfUri(vscode.Uri.joinPath(lj.folder.uri, f))
      if (lines) {
        refGone.delete(k)
        refLines.set(k, lines.length)
      } else {
        refGone.add(k)
        refLines.delete(k)
      }
    }
  }

  /** What step n's card shows, from the journey and the tour's state. `link`: how a reference in its text reads. */
  view(lj: LoadedJourney, n: number, link: (r: StepRef) => string): StepView {
    return stepView(lj, n, this.viewState(lj, n), link)
  }

  /** What a step's view depends on besides the journey (stepView.ts). */
  private viewState(lj: LoadedJourney, n: number): StepViewState {
    const tour = this.tour
    const asked = askedOf(lj)[n]
    const notice = tour.cardNotice && tour.cardNotice.id === lj.j.steps[n - 1].id ? tour.cardNotice.text : undefined
    const last = n === lj.j.steps.length
    const seeAlso = lj.check && last ? seeAlsoLink([...new Set(lj.j.steps.map((x) => fileOf(lj, x.n)))]) : undefined
    return {
      renames: journeys().renames(lj), refGone: tour.refGone, refLines: tour.refLines, detailsOpen: tour.detailsOpen,
      // Step n's file is gone (checked when it opened).
      fileGone: tour.fileGone && tour.step === n,
      ...(asked ? { asked: { id: asked.id, text: askedText(asked), update: asked.update } } : {}),
      nextIsQuestion: !!lj.check && !!nextStop(lj)?.q,
      ...(notice !== undefined ? { notice } : {}),
      ...(seeAlso ? { seeAlso } : {}),
    }
  }

  /**
   * The panel's step card (the map shows it when the step has no code to sit on). The same view as the inline card;
   * its links are `ref:i` (the panel posts the index back: tour.panelRefs) and `note:` / `ask:`.
   */
  panelCard(lj: LoadedJourney, n: number): PanelCard {
    let i = 0
    const v = this.view(lj, n, (r) => panelRefLink(r, i++))
    this.tour.panelRefs = v.refs
    return panelCardOf(v)
  }

  /**
   * The inline card's Markdown, and what putting it on screen also does: the step's code links and value hints on the
   * code (only the links whose phrase is on the card), or, while the voice tells the step, none of them.
   */
  private render(lj: LoadedJourney, n: number): { md: vscode.MarkdownString; present: () => void } {
    // While the voice tells this step: the header line only (the voice and the code are enough).
    const nar = this.deps.narration(lj, n)
    if (nar?.playing) {
      const md = new vscode.MarkdownString(narratingMarkdown(nar.following))
      md.isTrusted = { enabledCommands: CARD_COMMANDS }
      return { md, present: () => { valueHints().clear(); codeLinks().clear() } }
    }
    const step = lj.j.steps[n - 1]
    const folder = lj.folder.uri.toString()
    const v = this.view(lj, n, (r) => commandRefLink(folder, n, r))
    const links = readLinks(step.links)
    const linkKey = `${lj.key}|${step.id}`
    // Paused: the full card, and the way to play on.
    const play = nar ? `Play the narration on (${chordKey()} Space)` : undefined
    const out = cardMarkdown(v, { links, linkKey, tutorial: this.deps.tutorialMark(), ...(play ? { play } : {}) })
    const md = new vscode.MarkdownString(out.body)
    md.isTrusted = { enabledCommands: CARD_COMMANDS }
    md.supportHtml = out.supportHtml
    md.baseUri = lj.folder.uri
    return { md, present: () => this.presentLinksAndHints(lj, n, linkKey, links, out.usedLinks) }
  }

  /**
   * On the code, for the step on the card: value hints (what its variables hold in the example run, faint, above their
   * lines) and its code links' lines, only those whose phrase is on the card now (`used`: those behind "More" while it
   * is open), in the text's own colour on a faint tint.
   */
  private presentLinksAndHints(lj: LoadedJourney, n: number, linkKey: string, links: ReturnType<typeof readLinks>, used: number[]): void {
    const renames = journeys().renames(lj)
    valueHints().present(linkKey, lj.folder.uri, readValues(lj.j.steps[n - 1].values), renames)
    if (links.length) codeLinks().present(linkKey, lj.folder.uri, links, renames, used)
    else codeLinks().clear()
  }

  /**
   * The step card: a comment thread of its own controller ("Journey"), so none of the note menus apply: no reply box,
   * no author picture, no time, no resolve/delete. Its header is "3/14 · <title>"; the body has no author line.
   */
  show(lj: LoadedJourney, n: number): void {
    this.deps.lensesChanged()
    const playing = !!this.deps.narration(lj, n)?.playing
    this.repaintIfPlayingChanged(playing)
    if (this.inMap(lj, n)) {
      this.widget.hide()
      mapPanel().update()
      return
    }
    const uri = stepUri(lj, n)
    const line = playing ? this.playingLine(lj, n, uri) : cardLine(lj, n)
    // Its function not found yet: the card comes once it is.
    if (line === undefined) return
    const { md, present } = this.render(lj, n)
    // The card's first line is "3/14 · <title>": the position once, and the title, since the map may not be in view
    // from the code. A stale step says so in its text.
    const label = stepLabel(lj, n)
    if (this.widget.render(uri, line, label, md, () => this.showIfStillOn(lj, n))) present()
  }

  /** Playing started or stopped: the notes, the step and the beat are painted again (quiet while the voice tells). */
  private repaintIfPlayingChanged(playing: boolean): void {
    if (playing === this.paintedPlaying) return
    this.paintedPlaying = playing
    refreshNoteDecorations()
    beats().paint()
  }

  /**
   * While the voice tells the step, its header card sits above the signature of the function the step is in (not
   * inside the function, over the code being read); a step in no function keeps the card's usual line. Undefined:
   * the file's functions are being found (the card is shown once they are).
   */
  private playingLine(lj: LoadedJourney, n: number, uri: vscode.Uri): number | undefined {
    const at = lj.at[n - 1]
    if (at.removed) return cardLine(lj, n)
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())
    const known = this.fnLines.get(fnKey(uri, doc, at.start))
    if (known !== undefined) return known
    fireAndForget(this.findFnLine(lj, n, uri), 'card: findFnLine')
    return undefined
  }

  private async findFnLine(lj: LoadedJourney, n: number, uri: vscode.Uri): Promise<void> {
    const at = lj.at[n - 1]
    let line = cardLine(lj, n)
    let doc: vscode.TextDocument | undefined
    try {
      doc = await vscode.workspace.openTextDocument(uri)
      const first = at.start - 1
      const fn = (await blocksOf(doc)).blocks.filter((b) => b.kind !== 'class' && b.start <= first && first <= b.end).pop()
      if (fn) line = Math.max(0, fn.start - 1)
    } catch (e) {
      // The file can't be read: the usual line.
      this.deps.log.debug(`card: no functions for ${uri.toString()}: ${e instanceof Error ? e.message : String(e)}`)
    }
    this.fnLines.set(fnKey(uri, doc, at.start), line)
    this.showIfStillOn(lj, n)
  }

  /** A card shown later: only while the walk is still on that step. */
  private showIfStillOn(lj: LoadedJourney, n: number): void {
    if (this.deps.walk.isOn(lj, n)) this.show(lj, n)
  }

  /**
   * The step's card and marker belong to the step's lines, not to a tab: whenever its file is on screen again (Go Back,
   * "Back to step", a tab switch, the file reopened) they are there. A preview tab that was replaced
   * closed the document, and VS Code drops a thread's widget with it: the thread is made again.
   */
  restore(): void {
    const tour = this.tour
    const walk = this.deps.walk
    const lj = walk.touring() ? walk.tourJourney() : undefined
    if (!lj || this.inMap(lj, tour.step) || tour.restoring) return
    const uri = stepUri(lj, tour.step).toString()
    const isShown = (u: string) => vscode.window.visibleTextEditors.some((e) => e.document.uri.toString() === u)
    const shown = isShown(uri)
    const back = shown && tour.shownFor !== uri
    tour.shownFor = shown ? uri : undefined
    if (!back) return
    // Back on the step's file: the ref is left behind.
    if (tour.refHere && tour.refHere.uri !== uri && !isShown(tour.refHere.uri)) {
      tour.refHere = undefined
      this.deps.lensesChanged()
    }
    tour.restoring = true
    try {
      this.widget.hide()
      this.show(lj, tour.step)
    } finally { tour.restoring = false }
  }

  /** A ref opened from the card in a tab: its lines lit in every editor showing it, "← Back to step n" above them. */
  showRef(here: RefHere): void {
    this.tour.refHere = here
    for (const e of vscode.window.visibleTextEditors) {
      setDecorations(e, this.deco.ref, e.document.uri.toString() === here.uri ? [lineRange(here)] : [])
    }
    this.deps.lensesChanged()
  }

  clear(): void {
    this.widget.hide()
    this.tour.refHere = undefined
    this.deps.lensesChanged()
    if (!this.marks.empty) this.marks.show(new Map())
    for (const e of vscode.window.visibleTextEditors) {
      for (const d of Object.values(this.deco)) setDecorations(e, d, [])
    }
  }

  /** The running step's lines: a bar and a faint tint (while the voice tells it, or while the step has marks: a thin
   *  grey bar; a stale step's: none); its marks and its beat's (stepMarks.ts); the ref opened from the card, lit. */
  refreshDecorations(): void {
    const tour = this.tour
    const walk = this.deps.walk
    const lj = walk.touring() ? walk.tourJourney() : undefined
    const onStep = lj && lj.j.steps[tour.step - 1] ? lj : undefined
    // While the voice tells it, the podcast's own marks are the ones on the code.
    const marks = onStep && !this.narrating() ? stepMarks(onStep, tour.step, beats().index, (k, line) => this.marks.once(k, line)) : []
    paintStepMarks(this.marks, marks)
    const step = onStep && { uri: stepUri(onStep, tour.step).toString(), at: onStep.at[tour.step - 1] }
    const ref = lj ? tour.refHere : undefined
    this.deps.probe.marked = []
    this.look = undefined
    for (const e of vscode.window.visibleTextEditors) {
      // While the voice tells it, or the step has marks: a thin neutral bar only, the marks are the colour on the code.
      const l = lightsIn(e.document.uri.toString(), step, ref, this.narrates(e) || marks.length > 0)
      setDecorations(e, this.deco.at, l.at)
      setDecorations(e, this.deco.quiet, l.quiet)
      setDecorations(e, this.deco.stale, [])
      setDecorations(e, this.deco.ref, l.ref)
      if (l.lit) {
        this.deps.probe.marked.push(e.document.uri.path)
        this.look = l.lit
      }
    }
  }
}

/** What the card lights in one editor: the step's lines (the bar and tint, or the quiet bar) and the ref opened from
 *  the card; `lit`: how the step's lines look there (none: not lit). */
interface Lights { at: vscode.Range[]; quiet: vscode.Range[]; ref: vscode.Range[]; lit: 'tint' | 'quiet' | undefined }

/** What to light in the editor of `uri` (pure: painting it is refreshDecorations). */
function lightsIn(uri: string, step: { uri: string; at: StepAt } | undefined, ref: RefHere | undefined, quiet: boolean): Lights {
  const at = step && step.uri === uri ? step.at : undefined
  // A stale step highlights nothing: what is there now is other code; the card says so.
  const lines = at && !at.stale ? [new vscode.Range(at.start - 1, 0, at.end - 1, 0)] : []
  return {
    at: quiet ? [] : lines,
    quiet: quiet ? lines : [],
    ref: ref && ref.uri === uri ? [lineRange(ref)] : [],
    lit: !lines.length ? undefined : quiet ? 'quiet' : 'tint',
  }
}

/** Whole lines `start`-`end` (0-based). */
const lineRange = (r: { start: number; end: number }) => new vscode.Range(r.start, 0, r.end, 0)

/** Where a step starting at `start` is, in a version of its document (none: it can't be opened). */
const fnKey = (uri: vscode.Uri, doc: vscode.TextDocument | undefined, start: number) => JSON.stringify([uri.toString(), doc?.version ?? null, start])
