// The step card: the running step's text above its code (a read-only comment thread), or in the map when the step
// has no code to sit on; the bar on the step's lines and the ref opened from the card.
import * as vscode from 'vscode'
import { setDecorations } from '../decorations'
import { readLinks, readValues } from '../journeyModel'
import { escapeTags } from '../journeys/textFormat'
import { Journeys } from '../journeys/journeys'
import { MapPanel } from '../journeys/mapPanel'
import { fileOf, LoadedJourney } from '../journeys/steps'
import { CodeLinks } from '../codeLinks'
import { ValueHints } from '../valueHints'
import { codeLinkMarkup, linkPhrases, PH, PH_RE } from '../codeLinkText'
import { TourState } from './state'
import { StepRef, StepTextInput, refFiles, staleText, stepText } from './stepText'

/** The tutorial's highlight: what its cards point at on the step card. */
export const TUTORIAL_HI = 'var(--vscode-editor-findMatchHighlightBackground)'

/** A step's questions, as far as the card shows them (the note to open; an update was asked). */
export interface CardAsked { id: string; update: boolean }

/** What the card uses from the rest of the extension. */
export interface CardHost {
  readonly journeys: Journeys
  readonly mapPanel: MapPanel
  readonly codeLinks: CodeLinks
  readonly valueHints: ValueHints
  /** A tour is running (not just a map open). */
  touring(): boolean
  tourJourney(): LoadedJourney | undefined
  /** Step n -> its questions. */
  askedOf(lj: LoadedJourney): Record<number, CardAsked>
  /** "2 asked · new reply". */
  askedText(a: CardAsked): string
  /** On a check's tour: the next stop (a question `q`, or a step). */
  nextStop(lj: LoadedJourney): { q?: string } | undefined
  /** A journey of the repository that walks the same files, as a link. */
  seeAlsoLink(files: string[]): string | undefined
  /** What the map's tutorial points at on the card now. */
  tutorialMark(): '' | 'card' | 'links'
  cmdLink(label: string, command: string, ...args: unknown[]): string
  /** A file's lines (undefined: it doesn't exist). */
  linesOfUri(uri: vscode.Uri): Promise<string[] | undefined>
  // Comment threads made only once their editor has settled (see SETTLE_MS in the extension).
  editorSettling(uri: vscode.Uri): number
  settling(t: vscode.CommentThread): number
  whenSettled(t: vscode.CommentThread, key: string, fn: () => void): void
  readonly settleLater: Map<string, NodeJS.Timeout>
  newThread(c: vscode.CommentController, uri: vscode.Uri, range: vscode.Range, comments?: vscode.Comment[]): vscode.CommentThread
  setThread<K extends 'canReply' | 'contextValue' | 'label' | 'collapsibleState'>(t: vscode.CommentThread, k: K, v: vscode.CommentThread[K]): void
}

/** Where the step's card goes: its file. */
export function stepUri(lj: LoadedJourney, n: number): vscode.Uri {
  const f = fileOf(lj, n)
  return vscode.Uri.joinPath(lj.folder.uri, f)
}

/**
 * The 0-based line the inline card hangs under (VS Code draws a thread under its line): the line right before the
 * step's first line, always (you read the card, then the code; above a doc comment it left the code at the
 * bottom edge). A step on line 1 has its card under that line.
 */
export function cardLine(lj: LoadedJourney, n: number): number {
  const at = lj.at[n - 1]
  if (at.removed) return 0
  return Math.max(0, at.start - 2)
}

/** Where the journey file puts step n (a change there is the agent re-anchoring it). */
export const wroteAt = (lj: LoadedJourney, n: number) => { const s = lj.j.steps[n - 1]; return `${s.file}:${s.range.start}-${s.range.end}` }

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

  constructor(private readonly tour: TourState, private readonly host: CardHost) {}

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
    const moved = this.host.journeys.renames(lj)
    for (const f0 of refFiles(s)) {
      const f = moved.get(f0) ?? f0
      const k = `${lj.folder.uri}|${f}`
      const ls = await this.host.linesOfUri(vscode.Uri.joinPath(lj.folder.uri, f))
      if (ls) { this.tour.refGone.delete(k); this.tour.refLines.set(k, ls.length) } else { this.tour.refGone.add(k); this.tour.refLines.delete(k) }
    }
  }

  /** What a step's text depends on besides the journey (stepText.ts). */
  private textInput(lj: LoadedJourney): StepTextInput {
    return { renames: this.host.journeys.renames(lj), refGone: this.tour.refGone, refLines: this.tour.refLines, detailsOpen: this.tour.detailsOpen }
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
    const a = this.host.askedOf(lj)[n]
    return { n, lead: t.lead, ...(t.details ? { details: t.details } : {}), refs: t.refs, stale: t.stale || (tour.fileGone && tour.step === n),
      staleText: this.staleText(lj, n, a?.update ? `[Asked ›](note:${a.id})` : '[Ask](ask:update)'), open: tour.detailsOpen,
      ...(tour.cardNotice && tour.cardNotice.id === lj.j.steps[n - 1].id ? { notice: tour.cardNotice.text } : {}), title: lj.j.steps[n - 1].title, paths }
  }

  markdown(lj: LoadedJourney, n: number): vscode.MarkdownString {
    const { tour, host } = this
    const { cmdLink } = host
    const tutorialMark = host.tutorialMark()
    const total = lj.j.steps.length
    // The link's hover is the whole path; a stale one says its line may be off.
    const t = this.text(lj, n, (r) => `[${r.label}](command:codeNotes.openAt?${encodeURIComponent(JSON.stringify([lj.folder.uri.toString(), r.file, r.line, r.end, n]))} "${r.file}:${r.line}${r.end > r.line ? `-${r.end}` : ''}${r.stale ? ' (the code changed: this line may be off)' : ''}")`)
    const parts: string[] = []
    // Its code can't be found: say what happened first, and the one thing to do; nothing else is highlighted.
    const asked = host.askedOf(lj)[n]
    // One action: ask (the note box opens prefilled:); once asked, the way to that note.
    const st = this.staleText(lj, n, asked?.update ? cmdLink('Asked ›', 'codeNotes.openNoteId', asked.id) : cmdLink('Ask', 'codeNotes.askStepUpdate'))
    // A slim band: under the header line "3/14 · title", one row ‹ › Ask (More), then the lead; More grows the
    // card below, so ‹ › never move. The step's questions are one of the actions; More holds
    // the details and the references.
    const nav = [
      // Words beside the glyphs: a bare ‹ › is too small a target.
      n > 1 ? cmdLink('‹ Previous', 'codeNotes.previousStep') : '',
      // A check's tour: Next goes to the question placed after this step, when one is open.
      lj.check && host.nextStop(lj)?.q ? cmdLink('Question ›', 'codeNotes.nextStep') : n < total ? cmdLink('Next ›', 'codeNotes.nextStep') : cmdLink('Finish', 'codeNotes.nextStep'),
      asked ? cmdLink(`${host.askedText(asked)} ›`, 'codeNotes.openNoteId', asked.id) : '',
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
    host.valueHints.present(linkKey, lj.folder.uri, readValues(lj.j.steps[n - 1].values), host.journeys.renames(lj))
    if (links.length) host.codeLinks.present(linkKey, lj.folder.uri, links, host.journeys.renames(lj), [...usedLinks]); else host.codeLinks.clear()
    if (tour.detailsOpen && t.refs) parts.push(t.refs)
    // The end of a check's tour: a journey of the repository that walks the same code, if there is one.
    if (lj.check && n === total) { const also = host.seeAlsoLink([...new Set(lj.j.steps.map((x) => fileOf(lj, x.n)))]); if (also) parts.push(`See also: ${also}`) }
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
    const { host } = this
    this.lensChanged.fire()
    if (this.inMap(lj, n)) { this.thread?.dispose(); this.thread = undefined; host.mapPanel.update(); return }
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
      const wait = host.editorSettling(uri)
      if (wait) {
        clearTimeout(host.settleLater.get('card'))
        host.settleLater.set('card', setTimeout(() => { host.settleLater.delete('card'); if (host.touring() && host.tourJourney() === lj && this.tour.step === n) this.show(lj, n) }, wait))
        return
      }
      this.thread?.dispose()
      this.thread = host.newThread(this.controller, uri, range, [{ body: this.markdown(lj, n), mode: vscode.CommentMode.Preview, author: { name: '' }, contextValue: 'step' }])
    } else if (host.settling(this.thread!)) {
      // Made just now (see SETTLE_MS): this update follows once its first state is in the workbench.
      host.whenSettled(this.thread!, 'card', () => { if (host.touring() && host.tourJourney() === lj && this.tour.step === n) this.show(lj, n) })
      return
    }
    const t = this.thread!
    host.setThread(t, 'canReply', false)
    host.setThread(t, 'contextValue', 'step')
    // The card's first line is "3/14 · <title>": the position once, and the title, since the map may not be
    // in view from the code. A stale step says so in its text.
    host.setThread(t, 'label', label)
    const body = this.markdown(lj, n)
    if (fresh || (t.comments[0]?.body as vscode.MarkdownString | undefined)?.value !== body.value)
      t.comments = [{ body, mode: vscode.CommentMode.Preview, author: { name: '' }, contextValue: 'step' }]
    host.setThread(t, 'collapsibleState', vscode.CommentThreadCollapsibleState.Expanded)
  }

  /**
   * The step's card and marker belong to the step's lines, not to a tab: whenever its file is on screen again (Go Back,
   * "Back to step", a tab switch, the file reopened) they are there. A preview tab that was replaced
   * closed the document, and VS Code drops a thread's widget with it: the thread is made again.
   */
  restore(): void {
    const tour = this.tour
    const lj = this.host.touring() ? this.host.tourJourney() : undefined
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
    const lj = this.host.touring() ? this.host.tourJourney() : undefined
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
