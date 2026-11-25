// The walk through a journey: where the reader is (which step of which journey), the moves between steps, opening a
// step, ending and finishing, and where each journey was left. It announces what happened (onDidChange, onDidEnd): the
// context keys, the notes and Journeys views, the lenses, the map's update, the status item, the code's lights and
// the podcast follow those (surfaces.ts). Opening a step still drives the editor itself: the step's file, its card,
// the map beside it, the step's row in the list, the beat cleared and the notes folded under the card.
import * as vscode from 'vscode'
import { beats, codeLinks, isCheckLink, journeys, mapPanel } from './ports'
import { now, stored } from '../platform/host'
import { ownSelection } from '../codeLinks/claudeChatLinks'
import { atOf, fileOf, LoadedJourney, posKey, stepOf } from '../journeys/steps'
import { revealJourneyRow } from '../sidebar/journeyRows'
import { editorSettling } from '../threads/settle'
import { refreshDecorations } from '../notes/decorations'
import { wfs } from '../platform/workspaceFs'
import type { StepCard } from './card'
import { openCheckpoint, stopBy } from './checkTour'
import { panelFits } from './panelLayout'
import { pickJourney } from './pick'
import type { ShownAt, TourProbe, TourState } from './state'
import type { Narration, WalkController } from './api'
import { foldNotesOverlapping } from './stepNotes'
import { cardLine, stepUri } from './stepPlace'
import { baseName } from '../core/paths'
import { stepFileUri } from '../journeys/codeGroup'
import { fireAndForget } from '../platform/run'
import { JourneyPos, STATE } from '../platform/state'
import { OWN_MOVE_MS } from '../platform/timings'
import { classifyChange, numberOf, placeOf, resumeStep, stepAfterRemoval, stepBy, stepCount, withoutPos } from './walkMoves'
import { closeWalkTabs } from './walkTabs'
import { say } from './status'
import { CARD_IN_VIEW_AGAIN_MS, SayKind, STEP_CURSOR_MS } from './timings'

/**
 * Why a walk ended: `ended` (End, Finish, another journey opened, its check gone: its place is kept, the code's lights
 * go), `deleted` (its journey file is gone: the map says so), `forgotten` (memory only, as after a reload: what was
 * saved stays).
 */
export type EndReason = 'ended' | 'deleted' | 'forgotten'

/** A group with the reader's own work in it: an unsaved file, or an untitled one (a scratch or notes draft). */
function readersOwn(g: vscode.TabGroup): boolean {
  return g.tabs.some((t) => t.isDirty || (t.input instanceof vscode.TabInputText && t.input.uri.scheme === 'untitled'))
}

export class Walk {
  constructor(private readonly tour: TourState, private readonly card: StepCard, private readonly probe: TourProbe) {}

  /** The podcast deciding for the walk, if one is registered (setController). */
  private controller: WalkController | undefined
  private readonly changed = new vscode.EventEmitter<void>()
  private readonly ended = new vscode.EventEmitter<EndReason>()
  private readonly restored = new vscode.EventEmitter<LoadedJourney>()
  /** The open step's opening: cancelled when another step starts opening. */
  private opening: vscode.CancellationTokenSource | undefined
  /** The walk moved, or the journeys changed under it (updateTour): what shows the walk follows. */
  readonly onDidChange = this.changed.event
  /** The same moment, as the podcast follows a reader's move (TourApi.onDidMove). */
  readonly onDidMove = this.changed.event
  /** The walk ended (end): what lit the code for its step goes. */
  readonly onDidEnd = this.ended.event
  /** The walk was restored after a reload (commands.ts restoreTour): the podcast lights the beat it was at. */
  readonly onDidRestore = this.restored.event

  /** The podcast decides for the walk where it must (api.ts WalkController), until disposed. */
  setController(c: WalkController): vscode.Disposable {
    this.controller = c
    return new vscode.Disposable(() => { if (this.controller === c) this.controller = undefined })
  }

  /** commands.ts restoreTour, once the walk is back on its step. */
  wasRestored(lj: LoadedJourney): void { this.restored.fire(lj) }

  /** The editor follows the walk (scrolls to what it shows); false while the reader looks around on their own during
   *  a podcast (the follow lock, podcast/follow.ts): it only highlights. */
  readonly following = (): boolean => this.controller?.following() ?? true
  /** A podcast is playing or paused on this journey (its row, Open Journey… on it: focus, never reopen). */
  listening(lj: LoadedJourney): boolean { return !!this.controller?.listening(lj) }
  /** What the step card shows of the podcast on step n of `lj`. */
  narration(lj: LoadedJourney, n: number): Narration | undefined { return this.controller?.narration(lj, n) }
  /** An episode is on: the panel opens at the listening width. */
  episodeOn(): boolean { return !!this.controller?.episodeOn() }

  dispose(): void {
    this.opening?.dispose()
    this.changed.dispose()
    this.ended.dispose()
    this.restored.dispose()
  }

  // ---------- where the reader is ----------

  tourJourney(): LoadedJourney | undefined { return this.tour.key ? journeys().list.get(this.tour.key) : undefined }
  /** A tour is running (not just a map open): only then the status bar, the step card and D/A belong to it. */
  touring(): boolean { return !!this.tourJourney() && this.tour.step > 0 }

  /** On step n of `lj`, in a running tour (an older timer or callback for another step does nothing). */
  isOn(lj: LoadedJourney, n: number): boolean {
    return this.touring() && this.tourJourney() === lj && this.tour.step === n
  }

  /** The step a journey opens on: the one being walked, else where it was left, else step 1. */
  startStep(lj: LoadedJourney): number {
    return this.tour.key === lj.key && this.tour.step ? this.tour.step : this.resumeAt(lj) || 1
  }

  /** A journey's map is open with no step shown (no walk running). */
  browse(lj: LoadedJourney): void { this.tour.browse(lj.key) }

  /** More / Less on the step card (`open`: which; none: the other), the card drawn again for the step walked. */
  showDetails(open?: boolean): void {
    this.tour.detailsOpen = open ?? !this.tour.detailsOpen
    const lj = this.tourJourney()
    if (lj && this.tour.step) this.card.show(lj, this.tour.step)
  }

  // ---------- where each journey was left (stored) ----------

  positions(): Record<string, JourneyPos> { return stored().get(STATE.journeyPos) }
  /** Where this journey was left (0: never started): the same step by id when it still exists, else the same number. */
  resumeAt(lj: LoadedJourney): number { return resumeStep(lj, this.positions()[posKey(lj)]) }
  async savePos(lj: LoadedJourney, step: number): Promise<void> {
    await stored().set(STATE.journeyPos, { ...this.positions(), [posKey(lj)]: { step, id: stepOf(lj, step)?.id, at: now() } })
  }
  /** The journey starts over next time (finished). */
  async forgetPos(lj: LoadedJourney): Promise<void> {
    await stored().set(STATE.journeyPos, withoutPos(this.positions(), posKey(lj)))
  }

  // ---------- the journey file changed ----------

  /** The journey file changed during a tour: stay on the same step (by id); if it was removed, its neighbour. */
  followStep(): void {
    const { tour } = this
    const lj = this.tourJourney()
    if (!lj || !tour.step) return
    const n = numberOf(lj, tour.stepId)
    if (!n) {
      this.followRemovedStep(lj)
      return
    }
    if (tour.step !== n) this.say(`$(info) Journey updated: this step is now ${n}/${stepCount(lj)}`, 'change')
    tour.step = n
    fireAndForget(this.savePos(lj, n), 'walk: savePos')
    const was = tour.shownAt
    if (was && was.key === lj.key && was.id === tour.stepId) {
      // Maybe re-anchored by the agent (other file or lines): found again, then the editor follows the card.
      fireAndForget(journeys().locate(lj, (k) => k === n).then(() => this.onRelocated(lj, n, was)), 'walk: journeys.locate')
    } else this.redrawStep(lj)
    // Its number may have changed: what shows the walk says so now, before the step is found again.
    this.updateTour()
  }

  /** A status message about the step on screen: it goes as soon as the walk moves to another step. */
  private say(text: string, kind: SayKind): void {
    this.tour.notice?.dispose()
    this.tour.notice = say(text, kind)
  }

  /** The step the tour was on is gone from the journey: the next one (or the last), said on the card. A podcast
   *  driving the walk decides instead (the view its time has now: WalkController.stepRemoved). */
  private followRemovedStep(lj: LoadedJourney): void {
    const { tour } = this
    if (this.controller?.stepRemoved(lj)) return
    const total = stepCount(lj)
    const n = stepAfterRemoval(tour.step, total)
    if (!n) {
      fireAndForget(this.end(), 'walk: end')
      return
    }
    tour.step = n
    tour.stepId = stepOf(lj, n).id
    // Said on the card, where the eyes are, and the editor goes with it.
    const text = `The step you were on was removed from the journey. This is the next one (${n}/${total}).`
    tour.cardNotice = { id: tour.stepId, text }
    this.say(`$(info) The step you were on was removed from the journey: now at ${n}/${total}`, 'change')
    fireAndForget(this.savePos(lj, n), 'walk: savePos')
    // Map, card AND editor on the new step.
    fireAndForget(this.goToStep(lj, n, { focus: false }), 'walk: goToStep')
  }

  /** Step n found again after the journey file changed (`was`: where it was shown): see walkMoves.ts classifyChange. */
  private onRelocated(lj: LoadedJourney, n: number, was: ShownAt): void {
    const { tour } = this
    if (tour.step !== n || this.tourJourney() !== lj) return
    const file = fileOf(lj, n)
    const change = classifyChange(was, placeOf(lj, n, file))
    if (change !== 'edited' && change !== 'rewritten' && tour.cardNotice?.id === was.id) tour.cardNotice = undefined
    switch (change) {
      case 'same':
      case 'edited':
        this.redrawStep(lj)
        return
      case 'rewritten':
        tour.cardNotice = { id: was.id, text: `This step was updated: its code is now at ${baseName(file)}:${atOf(lj, n).start}.` }
        break
      case 'moved':
        break
    }
    fireAndForget(this.goToStep(lj, n, { focus: false }), 'walk: goToStep')
  }

  /** The card and the status item again, for the step the tour is on. */
  private redrawStep(lj: LoadedJourney): void {
    this.card.show(lj, this.tour.step)
    this.updateTour()
  }

  /** Step number -> 'stale' (its code can't be found), for the map. */
  stepMarks(lj: LoadedJourney): Record<number, string> {
    const out: Record<number, string> = {}
    lj.at.forEach((a, i) => { if (a.stale) out[i + 1] = 'stale' })
    return out
  }

  /**
   * After the tour moved or the journeys changed: a stale code-link Back goes, a tour whose journey was deleted ends,
   * the step stays within the journey; then onDidChange (what shows the walk follows).
   */
  updateTour(): void {
    const { tour } = this
    const lj = this.tourJourney()
    this.dropStaleLinkBack()
    if (tour.key && !lj) fireAndForget(this.end('deleted'), 'walk: end deleted')
    if (lj && tour.step > stepCount(lj)) tour.step = stepCount(lj)
    this.changed.fire()
  }

  /** A code link's way back is to the step it was clicked on: the walk moved on or ended, the link (and its Back) goes. */
  private dropStaleLinkBack(): void {
    const { tour } = this
    const back = tour.linkBack
    if (!back || (back.journey === tour.key && back.step === tour.step)) return
    tour.linkBack = undefined
    if (!isCheckLink(codeLinks().state.key ?? '')) codeLinks().unlight()
  }

  // ---------- ending ----------

  /**
   * Ends the walk (see EndReason). Ended: its place is saved first, then onDidChange. Deleted or forgotten: the walk's
   * journey goes too, done at once (updateTour calls it on its way).
   */
  async end(reason: EndReason = 'ended'): Promise<void> {
    const { tour } = this
    if (reason === 'ended') {
      const lj = this.tourJourney()
      if (lj && tour.step) await this.savePos(lj, tour.step)
      await stored().set(STATE.tour, undefined)
    }
    if (reason === 'deleted') {
      if (tour.step) say('$(info) The journey was deleted; it ended', 'change')
      if (tour.key) mapPanel().markDeleted(tour.key)
    }
    tour.stop()
    if (reason !== 'ended') tour.key = undefined
    this.ended.fire(reason)
    if (reason === 'deleted') fireAndForget(stored().set(STATE.tour, undefined), 'walk: store tour')
    if (reason === 'ended') {
      this.updateTour()
    }
  }

  /** No tour in memory any more (no journey, step, document or card); what was saved stays. */
  forgetTour(): void { fireAndForget(this.end('forgotten'), 'walk: forget') }

  /**
   * Finish on the last step: the walk ends and starts over next time; the step tab it opened closes, so the map
   * gets its width back. The panel says Done (or, without it, the status bar).
   */
  async finish(): Promise<void> {
    const lj = this.tourJourney()
    const doc = this.tour.doc
    await this.end()
    if (!lj) return
    await this.forgetPos(lj)
    await closeWalkTabs(lj, doc?.column)
    this.tour.finishedKey = lj.key
    if (mapPanel().journey || (await panelFits())) this.showMap(lj)
    else say('$(check) Journey finished', 'done')
    this.updateTour()
  }

  /**
   * A journey left for another one mid-way: it ends cleanly (card, status item, marker go), its place kept
   * for Resume; no toast.
   */
  async leaveJourney(): Promise<void> {
    const lj = this.tourJourney()
    const n = this.tour.step
    await this.end()
    if (lj && n) this.probe.lastLeft = { title: lj.j.title, at: `${n}/${stepCount(lj)}` }
  }

  // ---------- where code is shown ----------

  /**
   * The code group: never the map's. Claims one and remembers it (`tour.walkGroup`): the group the walk showed code in
   * (kept for the window: another journey, the map's moments of a podcast, a walk ended keep it), while it is open;
   * else the group nearest the panel that isn't holding the reader's own work (an unsaved file, an untitled draft);
   * else a new group. One predictable group, so step code never lands on a notes draft and never shows in two groups.
   */
  readonly claimCodeColumn = (): vscode.ViewColumn | undefined => {
    const mapCol = mapPanel().viewColumn
    const groups = vscode.window.tabGroups.all
    const kept = this.tour.walkGroup
    if (kept && groups.includes(kept) && kept.viewColumn !== mapCol) return kept.viewColumn
    this.tour.walkGroup = undefined
    if (mapCol === undefined) return this.tour.doc?.column ?? vscode.window.activeTextEditor?.viewColumn
    const others = groups.filter((g) => g.viewColumn !== mapCol)
      .sort((a, b) => Math.abs(a.viewColumn - mapCol) - Math.abs(b.viewColumn - mapCol) || a.viewColumn - b.viewColumn)
    const free = others.find((g) => !readersOwn(g))
    if (free) {
      this.tour.walkGroup = free
      return free.viewColumn
    }
    // Every other group holds the reader's own work (or there is none): a new group, at the end.
    return Math.max(0, ...groups.map((g) => g.viewColumn)) + 1
  }
  /** The name TourApi and the map's messages use (it claims, see claimCodeColumn). */
  readonly codeColumn = this.claimCodeColumn

  /**
   * Where to show a file: the editor that already shows it (outside the map's group), else the code group. A second
   * editor on the same file makes VS Code build a second comment widget for a thread made just after (the step card,
   * a new note) before the thread's first state arrives, and those widgets loop on its collapsed state ("Maximum call
   * stack size exceeded"; the card or thread then stays collapsed). See SETTLE_MS.
   */
  columnFor(uri: vscode.Uri): vscode.ViewColumn | undefined {
    return this.shownOutsideMap(uri)?.viewColumn ?? this.claimCodeColumn()
  }

  /** The visible editor showing `uri`, outside the map's group. */
  private shownOutsideMap(uri: vscode.Uri): vscode.TextEditor | undefined {
    const mapCol = mapPanel().viewColumn
    return vscode.window.visibleTextEditors.find((e) =>
      e.document.uri.toString() === uri.toString() && e.viewColumn !== undefined && e.viewColumn !== mapCol)
  }

  showMap(lj: LoadedJourney, preserveFocus = false): void {
    mapPanel().show(lj, preserveFocus, this.tour.doc?.column)
    fireAndForget(stored().set(STATE.mapJourney, posKey(lj)), 'walk: store mapJourney')
  }

  // ---------- opening a step ----------

  /**
   * Opens step n: the code in the code group as a preview tab (one tab, reused), the step card above its lines.
   * `beat`: the step opens on that beat of its animation (the podcast); when the beat's code is in another file, that
   * file is the one opened (by the beat, beats.ts), never the step's own first.
   */
  async goToStep(lj: LoadedJourney, n: number, opts: { focus?: boolean; beat?: number } = {}): Promise<void> {
    this.tour.stepping++
    try { await this.openStep(lj, n, opts) } finally { this.tour.stepping-- }
  }

  /**
   * A step opened since has taken over: its opening cancelled this one and the walk is elsewhere (the same step opened
   * again, e.g. once its file moved: both go on).
   */
  private superseded(token: vscode.CancellationToken, lj: LoadedJourney, n: number): boolean {
    return token.isCancellationRequested && !this.tour.isAt(lj, n)
  }

  /** Three phases, each ending early once a step opened since has taken over. */
  private async openStep(lj: LoadedJourney, requested: number, opts: { focus?: boolean; beat?: number }): Promise<void> {
    if (!stepCount(lj)) return
    this.opening?.cancel()
    this.opening?.dispose()
    const source = new vscode.CancellationTokenSource()
    this.opening = source
    const { token } = source
    const n = Math.max(1, Math.min(requested, stepCount(lj)))
    if (!(await this.enterStep(lj, n, token))) return
    const uri = stepUri(lj, n)
    if (this.beatElsewhere(lj, n, uri, opts.beat)) {
      this.onBeatElsewhere(lj, n)
      return
    }
    const editor = await this.openStepFile(lj, n, uri, opts, token)
    if (editor) await this.revealStep(lj, n, editor, uri)
  }

  /** The tour is on step n now (another journey's walk ended first), stored, its map and lists follow. False: superseded. */
  private async enterStep(lj: LoadedJourney, n: number, token: vscode.CancellationToken): Promise<boolean> {
    const { tour } = this
    // Another step: the last one's beat is no longer lit (its scene sends the new step's beats); a message about the
    // step before ("this step is now 4/14") goes with it.
    if (!tour.isAt(lj, n)) {
      beats().clear()
      tour.notice?.dispose()
      tour.notice = undefined
    }
    // A step opened: the walk is on the step, not at a question after it (openCheckpoint sets that after).
    tour.checkpointId = undefined
    // One journey at a time, ended cleanly.
    if (tour.key && tour.key !== lj.key && tour.step) {
      await this.leaveJourney()
      if (this.superseded(token, lj, n)) return false
    }
    if (tour.step === 0 || tour.key !== lj.key || tour.step !== n) tour.detailsOpen = false
    tour.key = lj.key
    tour.step = n
    tour.finishedKey = undefined
    tour.stepId = stepOf(lj, n).id
    // The map shows the journey being walked: another journey's map (a look) gives way when a step moves.
    const shown = mapPanel().journey
    if (shown && shown.key !== lj.key) this.showMap(lj, true)
    // Stored, not waited for (each a round trip to the window; what is read back is in memory already).
    fireAndForget(stored().set(STATE.tour, posKey(lj)), 'tour')
    fireAndForget(this.savePos(lj, n), 'tour')
    await journeys().locate(lj, (k) => k === n)
    if (this.superseded(token, lj, n)) return false
    this.updateTour()
    return true
  }

  /**
   * The step's file in the code group, the step found again in the open document (unsaved edits count). Undefined
   * when superseded, or when the step has no code to show (its file or its code is gone): then its card is in the map.
   */
  private async openStepFile(
    lj: LoadedJourney, n: number, uri: vscode.Uri, opts: { focus?: boolean }, token: vscode.CancellationToken,
  ): Promise<vscode.TextEditor | undefined> {
    const { tour, card } = this
    const file = fileOf(lj, n)
    // A file that is gone: no stand-in tab; the card, in the map, says so.
    const [, gone] = await Promise.all([card.checkRefs(lj, n), wfs.stat(uri).then(() => false, () => true)])
    if (this.superseded(token, lj, n)) return undefined
    this.markShown(lj, n, file, gone)
    // Its code was deleted: no code under the card pretending to be it; the card shows what it was.
    if (gone || atOf(lj, n).removed) {
      card.show(lj, n)
      this.showMap(lj, true)
      revealJourneyRow(lj)
      return undefined
    }
    const column = this.columnFor(uri)
    ownSelection(OWN_MOVE_MS) // the file's caret and the step's: not a chat link
    const shown = { preview: true, preserveFocus: opts.focus === false, ...(column ? { viewColumn: column } : {}) }
    // Already on screen and the keyboard stays where it is: nothing to show. Its column may be about to change (a
    // group closing renumbers those after it), and a show by an old number would open a new group.
    const editor = (opts.focus === false ? this.shownOutsideMap(uri) : undefined) ?? await vscode.window.showTextDocument(uri, shown)
    if (this.superseded(token, lj, n)) return undefined
    if (editor.viewColumn) {
      tour.doc = { uri, column: editor.viewColumn }
      tour.walkGroup = vscode.window.tabGroups.all.find((g) => g.viewColumn === editor.viewColumn)
    }
    // Steps right after opening the file: anchoring against the open document (unsaved edits count).
    await journeys().locate(lj, (k) => k === n)
    if (this.superseded(token, lj, n)) return undefined
    this.markShown(lj, n, file, false)
    return editor
  }

  /**
   * Step n of `lj` is what the editor shows for the walk now (from `file`; `gone`: that file doesn't exist): where (to
   * see later that the agent moved it), a notice about another step goes, and no reference is open under it.
   */
  private markShown(lj: LoadedJourney, n: number, file: string, gone: boolean): void {
    const { tour } = this
    tour.fileGone = gone
    if (tour.cardNotice && tour.cardNotice.id !== tour.stepId) tour.cardNotice = undefined
    tour.shownAt = { key: lj.key, id: tour.stepId!, ...placeOf(lj, n, file) }
    tour.refHere = undefined
  }

  /** Beat `beat` of step n's animation shows code in another file than the step's (`uri`). */
  private beatElsewhere(lj: LoadedJourney, n: number, uri: vscode.Uri, beat: number | undefined): boolean {
    if (beat === undefined || atOf(lj, n)?.removed) return false
    const code = stepOf(lj, n)?.scene?.beats?.[beat]?.code
    if (!code || typeof code.file !== 'string') return false
    return stepFileUri(lj.folder.uri, journeys().renames(lj), code.file).toString() !== uri.toString()
  }

  /** Step n opened on a beat in another file: the beat opens its file (showBeat); the step's card is made, unseen. */
  private onBeatElsewhere(lj: LoadedJourney, n: number): void {
    this.markShown(lj, n, fileOf(lj, n), false)
    this.card.show(lj, n)
    revealJourneyRow(lj)
  }

  /** The card above the step's lines once the editor has settled, the caret on them, both scrolled into view. */
  private async revealStep(lj: LoadedJourney, n: number, editor: vscode.TextEditor, uri: vscode.Uri): Promise<void> {
    const { tour, card } = this
    // The editor just opened on this file: the card is made once it has settled (see editorSettling).
    const settle = editorSettling(uri)
    if (settle) {
      await new Promise((r) => setTimeout(r, settle))
      if (!tour.isAt(lj, n)) return
    }
    card.show(lj, n)
    // The card lives in the map ("panel"): the map is open beside the code.
    if (card.inMap(lj, n) && mapPanel().journey?.key !== lj.key) this.showMap(lj, true)
    const at = atOf(lj, n)
    const first = Math.max(0, at.removed ? 0 : at.start - 1)
    tour.cursorUntil = Date.now() + STEP_CURSOR_MS
    editor.selection = new vscode.Selection(first, 0, first, 0)
    // A note on the step's lines folds, so the step comes first; it stays unread.
    foldNotesOverlapping(uri, at)
    // Again once the card is drawn: a jump from the map otherwise left the card above the view.
    const keepInView = this.keepCardInView(lj, n, editor)
    keepInView()
    for (const ms of CARD_IN_VIEW_AGAIN_MS) setTimeout(keepInView, ms)
    refreshDecorations()
    revealJourneyRow(lj)
  }

  /**
   * The card (or the marker line) sits above the step's lines: brought to the top, so card and code are both on
   * screen. While the step's animation lights a beat, the beat's line is what is on screen: brought back once, in
   * case this step's file was shown over it.
   */
  private keepCardInView(lj: LoadedJourney, n: number, editor: vscode.TextEditor): () => void {
    let beatBroughtBack = false
    return () => {
      const here = this.tour.isAt(lj, n)
      if (beats().lit) {
        if (here && !beatBroughtBack) {
          beatBroughtBack = true
          fireAndForget(beats().again(this.claimCodeColumn), 'walk: beats.again')
        }
        return
      }
      if (!here) return
      if (!this.following()) return
      const top = Math.max(0, Math.min(cardLine(lj, n), atOf(lj, n).start - 1) - 1)
      editor.revealRange(new vscode.Range(top, 0, top, 0), vscode.TextEditorRevealType.AtTop)
    }
  }

  // ---------- Next and Previous ----------

  /** Next or previous: a step, or on a check's tour a stop (its open questions are stops between the steps). */
  async stepBy(dir: 1 | -1): Promise<void> {
    // One transport while a podcast plays: the card's Previous / Next and the keys are the player's ⏮ ⏭.
    if (this.controller?.transport(dir)) return
    if (!this.touring()) return this.startOrResume()
    const lj = this.tourJourney()!
    if (lj.check) {
      const to = stopBy(lj, dir)
      if (to?.q) {
        await openCheckpoint(lj, to.q)
        return
      }
      if (to) return this.goToStep(lj, to.step)
      if (dir > 0) return this.finish()
      say('$(info) First step', 'hint')
      return
    }
    const to = stepBy(this.tour.step, dir, stepCount(lj))
    if (to === 'finish') return this.finish()
    if (to === 'first') {
      say('$(info) First step', 'hint')
      return
    }
    return this.goToStep(lj, to)
  }

  /** No tour: start (or resume) the journey whose map is open, else pick one. */
  private async startOrResume(): Promise<void> {
    const lj = this.tourJourney() ?? (await pickJourney())
    if (!lj) return
    // Just finished: next is not step 1 again; the panel says Done.
    if (this.tour.finishedKey === lj.key) {
      say('$(check) Journey finished', 'done')
      if (mapPanel().journey || (await panelFits())) this.showMap(lj)
      return
    }
    await this.goToStep(lj, this.resumeAt(lj) || 1)
  }
}
