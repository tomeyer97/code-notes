// The step card: the running step's text above its code (a read-only comment thread), or in the map when the step
// has no code to sit on; the bar on the step's lines and the ref opened from the card.
import * as vscode from 'vscode'
import { cmdLink, codeLinks, journeys, mapPanel, valueHints } from '../app'
import { codeLinkMarkup, linkPhrases, PH, PH_RE } from '../codeLinkText'
import { setDecorations } from '../decorations'
import { readLinks, readValues } from '../journeyModel'
import { escapeTags } from '../journeys/textFormat'
import { fileOf, LoadedJourney } from '../journeys/steps'
import { Asked, askedOf, askedText } from '../sidebar/journeyRows'
import { linesOfUri } from '../notes/location'
import { editorSettling, newThread, setThread, settleLater, settling, whenSettled } from '../threads/settle'
import { nextStop, seeAlsoLink } from './checkTour'
import { TourState } from './state'
import { cardLine, stepUri } from './stepPlace'
import { labelSafe, refFiles, StepRef, StepText, StepTextInput, staleText, stepText } from './stepText'
import { walk } from './instances'
import { tutorialMark } from './tutorial'

/** The tutorial's highlight: what its cards point at on the step card. */
const TUTORIAL_HI = 'var(--vscode-editor-findMatchHighlightBackground)'

/** The commands the card's links run: its Markdown may run these and no other. */
const CARD_COMMANDS = [
  'codeNotes.codeLink', 'codeNotes.openAt', 'codeNotes.nextStep', 'codeNotes.previousStep', 'codeNotes.endJourney',
  'codeNotes.askStep', 'codeNotes.askStepUpdate', 'codeNotes.openNoteId', 'codeNotes.stepDetails', 'codeNotes.openStepLink',
]

/** The card's buttons that stand out while the tutorial's card about the card is up (`askStep` also matches the
 *  stale banner's `askStepUpdate`). */
const TUTORIAL_BUTTONS = /\[([^\]]+)\]\(command:codeNotes\.(nextStep|previousStep|askStep|stepDetails)/g

/** Between the card's buttons: real no-break spaces, not &nbsp; (VS Code reads the card's Markdown source aloud). */
const NAV_GAP = '   '

/** `src/a.ts:40-42`: where a reference goes (a link's hover; the panel lists them). */
const refPlace = (r: StepRef) => `${r.file}:${r.line}${r.end > r.line ? `-${r.end}` : ''}`

/** A reference on the inline card: a command link; its hover is the whole path, a stale one says its line may be off. */
function commandRefLink(lj: LoadedJourney, n: number, r: StepRef): string {
  const args = encodeURIComponent(JSON.stringify([lj.folder.uri.toString(), r.file, r.line, r.end, n]))
  const hover = `${refPlace(r)}${r.stale ? ' (the code changed: this line may be off)' : ''}`
  return `[${r.label}](command:codeNotes.openAt?${args} "${hover}")`
}

/** The card's buttons on the tutorial's highlight. After escapeTags, which would escape the span (see TUTORIAL_BUTTONS). */
function emphasizeTutorialButtons(body: string): string {
  const style = `color:var(--vscode-foreground);background-color:${TUTORIAL_HI};`
  return body.replace(TUTORIAL_BUTTONS, (_m, label: string, c: string) => `[<span style="${style}">${label}</span>](command:codeNotes.${c}`)
}

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
    const { refGone, refLines } = this.tour
    const moved = journeys.renames(lj)
    for (const written of refFiles(lj.j.steps[n - 1])) {
      const f = moved.get(written) ?? written
      const k = `${lj.folder.uri}|${f}`
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

  /** What a step's text depends on besides the journey (stepText.ts). */
  private textInput(lj: LoadedJourney): StepTextInput {
    return { renames: journeys.renames(lj), refGone: this.tour.refGone, refLines: this.tour.refLines, detailsOpen: this.tour.detailsOpen }
  }

  text(lj: LoadedJourney, n: number, link: (r: StepRef) => string): StepText {
    return stepText(lj, n, link, this.textInput(lj))
  }

  /** Step n's file is gone (checked when it opened). */
  private fileGoneAt(n: number): boolean {
    return this.tour.fileGone && this.tour.step === n
  }

  staleText(lj: LoadedJourney, n: number, ask: string): string {
    return staleText(lj, n, ask, this.fileGoneAt(n))
  }

  /** What just changed under the reader, said once on this step's card. */
  private noticeFor(lj: LoadedJourney, n: number): string | undefined {
    const notice = this.tour.cardNotice
    return notice && notice.id === lj.j.steps[n - 1].id ? notice.text : undefined
  }

  /**
   * The panel's step card (the map shows it when the step has no code to sit on). The same text as the inline card
   * (markdown); its links are `ref:i` (the panel posts the index back: tour.panelRefs) and `note:` / `ask:`.
   */
  panelCard(lj: LoadedJourney, n: number) {
    const tour = this.tour
    const refs: StepRef[] = []
    const t = this.text(lj, n, (r) => {
      refs.push(r)
      const name = r.label.replace(/[[\]]/g, '').replace(/^.*\//, '')
      return `[${name}](ref:${refs.length - 1})`
    })
    tour.panelRefs = refs
    const asked = askedOf(lj)[n]
    const ask = asked?.update ? `[Asked ›](note:${asked.id})` : '[Ask](ask:update)'
    const notice = this.noticeFor(lj, n)
    return {
      n,
      lead: t.lead,
      ...(t.details ? { details: t.details } : {}),
      refs: t.refs,
      stale: t.stale || this.fileGoneAt(n),
      staleText: this.staleText(lj, n, ask),
      open: tour.detailsOpen,
      ...(notice !== undefined ? { notice } : {}),
      title: lj.j.steps[n - 1].title,
      paths: refs.map(refPlace),
    }
  }

  /**
   * The inline card's text: a stale step's warning, the lead, one row of buttons, then (More) the details and the
   * references, a check tour's "See also", and a notice last, quiet. Its code links' phrases are marked; the step's
   * code links and value hints are put on the code as it is made.
   */
  markdown(lj: LoadedJourney, n: number): vscode.MarkdownString {
    const { tour } = this
    const tutorial = tutorialMark
    const step = lj.j.steps[n - 1]
    const t = this.text(lj, n, (r) => commandRefLink(lj, n, r))
    const asked = askedOf(lj)[n]
    // Its code can't be found: say what happened first, and the one thing to do (ask: the note box opens
    // prefilled; once asked, the way to that note); nothing else is highlighted.
    const askUpdate = asked?.update ? cmdLink('Asked ›', 'codeNotes.openNoteId', asked.id) : cmdLink('Ask', 'codeNotes.askStepUpdate')
    const st = this.staleText(lj, n, askUpdate)
    const nav = this.navLinks(lj, n, t, asked, !!st)
    // Code links: a phrase that is a link to the lines doing what it says. Placeholders here; the markup goes in
    // after escapeTags.
    const links = readLinks(step.links)
    const linkKey = `${lj.key}|${step.id}`
    const usedLinks = new Set<number>()
    const mark = (x: string) => linkPhrases(x, links, usedLinks, PH)
    const parts: string[] = []
    if (st) parts.push(st)
    if (t.lead) parts.push(mark(t.lead))
    parts.push(nav.join(NAV_GAP))
    if (tour.detailsOpen && t.details) parts.push(mark(t.details))
    this.presentLinksAndHints(lj, n, linkKey, links, usedLinks)
    if (tour.detailsOpen && t.refs) parts.push(t.refs)
    const also = lj.check && n === lj.j.steps.length ? this.seeAlso(lj) : undefined
    if (also) parts.push(`See also: ${also}`)
    const notice = this.noticeFor(lj, n)
    if (notice !== undefined) parts.push(`_ℹ ${notice}_`)
    // `<name>` in the text is text: VS Code's renderer would drop it as an HTML tag.
    const linkHi = tutorial === 'links' ? TUTORIAL_HI : undefined
    const body = escapeTags(parts.join('\n\n')).replace(PH_RE, (_m, i: string, phrase: string) =>
      codeLinkMarkup(linkKey, Number(i), links[Number(i)], phrase, linkHi))
    // The tutorial's card about this card: its buttons stand out while that card is up.
    const md = new vscode.MarkdownString(tutorial === 'card' ? emphasizeTutorialButtons(body) : body)
    md.isTrusted = { enabledCommands: CARD_COMMANDS }
    // Only for the code links' colour; every other tag in the text was escaped above.
    md.supportHtml = links.length > 0 || tutorial === 'card'
    md.baseUri = lj.folder.uri
    return md
  }

  /**
   * A slim band under the header line "3/14 · title": one row ‹ › Ask (More), then the lead; More grows the card
   * below, so ‹ › never move. The step's questions are one of the actions; More holds the details and references.
   */
  private navLinks(lj: LoadedJourney, n: number, t: StepText, asked: Asked | undefined, stale: boolean): string[] {
    // Words beside the glyphs: a bare ‹ › is too small a target.
    const previous = n > 1 ? cmdLink('‹ Previous', 'codeNotes.previousStep') : ''
    // A check's tour: Next goes to the question placed after this step, when one is open.
    const nextLabel = lj.check && nextStop(lj)?.q ? 'Question ›' : n < lj.j.steps.length ? 'Next ›' : 'Finish'
    const next = cmdLink(nextLabel, 'codeNotes.nextStep')
    const questions = asked ? cmdLink(`${askedText(asked)} ›`, 'codeNotes.openNoteId', asked.id) : ''
    // One Ask: a stale step's is the banner's, which opens the request prefilled.
    const ask = stale ? '' : cmdLink('Ask', 'codeNotes.askStep')
    const open = this.tour.detailsOpen
    const more = !(t.details || t.refs) ? '' : open ? cmdLink('Less', 'codeNotes.stepDetails', false) : cmdLink('More', 'codeNotes.stepDetails', true)
    return [previous, next, questions, ask, more].filter(Boolean)
  }

  /**
   * On the code, for the step on the card: value hints (what its variables hold in the example run, faint, above their
   * lines) and its code links' lines, only those whose phrase is on the card now (`used`: those behind "More" while it
   * is open), in the text's own colour on a faint tint.
   */
  private presentLinksAndHints(lj: LoadedJourney, n: number, linkKey: string, links: ReturnType<typeof readLinks>, used: Set<number>): void {
    valueHints.present(linkKey, lj.folder.uri, readValues(lj.j.steps[n - 1].values), journeys.renames(lj))
    if (links.length) codeLinks.present(linkKey, lj.folder.uri, links, journeys.renames(lj), [...used])
    else codeLinks.clear()
  }

  /** The end of a check's tour: a journey of the repository that walks the same code, if there is one. */
  private seeAlso(lj: LoadedJourney): string | undefined {
    const files = new Set(lj.j.steps.map((x) => fileOf(lj, x.n)))
    return seeAlsoLink([...files])
  }

  /**
   * The step card: a comment thread of its own controller ("Journey"), so none of the note menus apply: no reply box,
   * no author picture, no time, no resolve/delete. Its header is "3/14 · <title>"; the body has no author line.
   */
  show(lj: LoadedJourney, n: number): void {
    this.lensChanged.fire()
    if (this.inMap(lj, n)) {
      this.thread?.dispose()
      this.thread = undefined
      mapPanel.update()
      return
    }
    const uri = stepUri(lj, n)
    const line = cardLine(lj, n)
    const range = new vscode.Range(line, 0, line, 0)
    // VS Code HTML-escapes a thread's label and then shows it as text ("&lt;script&gt;"): look-alikes instead.
    const label = `${n}/${lj.j.steps.length} · ${labelSafe(lj.j.steps[n - 1].title)}`
    // A new thread per step (moving one left the card drawn above the view:).
    const fresh = !this.isThreadAt(uri, line, label)
    if (fresh) {
      if (this.showOnceEditorSettles(lj, n, uri)) return
      this.thread?.dispose()
      this.thread = newThread(this.controller, uri, range, [cardComment(this.markdown(lj, n))])
    } else if (settling(this.thread!)) {
      // Made just now (see SETTLE_MS): this update follows once its first state is in the workbench.
      whenSettled(this.thread!, 'card', () => this.showIfStillOn(lj, n))
      return
    }
    const t = this.thread!
    setThread(t, 'canReply', false)
    setThread(t, 'contextValue', 'step')
    // The card's first line is "3/14 · <title>": the position once, and the title, since the map may not be
    // in view from the code. A stale step says so in its text.
    setThread(t, 'label', label)
    const body = this.markdown(lj, n)
    const shownBody = (t.comments[0]?.body as vscode.MarkdownString | undefined)?.value
    if (fresh || shownBody !== body.value) t.comments = [cardComment(body)]
    setThread(t, 'collapsibleState', vscode.CommentThreadCollapsibleState.Expanded)
  }

  /** The card's thread is the one for this file, line and label. */
  private isThreadAt(uri: vscode.Uri, line: number, label: string): boolean {
    const t = this.thread
    return !!t && t.uri.toString() === uri.toString() && t.label === label && t.range?.start.line === line
  }

  /** Its editor is just opening (see editorSettling): the card comes a moment later. True: it will. */
  private showOnceEditorSettles(lj: LoadedJourney, n: number, uri: vscode.Uri): boolean {
    const wait = editorSettling(uri)
    if (!wait) return false
    clearTimeout(settleLater.get('card'))
    settleLater.set('card', setTimeout(() => {
      settleLater.delete('card')
      this.showIfStillOn(lj, n)
    }, wait))
    return true
  }

  /** A card shown later: only while the walk is still on that step. */
  private showIfStillOn(lj: LoadedJourney, n: number): void {
    if (walk.isOn(lj, n)) this.show(lj, n)
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
    const isShown = (u: string) => vscode.window.visibleTextEditors.some((e) => e.document.uri.toString() === u)
    const shown = isShown(uri)
    const back = shown && tour.shownFor !== uri
    tour.shownFor = shown ? uri : undefined
    if (!back) return
    // Back on the step's file: the ref is left behind.
    if (tour.refHere && tour.refHere.uri !== uri && !isShown(tour.refHere.uri)) {
      tour.refHere = undefined
      this.lensChanged.fire()
    }
    tour.restoring = true
    try {
      this.thread?.dispose()
      this.thread = undefined
      this.show(lj, tour.step)
    } finally { tour.restoring = false }
  }

  clear(): void {
    this.thread?.dispose()
    this.thread = undefined
    this.tour.refHere = undefined
    this.lensChanged.fire()
    for (const e of vscode.window.visibleTextEditors) if (this.refDeco) setDecorations(e, this.refDeco, [])
    for (const t of this.asks.keys()) t.dispose()
    this.asks.clear()
    if (!this.deco) return
    for (const e of vscode.window.visibleTextEditors) {
      setDecorations(e, this.deco.at, [])
      setDecorations(e, this.deco.stale, [])
    }
  }

  /** The running step's lines: a quiet bar (a stale step's: none); the ref opened from the card, lit. */
  refreshDecorations(): void {
    const tour = this.tour
    const lj = walk.touring() ? walk.tourJourney() : undefined
    const s = lj?.j.steps[tour.step - 1]
    const stepFile = lj && s ? vscode.Uri.joinPath(lj.folder.uri, fileOf(lj, tour.step)).toString() : undefined
    const ref = tour.refHere
    tour.marked = []
    for (const e of vscode.window.visibleTextEditors) {
      const uri = e.document.uri.toString()
      const at = stepFile !== undefined && uri === stepFile ? lj!.at[tour.step - 1] : undefined
      // A stale step highlights nothing: what is there now is other code; the card says so.
      const lit = at && !at.stale
      setDecorations(e, this.deco.at, lit ? [new vscode.Range(at.start - 1, 0, at.end - 1, 0)] : [])
      if (lit) tour.marked.push(e.document.uri.path)
      setDecorations(e, this.deco.stale, [])
      const refLit = ref && lj && ref.uri === uri ? [new vscode.Range(ref.start, 0, ref.end, 0)] : []
      if (this.refDeco) setDecorations(e, this.refDeco, refLit)
    }
  }
}

/** The card's one comment: the text only (no author line). */
function cardComment(body: vscode.MarkdownString): vscode.Comment {
  return { body, mode: vscode.CommentMode.Preview, author: { name: '' }, contextValue: 'step' }
}
