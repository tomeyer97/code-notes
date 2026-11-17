// The walk through a journey: which step is open, opening a step (its file, its card, the map beside), moving on,
// the status bar item, and where each journey was left.
import * as vscode from 'vscode'
import { wfs } from '../wfs'
import { Beats } from '../beats'
import { CodeLinks } from '../codeLinks'
import { ownSelection } from '../claudeLinks'
import { fileOf, Journeys, LoadedJourney, MapPanel, posKey } from '../journeys'
import { TourState } from './state'
import { StepCard, cardLine, wroteAt } from './card'

export const TOUR_KEY = 'codeNotes.tour' // posKey of the running tour (restored after a reload)
export const POS_KEY = 'codeNotes.journeyPos' // posKey -> where each journey was left { step, at }
export const MAP_KEY = 'codeNotes.mapJourney' // posKey of the journey last shown on the map

type Pos = { step: number; id?: string; at: string }
export type TourItems = { prev: vscode.StatusBarItem; pos: vscode.StatusBarItem; next: vscode.StatusBarItem; end: vscode.StatusBarItem }

/** What the walk uses from the rest of the extension. */
export interface WalkHost {
  readonly journeys: Journeys
  readonly mapPanel: MapPanel
  readonly state: vscode.Memento
  readonly log: vscode.LogOutputChannel
  readonly beats: Beats
  readonly codeLinks: CodeLinks
  readonly tourItems: TourItems
  now(): string
  /** The Notes view. */
  refreshTree(): void
  /** A step question's back-link says less while you walk its journey: its thread is drawn again. */
  syncStepNotes(): void
  setCtx(k: string, v: unknown): Thenable<unknown>
  /** The note a code link of a check thread belongs to, if it is one. */
  checkLinkNote(key: string): unknown
  endTour(): Promise<void>
  finishTour(): Promise<void>
  revealJourneyRow(lj: LoadedJourney): void
  /** Milliseconds until a thread may be made on this file (0: now). */
  editorSettling(uri: vscode.Uri): number
  /** Notes on lines `at` of `uri` fold, so the step comes first. */
  foldNotes(uri: vscode.Uri, at: { start: number; end: number }): void
  refreshDecorations(): void
  /** A check's tour: its steps and the open questions between them. */
  stopsOf(lj: LoadedJourney): { step: number; q?: string }[]
  openCheckpoint(lj: LoadedJourney, id: string): Promise<boolean>
  pickJourney(): Promise<LoadedJourney | undefined>
  panelFits(): Promise<boolean>
}

export class Walk {
  constructor(private readonly tour: TourState, private readonly card: StepCard, private readonly host: WalkHost) {}

  tourJourney(): LoadedJourney | undefined { return this.tour.key ? this.host.journeys.list.get(this.tour.key) : undefined }
  /** A tour is running (not just a map open): only then the status bar, the step card and D/A belong to it. */
  touring(): boolean { return !!this.tourJourney() && this.tour.step > 0 }

  positions(): Record<string, Pos> { return this.host.state.get<Record<string, Pos>>(POS_KEY) ?? {} }
  /** Where this journey was left (0: never started): the same step by id when it still exists, else the same number. */
  resumeAt(lj: LoadedJourney): number {
    const p = this.positions()[posKey(lj)]
    if (!p) return 0
    const i = p.id ? lj.j.steps.findIndex((s) => s.id === p.id) : -1
    return i >= 0 ? i + 1 : Math.min(p.step, lj.j.steps.length)
  }
  async savePos(lj: LoadedJourney, step: number): Promise<void> {
    await this.host.state.update(POS_KEY, { ...this.positions(), [posKey(lj)]: { step, id: lj.j.steps[step - 1]?.id, at: this.host.now() } })
  }

  /** The journey file changed during a tour: stay on the same step (by id); if it was removed, its neighbour. */
  followStep(): void {
    const { tour, card, host } = this
    const lj = this.tourJourney()
    if (!lj || !tour.step) return
    const i = lj.j.steps.findIndex((s) => s.id === tour.stepId)
    if (i >= 0) { if (tour.step !== i + 1) vscode.window.setStatusBarMessage(`$(info) Journey updated: this step is now ${i + 1}/${lj.j.steps.length}`, 5000); tour.step = i + 1 }
    else {
      if (!lj.j.steps.length) { void host.endTour(); return }
      tour.step = Math.min(tour.step, lj.j.steps.length)
      tour.stepId = lj.j.steps[tour.step - 1].id
      // Said on the card, where the eyes are, and the editor goes with it.
      tour.cardNotice = { id: tour.stepId, text: `The step you were on was removed from the journey. This is the next one (${tour.step}/${lj.j.steps.length}).` }
      vscode.window.setStatusBarMessage(`$(info) The step you were on was removed from the journey: now at ${tour.step}/${lj.j.steps.length}`, 5000)
    }
    void this.savePos(lj, tour.step)
    if (i < 0) { void this.goToStep(lj, tour.step, { focus: false }); return } // map, card AND editor on the new step
    // The agent re-anchored this step (other file or lines): the editor follows the card, with one line saying so.
    const s = lj.j.steps[i], was = tour.shownAt
    if (was && was.key === lj.key && was.id === s.id) {
      void host.journeys.locate(lj, (k) => k === i + 1).then(() => {
        const at = lj.at[i], f = fileOf(lj, i + 1)
        if (tour.step !== i + 1 || this.tourJourney() !== lj) return
        // Only a change in the journey file is "updated": code that moved or came back is just shown, no notice.
        const rewritten = wroteAt(lj, i + 1) !== was.wrote
        const elsewhere = f !== was.file || at.start !== was.start || at.end !== was.end || !!at.removed !== was.removed
        if (!rewritten && tour.cardNotice?.id === s.id) tour.cardNotice = undefined
        if (rewritten && elsewhere) {
          tour.cardNotice = { id: s.id, text: `This step was updated: its code is now at ${f.split('/').pop()}:${at.start}.` }
          void this.goToStep(lj, i + 1, { focus: false })
        } else if (elsewhere) void this.goToStep(lj, i + 1, { focus: false })
        else { card.show(lj, tour.step); this.updateTour() }
      })
      host.refreshTree()
      return
    }
    card.show(lj, tour.step)
    this.updateTour()
    host.refreshTree()
  }

  /** Step number -> 'stale' (its code can't be found), for the map. */
  stepMarks(lj: LoadedJourney): Record<number, string> {
    const out: Record<number, string> = {}
    lj.at.forEach((a, i) => { if (a.stale) out[i + 1] = 'stale' })
    return out
  }

  /** "3/13", "at 3/13" (left there), "13 steps". */
  progress(lj: LoadedJourney): string {
    const total = lj.j.steps.length
    if (lj.key === this.tour.key && this.tour.step) return `${this.tour.step}/${total}`
    const r = this.resumeAt(lj)
    return r ? `at ${r}/${total}` : `${total} step${total === 1 ? '' : 's'}`
  }

  updateTour(): void {
    const { tour, card, host } = this
    const { mapPanel, codeLinks, tourItems } = host
    const lj = this.tourJourney()
    // A code link's way back is to the step it was clicked on: the walk moved on or ended, the link (and its Back) goes.
    if (tour.linkBack && (tour.linkBack.journey !== tour.key || tour.linkBack.step !== tour.step)) { tour.linkBack = undefined; if (!host.checkLinkNote(codeLinks.state.key ?? '')) codeLinks.unlight() }
    if (tour.key && !lj) {
      // The journey file was deleted: the tour ends with one notice; the map says so.
      if (tour.step) vscode.window.setStatusBarMessage('$(info) The journey was deleted; it ended', 5000)
      mapPanel.markDeleted(tour.key)
      tour.key = undefined; tour.step = 0; tour.doc = undefined; card.clear(); void host.state.update(TOUR_KEY, undefined)
    }
    if (lj && tour.step > lj.j.steps.length) tour.step = lj.j.steps.length
    // A step question's back-link says less while you walk its journey.
    host.syncStepNotes()
    host.setCtx('codeNotes.journeyActive', this.touring())
    card.lensChanged.fire() // the step lenses show only outside a walk
    host.setCtx('codeNotes.hasJourneys', host.journeys.all().length > 0)
    mapPanel.update()
    if (!lj || !tour.step) { for (const i of Object.values(tourItems)) i.hide(); return }
    // Only while a tour runs, and one item: "3/13", click = the map; ‹ › × live on the map and the card.
    const total = lj.j.steps.length
    // "3/14": the journey's name is the map tab's title; a one-line tooltip.
    tourItems.pos.text = `$(map) ${tour.step}/${total}`
    tourItems.pos.accessibilityInformation = { label: `${lj.j.title}, step ${tour.step} of ${total}. Opens the map.` }
    tourItems.pos.tooltip = `${lj.j.title}: open the map`
    tourItems.pos.show()
    tourItems.prev.hide(); tourItems.next.hide(); tourItems.end.hide()
  }

  /** The code group: never the map's. The one the tour used, else another visible editor's, else the other side. */
  readonly codeColumn = (): vscode.ViewColumn | undefined => {
    const tour = this.tour
    const mapCol = this.host.mapPanel.viewColumn
    if (mapCol === undefined) return tour.doc?.column ?? vscode.window.activeTextEditor?.viewColumn
    if (tour.doc && tour.doc.column !== mapCol && vscode.window.tabGroups.all.some((g) => g.viewColumn === tour.doc!.column)) return tour.doc.column
    return vscode.window.visibleTextEditors.find((e) => e.viewColumn !== undefined && e.viewColumn !== mapCol)?.viewColumn
      ?? (mapCol === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One)
  }

  /**
   * Where to show a file: the editor that already shows it (outside the map's group), else the code group. A second
   * editor on the same file makes VS Code build a second comment widget for a thread made just after (the step card,
   * a new note) before the thread's first state arrives, and those widgets loop on its collapsed state ("Maximum call
   * stack size exceeded"; the card or thread then stays collapsed). See SETTLE_MS.
   */
  columnFor(uri: vscode.Uri): vscode.ViewColumn | undefined {
    const mapCol = this.host.mapPanel.viewColumn
    return vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString() && e.viewColumn !== undefined && e.viewColumn !== mapCol)?.viewColumn ?? this.codeColumn()
  }

  showMap(lj: LoadedJourney, preserveFocus = false): void {
    this.host.mapPanel.show(lj, preserveFocus, this.tour.doc?.column)
    void this.host.state.update(MAP_KEY, posKey(lj))
  }

  /** Opens step n: the code in the code group as a preview tab (one tab, reused:), the step card above its lines. */
  async goToStep(lj: LoadedJourney, n: number, opts: { focus?: boolean } = {}): Promise<void> {
    this.tour.stepping++
    try { await this.openStep(lj, n, opts) } finally { this.tour.stepping-- }
  }

  private async openStep(lj: LoadedJourney, n: number, opts: { focus?: boolean }): Promise<void> {
    const { tour, card, host } = this
    const { mapPanel, beats, journeys } = host
    if (!lj.j.steps.length) return
    const gen = ++tour.stepGen
    // Superseded by a step opened since, elsewhere (the same step opened again, e.g. once its file moved: both go on).
    const stale = () => gen !== tour.stepGen && (tour.key !== lj.key || tour.step !== n)
    n = Math.max(1, Math.min(n, lj.j.steps.length))
    // Another step: the last one's beat is no longer lit (its scene sends the new step's beats).
    if (tour.step !== n || tour.key !== lj.key) beats.clear()
    // A step opened: the walk is on the step, not at a question after it (openCheckpoint sets that after).
    tour.cp = undefined
    if (tour.key && tour.key !== lj.key && tour.step) { await this.leaveJourney(); if (stale()) return } // one journey at a time, ended cleanly
    if (tour.step === 0 || tour.key !== lj.key) tour.detailsOpen = false
    if (tour.step !== n) tour.detailsOpen = false
    tour.key = lj.key
    tour.step = n
    tour.finishedKey = undefined
    tour.stepId = lj.j.steps[n - 1].id
    // The map shows the journey being walked: another journey's map (a look) gives way when a step moves.
    if (mapPanel.journey && mapPanel.journey.key !== lj.key) this.showMap(lj, true)
    // Stored, not waited for (each a round trip to the window; what is read back is in memory already).
    void host.state.update(TOUR_KEY, posKey(lj)).then(undefined, (e) => host.log.error(`tour: ${e}`))
    void this.savePos(lj, n).then(undefined, (e) => host.log.error(`tour: ${e}`))
    await journeys.locate(lj, (k) => k === n)
    if (stale()) return
    this.updateTour()
    host.refreshTree()
    const file = fileOf(lj, n)
    const uri = vscode.Uri.joinPath(lj.folder.uri, file)
    // A file that is gone: no stand-in tab; the card, in the map, says so.
    const [, gone] = await Promise.all([card.checkRefs(lj, n), wfs.stat(uri).then(() => false, () => true)])
    if (stale()) return
    tour.fileGone = gone
    // Its code was deleted: no code under the card pretending to be it; the card shows what it was.
    if (tour.cardNotice && tour.cardNotice.id !== tour.stepId) tour.cardNotice = undefined
    tour.shownAt = { key: lj.key, id: tour.stepId, file, start: lj.at[n - 1].start, end: lj.at[n - 1].end, removed: !!lj.at[n - 1].removed, wrote: wroteAt(lj, n) }
    if (tour.fileGone || lj.at[n - 1].removed) {
      tour.refHere = undefined
      card.show(lj, n)
      this.showMap(lj, true)
      host.revealJourneyRow(lj)
      return
    }
    const column = this.columnFor(uri)
    ownSelection(1500) // the file's caret and the step's: not a chat link
    const editor = await vscode.window.showTextDocument(uri, { preview: true, preserveFocus: opts.focus === false, ...(column ? { viewColumn: column } : {}) })
    if (stale()) return
    if (editor.viewColumn) tour.doc = { uri, column: editor.viewColumn }
    // Steps right after opening the file: anchoring against the open document (unsaved edits count).
    await journeys.locate(lj, (k) => k === n)
    if (stale()) return
    const at = lj.at[n - 1]
    tour.shownAt = { key: lj.key, id: tour.stepId!, file, start: at.start, end: at.end, removed: !!at.removed, wrote: wroteAt(lj, n) }
    tour.refHere = undefined
    // The editor just opened on this file: the card is made once it has settled (see editorSettling).
    const settle = host.editorSettling(uri)
    if (settle) { await new Promise((r) => setTimeout(r, settle)); if (stale() || tour.key !== lj.key || tour.step !== n) return }
    card.show(lj, n)
    // The card lives in the map ("panel"): the map is open beside the code.
    if (card.inMap(lj, n) && mapPanel.journey?.key !== lj.key) this.showMap(lj, true)
    const first = Math.max(0, at.removed ? 0 : at.start - 1)
    tour.cursorUntil = Date.now() + 600
    editor.selection = new vscode.Selection(first, 0, first, 0)
    // A note on the step's lines folds, so the step comes first; it stays unread.
    host.foldNotes(uri, at)
    // The card (or the marker line) sits above the step's lines: bring it to the top, so card and code are both on
    // screen. Again once the card is drawn: a jump from the map otherwise left the card above the view.
    // While the step's animation lights a beat, the beat's line is what is on screen: brought back once,
    // in case this step's file was shown over it.
    let beatBack = false
    const top = () => {
      if (beats.lit) { if (!beatBack && tour.step === n && tour.key === lj.key) { beatBack = true; void beats.again(this.codeColumn) } return }
      if (tour.step === n && tour.key === lj.key) { const l = Math.max(0, Math.min(cardLine(lj, n), lj.at[n - 1].start - 1) - 1); editor.revealRange(new vscode.Range(l, 0, l, 0), vscode.TextEditorRevealType.AtTop) } }
    top()
    setTimeout(top, 120)
    setTimeout(top, 400)
    host.refreshDecorations()
    host.revealJourneyRow(lj)
  }

  /**
   * A journey left for another one mid-way: it ends cleanly (card, status item, marker go:), its place kept
   * for Resume; no toast.
   */
  async leaveJourney(): Promise<void> {
    const lj = this.tourJourney()
    const n = this.tour.step
    await this.host.endTour()
    if (lj && n) this.tour.lastLeft = { title: lj.j.title, at: `${n}/${lj.j.steps.length}` }
  }

  async stepBy(dir: 1 | -1): Promise<void> {
    const { tour, host } = this
    if (this.touring() && this.tourJourney()!.check) {
      // A check's tour: its open questions are stops between the steps.
      const lj = this.tourJourney()!
      const stops = host.stopsOf(lj)
      let i = stops.findIndex((x) => x.step === tour.step && x.q === tour.cp)
      if (i < 0) i = stops.findIndex((x) => x.step === tour.step && !x.q)
      const to = stops[i + dir]
      if (!to) { if (dir > 0) return host.finishTour(); vscode.window.setStatusBarMessage('$(info) First step', 2000); return }
      if (to.q) { await host.openCheckpoint(lj, to.q); return }
      return this.goToStep(lj, to.step)
    }
    if (this.touring()) {
      const lj = this.tourJourney()!
      const n = tour.step + dir
      if (n > lj.j.steps.length) return host.finishTour()
      if (n < 1) { vscode.window.setStatusBarMessage('$(info) First step', 2000); return }
      return this.goToStep(lj, n)
    }
    // No tour: start (or resume) the journey whose map is open, else pick one.
    const lj = this.tourJourney() ?? (await host.pickJourney())
    // Just finished: next is not step 1 again; the panel says Done.
    if (lj && tour.finishedKey === lj.key) { vscode.window.setStatusBarMessage('$(check) Journey finished', 2500); if (host.mapPanel.journey || (await host.panelFits())) this.showMap(lj); return }
    if (lj) await this.goToStep(lj, this.resumeAt(lj) || 1)
  }
}
