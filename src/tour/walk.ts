// The walk through a journey: which step is open, opening a step (its file, its card, the map beside), moving on,
// the status bar item, and where each journey was left.
import * as vscode from 'vscode'
import { beats, codeLinks, journeys, log, mapPanel, now, setCtx, state, tourItems } from '../app'
import { ownSelection } from '../claudeChatLinks'
import { fileOf, LoadedJourney, posKey } from '../journeys/steps'
import { checkLinkNote } from '../check/wiring'
import { revealJourneyRow } from '../sidebar/journeyRows'
import { tree } from '../sidebar/notesTree'
import { editorSettling } from '../threads/settle'
import { refreshDecorations } from '../notes/decorations'
import { wfs } from '../workspaceFs'
import type { StepCard } from './card'
import { openCheckpoint, stopBy } from './checkTour'
import { panelFits } from './panelLayout'
import { endJourney, finishTour } from './commands'
import { pickJourney } from './pick'
import { MAP_KEY, POS_KEY, ShownAt, TOUR_KEY, TourState } from './state'
import { foldNotesOverlapping, syncStepNotes } from './stepNotes'
import { cardLine, stepUri, wroteAt } from './stepPlace'
import { baseName } from '../paths'
import { stepFileUri } from '../journeys/codeGroup'

type Pos = { step: number; id?: string; at: string }
export type TourItems = { prev: vscode.StatusBarItem; pos: vscode.StatusBarItem; next: vscode.StatusBarItem; end: vscode.StatusBarItem }

/** A group with the reader's own work in it: an unsaved file, or an untitled one (a scratch or notes draft). */
function readersOwn(g: vscode.TabGroup): boolean {
  return g.tabs.some((t) => t.isDirty || (t.input instanceof vscode.TabInputText && t.input.uri.scheme === 'untitled'))
}

export class Walk {
  constructor(private readonly tour: TourState, private readonly card: StepCard) {}

  /** Called once the walk has moved, or the journeys changed (updateTour): the podcast follows a reader's move. */
  onMoved: (() => void) | undefined
  /** The step on screen was removed from the journey: true when the podcast puts the walk where its time is now. */
  onStepRemoved: ((lj: LoadedJourney) => boolean) | undefined
  /** Next / Previous (the card, the keys) while a podcast drives the walk: true when the podcast's own ⏮ ⏭ did it. */
  transport: ((dir: 1 | -1) => boolean) | undefined
  /** A podcast is playing or paused on this journey (its row, Open Journey… on it: focus, never reopen). */
  podcastOn: ((lj: LoadedJourney) => boolean) | undefined
  /** The walk was restored after a reload (commands.ts restoreTour): the podcast lights the beat it was at. */
  onRestored: ((lj: LoadedJourney) => void) | undefined

  /** The editor follows the walk (scrolls to what it shows); false while the reader looks around on their own during
   *  a podcast (the follow lock, podcast/follow.ts): it only highlights. */
  following: () => boolean = () => true

  tourJourney(): LoadedJourney | undefined { return this.tour.key ? journeys.list.get(this.tour.key) : undefined }
  /** A tour is running (not just a map open): only then the status bar, the step card and D/A belong to it. */
  touring(): boolean { return !!this.tourJourney() && this.tour.step > 0 }

  positions(): Record<string, Pos> { return state.get<Record<string, Pos>>(POS_KEY) ?? {} }
  /** Where this journey was left (0: never started): the same step by id when it still exists, else the same number. */
  resumeAt(lj: LoadedJourney): number {
    const p = this.positions()[posKey(lj)]
    if (!p) return 0
    const i = p.id ? lj.j.steps.findIndex((s) => s.id === p.id) : -1
    return i >= 0 ? i + 1 : Math.min(p.step, lj.j.steps.length)
  }
  async savePos(lj: LoadedJourney, step: number): Promise<void> {
    await state.update(POS_KEY, { ...this.positions(), [posKey(lj)]: { step, id: lj.j.steps[step - 1]?.id, at: now() } })
  }

  /** The step a journey opens on: the one being walked, else where it was left, else step 1. */
  startStep(lj: LoadedJourney): number {
    return this.tour.key === lj.key && this.tour.step ? this.tour.step : this.resumeAt(lj) || 1
  }

  /** On step n of `lj`, in a running tour (an older timer or callback for another step does nothing). */
  isOn(lj: LoadedJourney, n: number): boolean {
    return this.touring() && this.tourJourney() === lj && this.tour.step === n
  }

  /** The journey file changed during a tour: stay on the same step (by id); if it was removed, its neighbour. */
  followStep(): void {
    const { tour } = this
    const lj = this.tourJourney()
    if (!lj || !tour.step) return
    const i = lj.j.steps.findIndex((s) => s.id === tour.stepId)
    if (i < 0) {
      this.followRemovedStep(lj)
      return
    }
    const n = i + 1
    if (tour.step !== n) this.say(`$(info) Journey updated: this step is now ${n}/${lj.j.steps.length}`, 5000)
    tour.step = n
    void this.savePos(lj, n)
    const was = tour.shownAt
    if (was && was.key === lj.key && was.id === lj.j.steps[i].id) {
      // Maybe re-anchored by the agent (other file or lines): found again, then the editor follows the card.
      void journeys.locate(lj, (k) => k === n).then(() => this.onRelocated(lj, n, was))
    } else this.redrawStep(lj)
    tree.refresh()
  }

  /** A status message about the step on screen: it goes as soon as the walk moves to another step (F46). */
  private say(text: string, ms: number): void {
    this.tour.notice?.dispose()
    this.tour.notice = vscode.window.setStatusBarMessage(text, ms)
  }

  /** The step the tour was on is gone from the journey: the next one (or the last), said on the card. A podcast
   *  driving the walk decides instead (the view its time has now: onStepRemoved). */
  private followRemovedStep(lj: LoadedJourney): void {
    const { tour } = this
    if (this.onStepRemoved?.(lj)) return
    const total = lj.j.steps.length
    if (!total) {
      void endJourney()
      return
    }
    tour.step = Math.min(tour.step, total)
    tour.stepId = lj.j.steps[tour.step - 1].id
    // Said on the card, where the eyes are, and the editor goes with it.
    const text = `The step you were on was removed from the journey. This is the next one (${tour.step}/${total}).`
    tour.cardNotice = { id: tour.stepId, text }
    this.say(`$(info) The step you were on was removed from the journey: now at ${tour.step}/${total}`, 5000)
    void this.savePos(lj, tour.step)
    // Map, card AND editor on the new step.
    void this.goToStep(lj, tour.step, { focus: false })
  }

  /**
   * Step n found again after the journey file changed (`was`: where it was shown). Moved by a change in the journey
   * file: opened there with one line saying so; code that moved or came back is just shown; else only redrawn.
   */
  private onRelocated(lj: LoadedJourney, n: number, was: ShownAt): void {
    const { tour } = this
    if (tour.step !== n || this.tourJourney() !== lj) return
    const at = lj.at[n - 1]
    const file = fileOf(lj, n)
    const rewritten = wroteAt(lj, n) !== was.wrote
    const elsewhere = file !== was.file || at.start !== was.start || at.end !== was.end || !!at.removed !== was.removed
    if (!rewritten && tour.cardNotice?.id === was.id) tour.cardNotice = undefined
    if (!elsewhere) {
      this.redrawStep(lj)
      return
    }
    if (rewritten) tour.cardNotice = { id: was.id, text: `This step was updated: its code is now at ${baseName(file)}:${at.start}.` }
    void this.goToStep(lj, n, { focus: false })
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
   * the context keys, lenses and map follow, and the status bar item says where the walk is.
   */
  updateTour(): void {
    const { tour } = this
    const lj = this.tourJourney()
    this.dropStaleLinkBack()
    if (tour.key && !lj) this.endDeletedJourney(tour.key)
    if (lj && tour.step > lj.j.steps.length) tour.step = lj.j.steps.length
    // A step question's back-link says less while you walk its journey.
    syncStepNotes()
    setCtx('codeNotes.journeyActive', this.touring())
    this.card.lensChanged.fire() // the step lenses show only outside a walk
    setCtx('codeNotes.hasJourneys', journeys.all().length > 0)
    mapPanel.update()
    this.renderStatusItem(lj)
    this.onMoved?.()
  }

  /** A code link's way back is to the step it was clicked on: the walk moved on or ended, the link (and its Back) goes. */
  private dropStaleLinkBack(): void {
    const { tour } = this
    const back = tour.linkBack
    if (!back || (back.journey === tour.key && back.step === tour.step)) return
    tour.linkBack = undefined
    if (!checkLinkNote(codeLinks.state.key ?? '')) codeLinks.unlight()
  }

  /** The journey file was deleted: the tour ends with one notice; the map says so. */
  private endDeletedJourney(key: string): void {
    const { tour } = this
    if (tour.step) vscode.window.setStatusBarMessage('$(info) The journey was deleted; it ended', 5000)
    mapPanel.markDeleted(key)
    this.forgetTour()
    void state.update(TOUR_KEY, undefined)
  }

  /** No tour in memory any more (no journey, step, document or card); what was saved stays. */
  forgetTour(): void {
    const { tour } = this
    tour.key = undefined
    tour.step = 0
    tour.doc = undefined
    this.card.clear()
  }

  /** Only while a tour runs, and one item: "3/14", click = the map; ‹ › × live on the map and the card. */
  private renderStatusItem(lj: LoadedJourney | undefined): void {
    const step = this.tour.step
    if (!lj || !step) {
      for (const i of Object.values(tourItems)) i.hide()
      return
    }
    // The journey's name is the map tab's title; a one-line tooltip.
    const total = lj.j.steps.length
    tourItems.pos.text = `$(map) ${step}/${total}`
    tourItems.pos.accessibilityInformation = { label: `${lj.j.title}, step ${step} of ${total}. Opens the map.` }
    tourItems.pos.tooltip = `${lj.j.title}: open the map`
    tourItems.pos.show()
    tourItems.prev.hide()
    tourItems.next.hide()
    tourItems.end.hide()
  }

  /**
   * The code group: never the map's. The group the walk showed code in (kept for the window: another journey, the
   * map's moments of a podcast, a walk ended keep it), while it is open; else the group nearest the panel that isn't
   * holding the reader's own work (an unsaved file, an untitled draft); else a new group. One predictable group, so
   * step code never lands on a notes draft and never shows in two groups (F16, F109, F122).
   */
  readonly codeColumn = (): vscode.ViewColumn | undefined => {
    const mapCol = mapPanel.viewColumn
    const groups = vscode.window.tabGroups.all
    const kept = this.tour.walkGroup
    if (kept && groups.includes(kept) && kept.viewColumn !== mapCol) return kept.viewColumn
    this.tour.walkGroup = undefined
    if (mapCol === undefined) return this.tour.doc?.column ?? vscode.window.activeTextEditor?.viewColumn
    const others = groups.filter((g) => g.viewColumn !== mapCol).sort((a, b) => Math.abs(a.viewColumn - mapCol) - Math.abs(b.viewColumn - mapCol) || a.viewColumn - b.viewColumn)
    const free = others.find((g) => !readersOwn(g))
    if (free) {
      this.tour.walkGroup = free
      return free.viewColumn
    }
    // Every other group holds the reader's own work (or there is none): a new group, at the end.
    return Math.max(0, ...groups.map((g) => g.viewColumn)) + 1
  }

  /**
   * Where to show a file: the editor that already shows it (outside the map's group), else the code group. A second
   * editor on the same file makes VS Code build a second comment widget for a thread made just after (the step card,
   * a new note) before the thread's first state arrives, and those widgets loop on its collapsed state ("Maximum call
   * stack size exceeded"; the card or thread then stays collapsed). See SETTLE_MS.
   */
  columnFor(uri: vscode.Uri): vscode.ViewColumn | undefined {
    const mapCol = mapPanel.viewColumn
    const showing = vscode.window.visibleTextEditors.find((e) =>
      e.document.uri.toString() === uri.toString() && e.viewColumn !== undefined && e.viewColumn !== mapCol)
    return showing?.viewColumn ?? this.codeColumn()
  }

  showMap(lj: LoadedJourney, preserveFocus = false): void {
    mapPanel.show(lj, preserveFocus, this.tour.doc?.column)
    void state.update(MAP_KEY, posKey(lj))
  }

  /**
   * Opens step n: the code in the code group as a preview tab (one tab, reused:), the step card above its lines.
   * `beat`: the step opens on that beat of its animation (the podcast); when the beat's code is in another file, that
   * file is the one opened (by the beat, beats.ts), never the step's own first.
   */
  async goToStep(lj: LoadedJourney, n: number, opts: { focus?: boolean; beat?: number } = {}): Promise<void> {
    this.tour.stepping++
    try { await this.openStep(lj, n, opts) } finally { this.tour.stepping-- }
  }

  /** Three phases, each ending early once a step opened since has taken over (`superseded`). */
  private async openStep(lj: LoadedJourney, requested: number, opts: { focus?: boolean; beat?: number }): Promise<void> {
    if (!lj.j.steps.length) return
    const gen = ++this.tour.stepGen
    const n = Math.max(1, Math.min(requested, lj.j.steps.length))
    // Superseded by a step opened since, elsewhere (the same step opened again, e.g. once its file moved: both go on).
    const superseded = () => gen !== this.tour.stepGen && !this.tour.isAt(lj, n)
    if (!(await this.enterStep(lj, n, superseded))) return
    const uri = stepUri(lj, n)
    if (this.beatElsewhere(lj, n, uri, opts.beat)) {
      this.onBeatElsewhere(lj, n)
      return
    }
    const editor = await this.openStepFile(lj, n, uri, opts, superseded)
    if (editor) await this.revealStep(lj, n, editor, uri)
  }

  /** The tour is on step n now (another journey's walk ended first), stored, its map and lists follow. False: superseded. */
  private async enterStep(lj: LoadedJourney, n: number, superseded: () => boolean): Promise<boolean> {
    const { tour } = this
    // Another step: the last one's beat is no longer lit (its scene sends the new step's beats); a message about the
    // step before ("this step is now 4/14") goes with it.
    if (!tour.isAt(lj, n)) {
      beats.clear()
      tour.notice?.dispose()
      tour.notice = undefined
    }
    // A step opened: the walk is on the step, not at a question after it (openCheckpoint sets that after).
    tour.checkpointId = undefined
    // One journey at a time, ended cleanly.
    if (tour.key && tour.key !== lj.key && tour.step) {
      await this.leaveJourney()
      if (superseded()) return false
    }
    if (tour.step === 0 || tour.key !== lj.key || tour.step !== n) tour.detailsOpen = false
    tour.key = lj.key
    tour.step = n
    tour.finishedKey = undefined
    tour.stepId = lj.j.steps[n - 1].id
    // The map shows the journey being walked: another journey's map (a look) gives way when a step moves.
    if (mapPanel.journey && mapPanel.journey.key !== lj.key) this.showMap(lj, true)
    // Stored, not waited for (each a round trip to the window; what is read back is in memory already).
    void state.update(TOUR_KEY, posKey(lj)).then(undefined, (e) => log.error(`tour: ${e}`))
    void this.savePos(lj, n).then(undefined, (e) => log.error(`tour: ${e}`))
    await journeys.locate(lj, (k) => k === n)
    if (superseded()) return false
    this.updateTour()
    tree.refresh()
    return true
  }

  /**
   * The step's file in the code group, the step found again in the open document (unsaved edits count). Undefined
   * when superseded, or when the step has no code to show (its file or its code is gone): then its card is in the map.
   */
  private async openStepFile(
    lj: LoadedJourney, n: number, uri: vscode.Uri, opts: { focus?: boolean }, superseded: () => boolean,
  ): Promise<vscode.TextEditor | undefined> {
    const { tour, card } = this
    const file = fileOf(lj, n)
    // A file that is gone: no stand-in tab; the card, in the map, says so.
    const [, gone] = await Promise.all([card.checkRefs(lj, n), wfs.stat(uri).then(() => false, () => true)])
    if (superseded()) return undefined
    tour.fileGone = gone
    // Its code was deleted: no code under the card pretending to be it; the card shows what it was.
    if (tour.cardNotice && tour.cardNotice.id !== tour.stepId) tour.cardNotice = undefined
    tour.shownAt = this.shownAt(lj, n, file)
    if (tour.fileGone || lj.at[n - 1].removed) {
      tour.refHere = undefined
      card.show(lj, n)
      this.showMap(lj, true)
      revealJourneyRow(lj)
      return undefined
    }
    const column = this.columnFor(uri)
    ownSelection(1500) // the file's caret and the step's: not a chat link
    const shown = { preview: true, preserveFocus: opts.focus === false, ...(column ? { viewColumn: column } : {}) }
    const editor = await vscode.window.showTextDocument(uri, shown)
    if (superseded()) return undefined
    if (editor.viewColumn) {
      tour.doc = { uri, column: editor.viewColumn }
      tour.walkGroup = vscode.window.tabGroups.all.find((g) => g.viewColumn === editor.viewColumn)
    }
    // Steps right after opening the file: anchoring against the open document (unsaved edits count).
    await journeys.locate(lj, (k) => k === n)
    if (superseded()) return undefined
    tour.shownAt = this.shownAt(lj, n, file)
    tour.refHere = undefined
    return editor
  }

  /** Beat `beat` of step n's animation shows code in another file than the step's (`uri`). */
  private beatElsewhere(lj: LoadedJourney, n: number, uri: vscode.Uri, beat: number | undefined): boolean {
    if (beat === undefined || lj.at[n - 1]?.removed) return false
    const code = lj.j.steps[n - 1]?.scene?.beats?.[beat]?.code
    if (!code || typeof code.file !== 'string') return false
    return stepFileUri(lj.folder.uri, journeys.renames(lj), code.file).toString() !== uri.toString()
  }

  /** Step n opened on a beat in another file: the beat opens its file (showBeat); the step's card is made, unseen. */
  private onBeatElsewhere(lj: LoadedJourney, n: number): void {
    const { tour } = this
    tour.fileGone = false
    if (tour.cardNotice && tour.cardNotice.id !== tour.stepId) tour.cardNotice = undefined
    tour.shownAt = this.shownAt(lj, n, fileOf(lj, n))
    tour.refHere = undefined
    this.card.show(lj, n)
    revealJourneyRow(lj)
  }

  /** Where step n is shown now (to see that the agent moved it). */
  private shownAt(lj: LoadedJourney, n: number, file: string): ShownAt {
    const at = lj.at[n - 1]
    return { key: lj.key, id: this.tour.stepId!, file, start: at.start, end: at.end, removed: !!at.removed, wrote: wroteAt(lj, n) }
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
    if (card.inMap(lj, n) && mapPanel.journey?.key !== lj.key) this.showMap(lj, true)
    const at = lj.at[n - 1]
    const first = Math.max(0, at.removed ? 0 : at.start - 1)
    tour.cursorUntil = Date.now() + 600
    editor.selection = new vscode.Selection(first, 0, first, 0)
    // A note on the step's lines folds, so the step comes first; it stays unread.
    foldNotesOverlapping(uri, at)
    // Again once the card is drawn: a jump from the map otherwise left the card above the view.
    const keepInView = this.keepCardInView(lj, n, editor)
    keepInView()
    setTimeout(keepInView, 120)
    setTimeout(keepInView, 400)
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
      if (beats.lit) {
        if (here && !beatBroughtBack) {
          beatBroughtBack = true
          void beats.again(this.codeColumn)
        }
        return
      }
      if (!here) return
      if (!this.following()) return
      const top = Math.max(0, Math.min(cardLine(lj, n), lj.at[n - 1].start - 1) - 1)
      editor.revealRange(new vscode.Range(top, 0, top, 0), vscode.TextEditorRevealType.AtTop)
    }
  }

  /**
   * A journey left for another one mid-way: it ends cleanly (card, status item, marker go:), its place kept
   * for Resume; no toast.
   */
  async leaveJourney(): Promise<void> {
    const lj = this.tourJourney()
    const n = this.tour.step
    await endJourney()
    if (lj && n) this.tour.lastLeft = { title: lj.j.title, at: `${n}/${lj.j.steps.length}` }
  }

  /** Next or previous: a step, or on a check's tour a stop (its open questions are stops between the steps). */
  async stepBy(dir: 1 | -1): Promise<void> {
    // One transport while a podcast plays: the card's Previous / Next and the keys are the player's ⏮ ⏭ (F71).
    if (this.transport?.(dir)) return
    if (!this.touring()) return this.startOrResume()
    const lj = this.tourJourney()!
    const to = lj.check ? stopBy(lj, dir) : this.stepAt(lj, this.tour.step + dir)
    if (!to) {
      const pastTheEnd = lj.check ? dir > 0 : this.tour.step + dir > lj.j.steps.length
      if (pastTheEnd) return finishTour()
      vscode.window.setStatusBarMessage('$(info) First step', 2000)
      return
    }
    if (to.q) {
      await openCheckpoint(lj, to.q)
      return
    }
    return this.goToStep(lj, to.step)
  }

  /** Step n as a stop of the walk; undefined past either end. */
  private stepAt(lj: LoadedJourney, n: number): { step: number; q?: string } | undefined {
    return n >= 1 && n <= lj.j.steps.length ? { step: n } : undefined
  }

  /** No tour: start (or resume) the journey whose map is open, else pick one. */
  private async startOrResume(): Promise<void> {
    const lj = this.tourJourney() ?? (await pickJourney())
    if (!lj) return
    // Just finished: next is not step 1 again; the panel says Done.
    if (this.tour.finishedKey === lj.key) {
      vscode.window.setStatusBarMessage('$(check) Journey finished', 2500)
      if (mapPanel.journey || (await panelFits())) this.showMap(lj)
      return
    }
    await this.goToStep(lj, this.resumeAt(lj) || 1)
  }
}
