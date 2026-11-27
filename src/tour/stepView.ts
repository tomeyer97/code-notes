// What a step card shows, worked out once from the journey and the tour's state: its header, text, stale banner,
// buttons, "See also" and notice. Pure (no vscode): the inline card (card.ts) renders it as Markdown (cardMarkdown) and
// the map's card from the same view (panelCardOf). Unit-tested in test/stepView.test.ts.
import { Cmd, cmdLink, commandUri, HiddenCmd, titledCmdLink } from '../platform/commands'
import { codeLinkMarkup, linkPhrases, PH, PH_RE } from '../core/codeLinkText'
import type { StepLink } from '../core/format/journeyModel'
import { escapeTags, labelSafe } from '../core/escape'
import { mdLabel } from '../core/mdLabel'
import type { PanelCard } from '../protocol/map'
import { StepRef, StepText, StepTextInput, TextJourney, staleText, stepText } from './stepText'

/** A step's latest question, as its button says it: the note, the words, and whether it asks for the step's update. */
export interface AskedView { id: string; text: string; update: boolean }

/** What the view depends on besides the journey: the facts about the files the step names, and the tour's state. */
export interface StepViewState extends StepTextInput {
  /** Step n's own file is gone (checked when it opened). */
  fileGone: boolean
  asked?: AskedView
  /** A check's tour: Next goes to the question placed after this step. */
  nextIsQuestion: boolean
  /** One line about what just changed under the reader. */
  notice?: string
  /** The end of a check's tour: a link to a journey of the repository walking the same code. */
  seeAlso?: string
}

/** A button of the card: a command link. `tutorial`: it stands out while the tutorial's card about the card is up. */
export interface Button { label: string; cmd: string; args: unknown[]; title?: string; tutorial: boolean }

export interface StepView {
  n: number
  /** "3/14 · <title>", safe as a comment thread's label. */
  label: string
  title: string
  text: StepText
  /** The links of the text, in order (the panel posts one back by its index). */
  refs: StepRef[]
  /** The step's code can't be shown as written: changed, or its file gone. */
  stale: boolean
  /** A stale step's first line (what happened), with ASK_SLOT where its one action goes; '' when not stale. */
  banner: string
  /** The stale banner's one action: open the update request already asked (its note), else ask for one. */
  updateAsked: string | undefined
  /** One row: ‹ Previous, Next ›, the questions, Ask, More / Less. */
  nav: Button[]
  detailsOpen: boolean
  seeAlso?: string
  notice?: string
}

/** "3/14 · <title>": a card's header, safe as a comment thread's label (VS Code HTML-escapes a label and then shows
 *  it as text: "&lt;script&gt;"; look-alikes instead). */
export const stepLabel = (lj: Pick<TextJourney, 'j'>, n: number) => `${n}/${lj.j.steps.length} · ${labelSafe(lj.j.steps[n - 1].title)}`

/** Where the stale banner's action goes: each card renders its own. */
const ASK_SLOT = '\uE002'

/** Step n's card. `link`: how each reference in the text reads as a link (a command inline, `ref:i` in the panel). */
export function stepView(lj: TextJourney, n: number, state: StepViewState, link: (r: StepRef) => string): StepView {
  const s = lj.j.steps[n - 1]
  const total = lj.j.steps.length
  const refs: StepRef[] = []
  const text = stepText(lj, n, (r) => { refs.push(r); return link(r) }, state)
  const stale = text.stale || state.fileGone
  return {
    n,
    label: stepLabel(lj, n),
    title: s.title,
    text,
    refs,
    stale,
    banner: staleText(lj, n, ASK_SLOT, state.fileGone),
    updateAsked: state.asked?.update ? state.asked.id : undefined,
    nav: navButtons(n, total, text, state, stale),
    detailsOpen: state.detailsOpen,
    ...(state.seeAlso ? { seeAlso: state.seeAlso } : {}),
    ...(state.notice !== undefined ? { notice: state.notice } : {}),
  }
}

/**
 * A slim band under the header line "3/14 · title": one row ‹ › Ask (More), then the lead; More grows the card
 * below, so ‹ › never move. The step's questions are one of the actions; More holds the details and references.
 */
function navButtons(n: number, total: number, t: StepText, state: StepViewState, stale: boolean): Button[] {
  const out: Button[] = []
  // Words beside the glyphs: a bare ‹ › is too small a target.
  if (n > 1) out.push({ label: '‹ Previous', cmd: Cmd.previousStep, args: [], tutorial: true })
  const next = state.nextIsQuestion ? 'Question ›' : n < total ? 'Next ›' : 'Finish'
  out.push({ label: next, cmd: Cmd.nextStep, args: [], tutorial: true })
  const asked = state.asked
  if (asked) out.push({ label: `${asked.text} ›`, cmd: HiddenCmd.openNoteId, args: [asked.id], tutorial: false })
  // One Ask: a stale step's is the banner's, which opens the request prefilled.
  if (!stale) out.push({ label: 'Ask', cmd: Cmd.askStep, args: [], tutorial: true })
  if (t.details || t.refs) {
    const open = state.detailsOpen
    out.push({ label: open ? 'Less' : 'More', cmd: Cmd.stepDetails, args: [!open], tutorial: true })
  }
  return out
}

// ---------- the inline card: Markdown ----------

/** The commands the card's links run: its Markdown may run these and no other. */
export const CARD_COMMANDS = [
  HiddenCmd.codeLink, Cmd.openAt, Cmd.nextStep, Cmd.previousStep, Cmd.endJourney,
  Cmd.askStep, HiddenCmd.askStepUpdate, HiddenCmd.openNoteId, Cmd.stepDetails, HiddenCmd.openStepLink,
  Cmd.podcastToggle, HiddenCmd.podcastFollow,
]

/** The tutorial's highlight: what its cards point at on the step card. */
export const TUTORIAL_HI = 'var(--vscode-editor-findMatchHighlightBackground)'

/** What the map's tutorial points at on the card (tutorial.ts): nothing, its buttons, or its linked phrases. */
export type TutorialMark = '' | 'card' | 'links'

/** Between the card's buttons: real no-break spaces, not &nbsp; (VS Code reads the card's Markdown source aloud). */
const NAV_GAP = ' \u00A0 '

/** `src/a.ts:40-42`: where a reference goes (a link's hover; the panel lists them). */
export const refPlace = (r: StepRef) => `${r.file}:${r.line}${r.end > r.line ? `-${r.end}` : ''}`

/** A reference on the inline card: a command link; its hover is the whole path, a stale one says its line may be off. */
export function commandRefLink(folder: string, n: number, r: StepRef): string {
  const hover = `${refPlace(r)}${r.stale ? ' (the code changed: this line may be off)' : ''}`
  return `[${r.label}](${commandUri(Cmd.openAt, folder, r.file, r.line, r.end, n)} "${hover}")`
}

/** A button as a Markdown link; `emphasis`: on the tutorial's highlight. */
function buttonLink(b: Button, emphasis: boolean): string {
  const label = emphasis && b.tutorial
    ? `<span style="color:var(--vscode-foreground);background-color:${TUTORIAL_HI};">${b.label}</span>`
    : b.label
  return b.title ? titledCmdLink(label, b.title, b.cmd, ...b.args) : cmdLink(label, b.cmd, ...b.args)
}

/** How the inline card is drawn besides its view: its code links, what the tutorial points at, a paused podcast. */
export interface CardLook {
  /** The step's code links and the key they are shown under (codeLinks.present). */
  links: StepLink[]
  linkKey: string
  tutorial: TutorialMark
  /** A podcast on the step, paused: a ▶ Play button first, with this tooltip. */
  play?: string
}

/** The inline card's Markdown and the code links whose phrase is on it (only those are put on the code). */
export interface CardMarkdown { body: string; usedLinks: number[]; supportHtml: boolean }

/**
 * The inline card's text: a stale step's warning, the lead, one row of buttons, then (More) the details and the
 * references, a check tour's "See also", and a notice last, quiet. Its code links' phrases are marked.
 */
export function cardMarkdown(v: StepView, look: CardLook): CardMarkdown {
  const emphasis = look.tutorial === 'card'
  // Markup made here (the buttons, maybe with the tutorial's span) is kept out of escapeTags, and put in after it.
  const made: string[] = []
  const keep = (md: string) => { made.push(md); return `${made.length - 1}` }
  const used = new Set<number>()
  const mark = (x: string) => linkPhrases(x, look.links, used, PH)
  const update = v.updateAsked !== undefined
    ? { label: 'Asked ›', cmd: HiddenCmd.openNoteId, args: [v.updateAsked], tutorial: false }
    : { label: 'Ask', cmd: HiddenCmd.askStepUpdate, args: [], tutorial: true }
  const nav = v.nav.map((b) => buttonLink(b, emphasis))
  if (look.play) nav.unshift(buttonLink({ label: '▶ Play', title: look.play, cmd: Cmd.podcastToggle, args: [], tutorial: false }, emphasis))
  const parts: string[] = []
  const banner = staleBanner(v, keep(buttonLink(update, emphasis)))
  if (banner) parts.push(banner)
  if (v.text.lead) parts.push(mark(v.text.lead))
  parts.push(keep(nav.join(NAV_GAP)))
  if (v.detailsOpen && v.text.details) parts.push(mark(v.text.details))
  if (v.detailsOpen && v.text.refs) parts.push(v.text.refs)
  if (v.seeAlso) parts.push(`See also: ${v.seeAlso}`)
  if (v.notice !== undefined) parts.push(`_ℹ ${v.notice}_`)
  // `<name>` in the text is text: VS Code's renderer would drop it as an HTML tag.
  const linkHi = look.tutorial === 'links' ? TUTORIAL_HI : undefined
  const body = escapeTags(parts.join('\n\n'))
    .replace(PH_RE, (_m, i: string, phrase: string) => codeLinkMarkup(look.linkKey, Number(i), look.links[Number(i)], phrase, linkHi))
    .replace(/(\d+)/g, (_m, i: string) => made[Number(i)])
  // HTML only for the code links' colour and the tutorial's highlight; every other tag in the text was escaped above.
  return { body, usedLinks: [...used], supportHtml: look.links.length > 0 || emphasis }
}

/** The card while the voice tells the step: "Follow along" once the reader looked around on their own, else nothing. */
export function narratingMarkdown(following: boolean): string {
  return following ? '' : titledCmdLink('Follow along', 'Back to what the voice is showing', HiddenCmd.podcastFollow)
}

/** A stale step's first line: what happened and the one thing to do (`ask`); '' when the step is not stale. */
const staleBanner = (v: StepView, ask: string) => v.banner.replace(ASK_SLOT, () => ask)

// ---------- the map's card ----------

/** A reference on the map's card: the file's name, linked by its index (the panel posts it back). */
export const panelRefLink = (r: StepRef, i: number) => `[${mdLabel(r.label).replace(/^.*\//, '')}](ref:${i})`

/** The step card as the map shows it (when the step has no code to sit on); its links are `ref:i`, `note:` and `ask:`. */
export function panelCardOf(v: StepView): PanelCard {
  const ask = v.updateAsked !== undefined ? `[Asked ›](note:${v.updateAsked})` : '[Ask](ask:update)'
  return {
    n: v.n,
    lead: v.text.lead,
    ...(v.text.details ? { details: v.text.details } : {}),
    refs: v.text.refs,
    stale: v.stale,
    staleText: staleBanner(v, ask),
    open: v.detailsOpen,
    ...(v.notice !== undefined ? { notice: v.notice } : {}),
    title: v.title,
    paths: v.refs.map(refPlace),
  }
}
