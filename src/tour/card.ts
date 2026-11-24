// The step card: the running step's text above its code (a read-only comment thread), or in the map when the step
// has no code to sit on; the bar on the step's lines and the ref opened from the card.
import * as vscode from 'vscode'
import { beats, codeLinks, journeys, mapPanel, valueHints } from './ports'
import { walk } from './instances'
import { cmdLink, titledCmdLink } from '../platform/commands'
import { chordKey } from '../platform/chordKey'
import { codeLinkMarkup, linkPhrases, PH, PH_RE } from '../core/codeLinkText'
import { setDecorations } from '../platform/editorDecorations'
import { readLinks, readValues } from '../core/format/journeyModel'
import { escapeTags } from '../journeys/textFormat'
import type { PanelCard } from '../journeys/mapPanel'
import { fileOf, LoadedJourney } from '../journeys/steps'
import { Asked, askedOf, askedText } from '../sidebar/journeyRows'
import { refreshDecorations as refreshNoteDecorations } from '../notes/decorations'
import { linesOfUri } from '../platform/documents'
import { MarkPainter } from '../marks/lights'
import { blocksOf } from '../platform/symbolBlocks'
import { labelSafe } from '../core/text'
import { afterEditorSettles, newThread, setThread, settling, whenSettled } from '../threads/settle'
import { nextStop, seeAlsoLink } from './checkTour'
import { TourProbe, TourState } from './state'
import type { Narration } from './api'
import { cardLine, stepUri } from './stepPlace'
import { paintStepMarks, stepMarks } from './stepMarks'
import { refFiles, StepRef, StepText, StepTextInput, staleText, stepText } from './stepText'
import { tutorialMark } from './tutorial'
import { fireAndForget } from '../platform/run'
import { Cmd, HiddenCmd } from '../platform/commands'
import { folderFileKey } from '../platform/keys'

/** The tutorial's highlight: what its cards point at on the step card. */
const TUTORIAL_HI = 'var(--vscode-editor-findMatchHighlightBackground)'

/** The commands the card's links run: its Markdown may run these and no other. */
const CARD_COMMANDS = [
  HiddenCmd.codeLink, Cmd.openAt, Cmd.nextStep, Cmd.previousStep, Cmd.endJourney,
  Cmd.askStep, HiddenCmd.askStepUpdate, HiddenCmd.openNoteId, Cmd.stepDetails, HiddenCmd.openStepLink,
  Cmd.podcastToggle, HiddenCmd.podcastFollow,
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

/** How the step card draws on the code: the step's lines (a bar and a faint tint), the same while the voice tells the
 *  step, a stale step's, and a reference opened from the card. */
const CARD_LOOKS = {
  // A faint tint too: clear which lines the step is about; selection and find stay on top.
  at: {
    isWholeLine: true, borderWidth: '0 0 0 2px', borderStyle: 'solid', borderColor: new vscode.ThemeColor('textLink.foreground'),
    backgroundColor: new vscode.ThemeColor('codeNotes.stepBackground'),
    overviewRulerColor: new vscode.ThemeColor('textLink.foreground'), overviewRulerLane: vscode.OverviewRulerLane.Center,
  },
  // While the voice tells the step: a thin grey bar, no tint, nothing in the scrollbar (the marks are the colour).
  quiet: {
    isWholeLine: true, borderWidth: '0 0 0 2px', borderStyle: 'solid', borderColor: new vscode.ThemeColor('editorLineNumber.activeForeground'),
  },
  stale: {
    isWholeLine: true, borderWidth: '0 0 0 2px', borderStyle: 'dashed', borderColor: new vscode.ThemeColor('editorWarning.foreground'),
    overviewRulerColor: new vscode.ThemeColor('editorWarning.foreground'), overviewRulerLane: vscode.OverviewRulerLane.Center,
  },
  ref: {
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('textLink.foreground'),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  },
} satisfies Record<string, vscode.DecorationRenderOptions>

export class StepCard implements vscode.Disposable {
  thread: vscode.CommentThread | undefined
  /** How the step's lines were drawn last (tests): the bar and tint, the thin grey bar, or nothing. */
  look: 'tint' | 'quiet' | undefined
  /** The marker line above the step ("panel") and "Back to step" above a ref: code lenses. */
  readonly lensChanged = new vscode.EventEmitter<void>()

  /**
   * The card with its own comment controller (read-only threads: no menus, no reply box), its decorations and the
   * painter of the step's marks (a match that can't be found lights nothing). `narration`: what a podcast on the step
   * shows on it (none without one).
   */
  static create(tour: TourState, probe: TourProbe, narration: (lj: LoadedJourney, n: number) => Narration | undefined, log: vscode.LogOutputChannel): StepCard {
    const controller = vscode.comments.createCommentController('codeNotes.journey', 'Journey')
    controller.options = { prompt: '', placeHolder: '' }
    const deco = {
      at: vscode.window.createTextEditorDecorationType(CARD_LOOKS.at),
      quiet: vscode.window.createTextEditorDecorationType(CARD_LOOKS.quiet),
      stale: vscode.window.createTextEditorDecorationType(CARD_LOOKS.stale),
    }
    const refDeco = vscode.window.createTextEditorDecorationType(CARD_LOOKS.ref)
    return new StepCard(tour, probe, narration, controller, deco, refDeco, new MarkPainter(log, 'drop'))
  }

  private constructor(
    private readonly tour: TourState,
    private readonly probe: TourProbe,
    /** The podcast on step n of `lj`, when one is in the panel for it. */
    private readonly narration: (lj: LoadedJourney, n: number) => Narration | undefined,
    readonly controller: vscode.CommentController,
    readonly deco: { at: vscode.TextEditorDecorationType; quiet: vscode.TextEditorDecorationType; stale: vscode.TextEditorDecorationType },
    readonly refDeco: vscode.TextEditorDecorationType,
    /** The step's marks and its beats' (stepMarks.ts), drawn as a podcast's are. */
    readonly marks: MarkPainter,
  ) {}

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
    for (const d of [this.controller, this.deco.at, this.deco.quiet, this.deco.stale, this.refDeco, this.marks, this.lensChanged]) d.dispose()
  }

  /** The voice tells the walk's step now: the editor goes quiet (no step tint, beat box, value hints or note bars). */
  narrating(): boolean {
    const lj = walk().touring() ? walk().tourJourney() : undefined
    return !!lj && !!this.narration(lj, this.tour.step)?.playing
  }

  /** `e` shows the narrated code (the walk's group, or the step's file) while the voice tells the step. */
  narrates(e: vscode.TextEditor): boolean {
    if (!this.narrating()) return false
    const lj = walk().tourJourney()!
    return (e.viewColumn !== undefined && e.viewColumn === this.tour.walkGroup?.viewColumn)
      || e.document.uri.toString() === stepUri(lj, this.tour.step).toString()
  }

  /** What the editor was last painted for: playing or not (a change repaints the notes, the step and the beat). */
  private paintedPlaying = false

  /** While it plays, the line the header card hangs under, by document version and step start (see playingLine). */
  private fnLines = new Map<string, number>()

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

  /** What a step's text depends on besides the journey (stepText.ts). */
  private textInput(lj: LoadedJourney): StepTextInput {
    return { renames: journeys().renames(lj), refGone: this.tour.refGone, refLines: this.tour.refLines, detailsOpen: this.tour.detailsOpen }
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
  panelCard(lj: LoadedJourney, n: number): PanelCard {
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
    // While the voice tells this step: the header line only (the voice and the code are enough).
    const nar = this.narration(lj, n)
    if (nar?.playing) return this.narratingMarkdown(nar)
    const t = this.text(lj, n, (r) => commandRefLink(lj, n, r))
    const asked = askedOf(lj)[n]
    // Its code can't be found: say what happened first, and the one thing to do (ask: the note box opens
    // prefilled; once asked, the way to that note); nothing else is highlighted.
    const askUpdate = asked?.update ? cmdLink('Asked ›', HiddenCmd.openNoteId, asked.id) : cmdLink('Ask', HiddenCmd.askStepUpdate)
    const st = this.staleText(lj, n, askUpdate)
    const nav = this.navLinks(lj, n, t, asked, !!st)
    // Paused: the full card, and the way to play on.
    if (nar) nav.unshift(titledCmdLink('▶ Play', `Play the narration on (${chordKey()} Space)`, Cmd.podcastToggle))
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
   * The card while the voice tells the step: its header line ("3/14 · title") only, and "Follow along" under it once
   * the reader looked around on their own (the follow lock). No value hints on the code meanwhile. The full card comes
   * back on pause.
   */
  private narratingMarkdown(nar: Narration): vscode.MarkdownString {
    valueHints().clear()
    codeLinks().clear()
    const md = new vscode.MarkdownString(nar.following ? '' : titledCmdLink('Follow along', 'Back to what the voice is showing', HiddenCmd.podcastFollow))
    md.isTrusted = { enabledCommands: CARD_COMMANDS }
    return md
  }

  /**
   * A slim band under the header line "3/14 · title": one row ‹ › Ask (More), then the lead; More grows the card
   * below, so ‹ › never move. The step's questions are one of the actions; More holds the details and references.
   */
  private navLinks(lj: LoadedJourney, n: number, t: StepText, asked: Asked | undefined, stale: boolean): string[] {
    // Words beside the glyphs: a bare ‹ › is too small a target.
    const previous = n > 1 ? cmdLink('‹ Previous', Cmd.previousStep) : ''
    // A check's tour: Next goes to the question placed after this step, when one is open.
    const nextLabel = lj.check && nextStop(lj)?.q ? 'Question ›' : n < lj.j.steps.length ? 'Next ›' : 'Finish'
    const next = cmdLink(nextLabel, Cmd.nextStep)
    const questions = asked ? cmdLink(`${askedText(asked)} ›`, HiddenCmd.openNoteId, asked.id) : ''
    // One Ask: a stale step's is the banner's, which opens the request prefilled.
    const ask = stale ? '' : cmdLink('Ask', Cmd.askStep)
    const open = this.tour.detailsOpen
    const more = !(t.details || t.refs) ? '' : open ? cmdLink('Less', Cmd.stepDetails, false) : cmdLink('More', Cmd.stepDetails, true)
    return [previous, next, questions, ask, more].filter(Boolean)
  }

  /**
   * On the code, for the step on the card: value hints (what its variables hold in the example run, faint, above their
   * lines) and its code links' lines, only those whose phrase is on the card now (`used`: those behind "More" while it
   * is open), in the text's own colour on a faint tint.
   */
  private presentLinksAndHints(lj: LoadedJourney, n: number, linkKey: string, links: ReturnType<typeof readLinks>, used: Set<number>): void {
    valueHints().present(linkKey, lj.folder.uri, readValues(lj.j.steps[n - 1].values), journeys().renames(lj))
    if (links.length) codeLinks().present(linkKey, lj.folder.uri, links, journeys().renames(lj), [...used])
    else codeLinks().clear()
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
    const playing = !!this.narration(lj, n)?.playing
    if (playing !== this.paintedPlaying) {
      this.paintedPlaying = playing
      refreshNoteDecorations()
      beats().paint()
    }
    if (this.inMap(lj, n)) {
      this.thread?.dispose()
      this.thread = undefined
      mapPanel().update()
      return
    }
    const uri = stepUri(lj, n)
    const line = playing ? this.playingLine(lj, n, uri) : cardLine(lj, n)
    // Its function not found yet: the card comes once it is.
    if (line === undefined) return
    const range = new vscode.Range(line, 0, line, 0)
    // VS Code HTML-escapes a thread's label and then shows it as text ("&lt;script&gt;"): look-alikes instead.
    const label = `${n}/${lj.j.steps.length} · ${labelSafe(lj.j.steps[n - 1].title)}`
    // A new thread per step (moving one left the card drawn above the view:).
    const fresh = !this.isThreadAt(uri, line, label)
    if (fresh) {
      if (this.showOnceEditorSettles(lj, n, uri)) return
    } else if (settling(this.thread!)) {
      // Made just now (see SETTLE_MS): this update follows once its first state is in the workbench.
      whenSettled(this.thread!, 'card', () => this.showIfStillOn(lj, n))
      return
    }
    // Made once per show: it also puts the step's code links and value hints on the code.
    const body = this.markdown(lj, n)
    if (fresh) {
      this.thread?.dispose()
      this.thread = newThread(this.controller, uri, range, [cardComment(body)])
    }
    const t = this.thread!
    setThread(t, 'canReply', false)
    setThread(t, 'contextValue', 'step')
    // The card's first line is "3/14 · <title>": the position once, and the title, since the map may not be
    // in view from the code. A stale step says so in its text.
    setThread(t, 'label', label)
    const shownBody = (t.comments[0]?.body as vscode.MarkdownString | undefined)?.value ?? ''
    if (fresh || shownBody !== body.value) t.comments = [cardComment(body)]
    setThread(t, 'collapsibleState', vscode.CommentThreadCollapsibleState.Expanded)
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
    } catch { /* the file can't be read: the usual line */ }
    if (this.fnLines.size > 50) this.fnLines.clear()
    this.fnLines.set(fnKey(uri, doc, at.start), line)
    this.showIfStillOn(lj, n)
  }

  /** The card's thread is the one for this file, line and label. */
  private isThreadAt(uri: vscode.Uri, line: number, label: string): boolean {
    const t = this.thread
    return !!t && t.uri.toString() === uri.toString() && t.label === label && t.range?.start.line === line
  }

  /** Its editor is just opening (see editorSettling): the card comes a moment later. True: it will. */
  private showOnceEditorSettles(lj: LoadedJourney, n: number, uri: vscode.Uri): boolean {
    return afterEditorSettles(uri, 'card', () => this.showIfStillOn(lj, n))
  }

  /** A card shown later: only while the walk is still on that step. */
  private showIfStillOn(lj: LoadedJourney, n: number): void {
    if (walk().isOn(lj, n)) this.show(lj, n)
  }

  /**
   * The step's card and marker belong to the step's lines, not to a tab: whenever its file is on screen again (Go Back,
   * "Back to step", a tab switch, the file reopened) they are there. A preview tab that was replaced
   * closed the document, and VS Code drops a thread's widget with it: the thread is made again.
   */
  restore(): void {
    const tour = this.tour
    const lj = walk().touring() ? walk().tourJourney() : undefined
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
    if (this.marks && !this.marks.empty) this.marks.show(new Map())
    if (!this.deco) return
    for (const e of vscode.window.visibleTextEditors) {
      setDecorations(e, this.deco.at, [])
      setDecorations(e, this.deco.quiet, [])
      setDecorations(e, this.deco.stale, [])
    }
  }

  /** The running step's lines: a bar and a faint tint (while the voice tells it, or while the step has marks: a thin
   *  grey bar; a stale step's: none); its marks and its beat's (stepMarks.ts); the ref opened from the card, lit. */
  refreshDecorations(): void {
    const tour = this.tour
    const lj = walk().touring() ? walk().tourJourney() : undefined
    const s = lj?.j.steps[tour.step - 1]
    const stepFile = lj && s ? vscode.Uri.joinPath(lj.folder.uri, fileOf(lj, tour.step)).toString() : undefined
    const ref = tour.refHere
    this.probe.marked = []
    this.look = undefined
    // While the voice tells it, the podcast's own marks are the ones on the code.
    const marks = lj && s && this.marks && !this.narrating() ? stepMarks(lj, tour.step, beats().index, (k, line) => this.marks!.once(k, line)) : []
    if (this.marks) paintStepMarks(this.marks, marks)
    for (const e of vscode.window.visibleTextEditors) {
      const uri = e.document.uri.toString()
      const at = stepFile !== undefined && uri === stepFile ? lj!.at[tour.step - 1] : undefined
      // A stale step highlights nothing: what is there now is other code; the card says so.
      const lit = at && !at.stale
      const lines = lit ? [new vscode.Range(at.start - 1, 0, at.end - 1, 0)] : []
      // While the voice tells it, or the step has marks: a thin neutral bar only, the marks are the colour on the code.
      const quiet = this.narrates(e) || marks.length > 0
      setDecorations(e, this.deco.at, quiet ? [] : lines)
      setDecorations(e, this.deco.quiet, quiet ? lines : [])
      if (lit) { this.probe.marked.push(e.document.uri.path); this.look = quiet ? 'quiet' : 'tint' }
      setDecorations(e, this.deco.stale, [])
      const refLit = ref && lj && ref.uri === uri ? [new vscode.Range(ref.start, 0, ref.end, 0)] : []
      if (this.refDeco) setDecorations(e, this.refDeco, refLit)
    }
  }
}

/** Where a step starting at `start` is, in a version of its document (none: it can't be opened). */
const fnKey = (uri: vscode.Uri, doc: vscode.TextDocument | undefined, start: number) => `${uri}@${doc?.version ?? 'none'}|${start}`

/** The card's one comment: the text only (no author line). */
function cardComment(body: vscode.MarkdownString): vscode.Comment {
  return { body, mode: vscode.CommentMode.Preview, author: { name: '' }, contextValue: 'step' }
}
