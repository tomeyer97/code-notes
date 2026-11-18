// The step card: the running step's text above its code (a read-only comment thread), or in the map when the step
// has no code to sit on; the bar on the step's lines and the ref opened from the card.
import * as vscode from 'vscode'
import { cmdLink, codeLinks, journeys, mapPanel, valueHints } from '../app'
import { codeLinkMarkup, linkPhrases, PH, PH_RE, readLinks } from '../codeLinkText'
import { setDecorations } from '../decorations'
import { escapeTags, readValues } from '../journeyModel'
import { fileOf, LoadedJourney } from '../journeys/steps'
import { askedOf, askedText } from '../sidebar/journeyRows'
import { linesOfUri } from '../threads/anchoring'
import { editorSettling, newThread, setThread, settleLater, settling, whenSettled } from '../threads/settle'
import { nextStop, seeAlsoLink } from './checkTour'
import { TourState } from './state'
import { cardLine, stepUri } from './stepPlace'
import { StepRef, StepTextInput, refFiles, staleText, stepText } from './stepText'
import { walk } from './tour'
import { tutorialMark } from './tutorial'

/** The tutorial's highlight: what its cards point at on the step card. */
const TUTORIAL_HI = 'var(--vscode-editor-findMatchHighlightBackground)'

export class StepCard {
  /** The step card: read-only comment threads of their own controller (no menus, no reply box). */
  controller!: vscode.CommentController
  thread: vscode.CommentThread | undefined
  deco!: { at: vscode.TextEditorDecorationType; stale: vscode.TextEditorDecorationType }
  refDeco: vscode.TextEditorDecorationType | undefined
  /** Empty note boxes opened by "Ask about this step": what the note will say it is about. */
  readonly asks = new Map<vscode.CommentThread, { about: string; link: { id: string; step: string; n: number } }>()
  /** The marker line above the step ("panel") and "Back to step" above a ref: code lenses. */
  readonly lensChanged = new vscode.EventEmitter<void>()

  constructor(private readonly tour: TourState) {}

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
    const s = lj.j.steps[n - 1]
    const moved = journeys.renames(lj)
    for (const f0 of refFiles(s)) {
      const f = moved.get(f0) ?? f0
      const k = `${lj.folder.uri}|${f}`
      const ls = await linesOfUri(vscode.Uri.joinPath(lj.folder.uri, f))
      if (ls) { this.tour.refGone.delete(k); this.tour.refLines.set(k, ls.length) } else { this.tour.refGone.add(k); this.tour.refLines.delete(k) }
    }
  }

  /** What a step's text depends on besides the journey (stepText.ts). */
  private textInput(lj: LoadedJourney): StepTextInput {
    return { renames: journeys.renames(lj), refGone: this.tour.refGone, refLines: this.tour.refLines, detailsOpen: this.tour.detailsOpen }
  }
  text(lj: LoadedJourney, n: number, link: (r: StepRef) => string) { return stepText(lj, n, link, this.textInput(lj)) }
  staleText(lj: LoadedJourney, n: number, ask: string) { return staleText(lj, n, ask, this.tour.fileGone && this.tour.step === n) }

  /** The panel's step card, and the links it shows (posted back by index). */
  panelCard(lj: LoadedJourney, n: number) {
    const tour = this.tour
    const refs: StepRef[] = []
    const t = this.text(lj, n, (r) => { refs.push(r); return `[${r.label.replace(/[[\]]/g, '').replace(/^.*\//, '')}](ref:${refs.length - 1})` })
    tour.panelRefs = refs
    const paths = refs.map((r) => `${r.file}:${r.line}${r.end > r.line ? `-${r.end}` : ''}`)
    const a = askedOf(lj)[n]
    return { n, lead: t.lead, ...(t.details ? { details: t.details } : {}), refs: t.refs, stale: t.stale || (tour.fileGone && tour.step === n),
      staleText: this.staleText(lj, n, a?.update ? `[Asked ›](note:${a.id})` : '[Ask](ask:update)'), open: tour.detailsOpen,
      ...(tour.cardNotice && tour.cardNotice.id === lj.j.steps[n - 1].id ? { notice: tour.cardNotice.text } : {}), title: lj.j.steps[n - 1].title, paths }
  }

  markdown(lj: LoadedJourney, n: number): vscode.MarkdownString {
    const { tour } = this
    const total = lj.j.steps.length
    // The link's hover is the whole path; a stale one says its line may be off.
    const t = this.text(lj, n, (r) => `[${r.label}](command:codeNotes.openAt?${encodeURIComponent(JSON.stringify([lj.folder.uri.toString(), r.file, r.line, r.end, n]))} "${r.file}:${r.line}${r.end > r.line ? `-${r.end}` : ''}${r.stale ? ' (the code changed: this line may be off)' : ''}")`)
    const parts: string[] = []
    // Its code can't be found: say what happened first, and the one thing to do; nothing else is highlighted.
    const asked = askedOf(lj)[n]
    // One action: ask (the note box opens prefilled:); once asked, the way to that note.
    const st = this.staleText(lj, n, asked?.update ? cmdLink('Asked ›', 'codeNotes.openNoteId', asked.id) : cmdLink('Ask', 'codeNotes.askStepUpdate'))
    // A slim band: under the header line "3/14 · title", one row ‹ › Ask (More), then the lead; More grows the
    // card below, so ‹ › never move. The step's questions are one of the actions; More holds
    // the details and the references.
    const nav = [
      // Words beside the glyphs: a bare ‹ › is too small a target.
      n > 1 ? cmdLink('‹ Previous', 'codeNotes.previousStep') : '',
      // A check's tour: Next goes to the question placed after this step, when one is open.
      lj.check && nextStop(lj)?.q ? cmdLink('Question ›', 'codeNotes.nextStep') : n < total ? cmdLink('Next ›', 'codeNotes.nextStep') : cmdLink('Finish', 'codeNotes.nextStep'),
      asked ? cmdLink(`${askedText(asked)} ›`, 'codeNotes.openNoteId', asked.id) : '',
      // One Ask: a stale step's is the banner's, which opens the request prefilled.
      st ? '' : cmdLink('Ask', 'codeNotes.askStep'),
      t.details || t.refs ? (tour.detailsOpen ? cmdLink('Less', 'codeNotes.stepDetails', false) : cmdLink('More', 'codeNotes.stepDetails', true)) : '',
    ].filter(Boolean)
    // Real no-break spaces, not &nbsp;: VS Code reads the card's Markdown source aloud.
    // the warning (a stale step), the lead, then the buttons; More grows below them; a notice last, quiet.
    if (st) parts.push(st)
    // Code links: a phrase that is a link to the lines doing what it says: the text's own colour on a
    // faint tint (theme colours, so every theme; never a reference's blue), the tint its lines carry in the code. Placeholders here; the markup goes in after escapeTags.
    const links = readLinks(lj.j.steps[n - 1].links)
    const linkKey = `${lj.key}|${lj.j.steps[n - 1].id}`
    const usedLinks = new Set<number>()
    const mark = (x: string) => linkPhrases(x, links, usedLinks, PH)
    if (t.lead) parts.push(mark(t.lead))
    parts.push(nav.join('   '))
    if (tour.detailsOpen && t.details) parts.push(mark(t.details))
    // Only the phrases on the card now have their lines marked: those behind "More" while it is open.
    // Value hints: what the step's variables hold in the example run, faint, above their lines.
    valueHints.present(linkKey, lj.folder.uri, readValues(lj.j.steps[n - 1].values), journeys.renames(lj))
    if (links.length) codeLinks.present(linkKey, lj.folder.uri, links, journeys.renames(lj), [...usedLinks]); else codeLinks.clear()
    if (tour.detailsOpen && t.refs) parts.push(t.refs)
    // The end of a check's tour: a journey of the repository that walks the same code, if there is one.
    if (lj.check && n === total) { const also = seeAlsoLink([...new Set(lj.j.steps.map((x) => fileOf(lj, x.n)))]); if (also) parts.push(`See also: ${also}`) }
    // What just changed under the reader, once, on this step.
    if (tour.cardNotice && tour.cardNotice.id === lj.j.steps[n - 1].id) parts.push(`_ℹ ${tour.cardNotice.text}_`)
    // `<name>` in the text is text: VS Code's renderer would drop it as an HTML tag.
    const body = escapeTags(parts.join('\n\n')).replace(PH_RE, (_m, i: string, phrase: string) =>
      codeLinkMarkup(linkKey, Number(i), links[Number(i)], phrase, tutorialMark === 'links' ? TUTORIAL_HI : undefined))
    // The tutorial's card about this card: its buttons stand out while that card is up.
    const shown = tutorialMark !== 'card' ? body : body.replace(/\[([^\]]+)\]\(command:codeNotes\.(nextStep|previousStep|askStep|stepDetails)/g, (_m, label: string, c: string) => `[<span style="color:var(--vscode-foreground);background-color:${TUTORIAL_HI};">${label}</span>](command:codeNotes.${c}`)
    const md = new vscode.MarkdownString(shown)
    md.isTrusted = { enabledCommands: ['codeNotes.codeLink', 'codeNotes.openAt', 'codeNotes.nextStep', 'codeNotes.previousStep', 'codeNotes.endJourney', 'codeNotes.askStep', 'codeNotes.askStepUpdate', 'codeNotes.openNoteId', 'codeNotes.stepDetails', 'codeNotes.openStepLink'] }
    // Only for the code links' colour; every other tag in the text was escaped above.
    md.supportHtml = links.length > 0 || tutorialMark === 'card'
    md.baseUri = lj.folder.uri
    return md
  }

  /**
   * The step card: a comment thread of its own controller ("Journey"), so none of the note menus apply: no reply box,
   * no author picture, no time, no resolve/delete. Its header is "3/14 · <title>"; the body has no author line.
   */
  show(lj: LoadedJourney, n: number): void {
    this.lensChanged.fire()
    if (this.inMap(lj, n)) { this.thread?.dispose(); this.thread = undefined; mapPanel.update(); return }
    const s = lj.j.steps[n - 1]
    const uri = stepUri(lj, n)
    const cl = cardLine(lj, n)
    const range = new vscode.Range(cl, 0, cl, 0)
    // A new thread per step (moving one left the card drawn above the view:).
    // VS Code HTML-escapes a thread's label and then shows it as text ("&lt;script&gt;"): <, > and & are drawn
    // with look-alikes instead.
    const label = `${n}/${lj.j.steps.length} · ${s.title.replace(/</g, '‹').replace(/>/g, '›').replace(/&/g, '＆')}`
    const fresh = !this.thread || this.thread.uri.toString() !== uri.toString() || this.thread.label !== label || this.thread.range?.start.line !== range.start.line
    if (fresh) {
      // Its editor is just opening (see editorSettling): the card comes a moment later.
      const wait = editorSettling(uri)
      if (wait) {
        clearTimeout(settleLater.get('card'))
        settleLater.set('card', setTimeout(() => { settleLater.delete('card'); if (walk.touring() && walk.tourJourney() === lj && this.tour.step === n) this.show(lj, n) }, wait))
        return
      }
      this.thread?.dispose()
      this.thread = newThread(this.controller, uri, range, [{ body: this.markdown(lj, n), mode: vscode.CommentMode.Preview, author: { name: '' }, contextValue: 'step' }])
    } else if (settling(this.thread!)) {
      // Made just now (see SETTLE_MS): this update follows once its first state is in the workbench.
      whenSettled(this.thread!, 'card', () => { if (walk.touring() && walk.tourJourney() === lj && this.tour.step === n) this.show(lj, n) })
      return
    }
    const t = this.thread!
    setThread(t, 'canReply', false)
    setThread(t, 'contextValue', 'step')
    // The card's first line is "3/14 · <title>": the position once, and the title, since the map may not be
    // in view from the code. A stale step says so in its text.
    setThread(t, 'label', label)
    const body = this.markdown(lj, n)
    if (fresh || (t.comments[0]?.body as vscode.MarkdownString | undefined)?.value !== body.value)
      t.comments = [{ body, mode: vscode.CommentMode.Preview, author: { name: '' }, contextValue: 'step' }]
    setThread(t, 'collapsibleState', vscode.CommentThreadCollapsibleState.Expanded)
  }

  /**
   * The step's card and marker belong to the step's lines, not to a tab: whenever its file is on screen again (Go Back,
   * "Back to step", a tab switch, the file reopened) they are there. A preview tab that was replaced
   * closed the document, and VS Code drops a thread's widget with it: the thread is made again.
   */
  restore(): void {
    const tour = this.tour
    const lj = walk.touring() ? walk.tourJourney() : undefined
    if (!lj || this.inMap(lj, tour.step) || tour.restoring) return
    const uri = stepUri(lj, tour.step).toString()
    const shown = vscode.window.visibleTextEditors.some((e) => e.document.uri.toString() === uri)
    const back = shown && tour.shownFor !== uri
    tour.shownFor = shown ? uri : undefined
    if (!back) return
    // Back on the step's file: the ref is left behind.
    if (tour.refHere && tour.refHere.uri !== uri && !vscode.window.visibleTextEditors.some((e) => e.document.uri.toString() === tour.refHere!.uri)) { tour.refHere = undefined; this.lensChanged.fire() }
    tour.restoring = true
    try { this.thread?.dispose(); this.thread = undefined; this.show(lj, tour.step) } finally { tour.restoring = false }
  }

  clear(): void {
    this.thread?.dispose()
    this.thread = undefined
    this.tour.refHere = undefined
    this.lensChanged.fire()
    for (const e of vscode.window.visibleTextEditors) if (this.refDeco) setDecorations(e, this.refDeco, [])
    for (const t of this.asks.keys()) t.dispose()
    this.asks.clear()
    if (this.deco) for (const e of vscode.window.visibleTextEditors) { setDecorations(e, this.deco.at, []); setDecorations(e, this.deco.stale, []) }
  }

  /** The running step's lines: a quiet bar (amber when stale). */
  refreshDecorations(): void {
    const tour = this.tour
    const lj = walk.touring() ? walk.tourJourney() : undefined
    const s = lj?.j.steps[tour.step - 1]
    tour.marked = []
    for (const e of vscode.window.visibleTextEditors) {
      const here = lj && s && e.document.uri.toString() === vscode.Uri.joinPath(lj.folder.uri, fileOf(lj, tour.step)).toString()
      const at = here ? lj!.at[tour.step - 1] : undefined
      // A stale step highlights nothing: what is there now is other code; the card says so.
      setDecorations(e, this.deco.at, at && !at.stale ? [new vscode.Range(at.start - 1, 0, at.end - 1, 0)] : [])
      if (at && !at.stale) tour.marked.push(e.document.uri.path)
      setDecorations(e, this.deco.stale, [])
      if (this.refDeco) setDecorations(e, this.refDeco, tour.refHere && lj && tour.refHere.uri === e.document.uri.toString() ? [new vscode.Range(tour.refHere.start, 0, tour.refHere.end, 0)] : [])
    }
  }
}
