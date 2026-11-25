// Where a code link was clicked: a step card (the walk) or a check thread (the check). Each says where its card is,
// what the Back row says and where Back goes; codeLinkClick.ts only dispatches.
import { docUri } from '../notes/location'
import { cardLine, stepUri } from '../tour/stepPlace'
import { OWN_MOVE_MS } from '../platform/timings'
import type { CardAt, OpenOptions } from './codeLinks'
import { CheckLinks, checkLinks, codeLinks, tour } from './ports'

export interface CodeLinkHost {
  /** A click on a link: the host's own bookkeeping, then where its card is and the Back row's words. */
  clicked(): Pick<OpenOptions, 'back' | 'card'>
  /** A second click on the lit phrase while its Back row showed: back to the card. */
  backToCard(): Promise<void>
  /** The Back row: back to where the link was clicked from. */
  goBack(): Promise<void>
}

/** The Back row's icon, so it reads as a control and not as one more value. */
const back = (words: string) => `$(arrow-left) ${words}`
/** The question as the Back row's tooltip names it. */
const QUESTION_TIP_CHARS = 80

/** The host of link key `key`: a check thread's, else the walk's. */
export function hostFor(key: string): CodeLinkHost {
  const cn = checkLinks()?.noteOf(key)
  return cn ? checkHost(key, cn) : walkHost()
}

/** A check thread: its note's lines are the card; the way back is the question. */
function checkHost(key: string, cn: NonNullable<ReturnType<CheckLinks['noteOf']>>): CodeLinkHost {
  const { n, links } = cn
  const toQuestion = async () => { await checkLinks()?.backToQuestion(n) }
  return {
    clicked() {
      codeLinks().present(key, n.folder.uri, links, new Map(), links.map((_l, k) => k))
      tour().linkClicked(undefined)
      const question = n.data.messages[0]?.body.split('\n')[0].slice(0, QUESTION_TIP_CHARS) ?? ''
      const card: CardAt = { uri: docUri(n).toString(), line: n.data.range.start - 1 }
      return { card, back: { title: back('Back to question'), tip: `Back to the question: ${question}` } }
    },
    backToCard: toQuestion,
    async goBack() {
      tour().linkClicked(undefined)
      await toQuestion()
    },
  }
}

/**
 * The walk: the way back names where it goes, and goes only there: the step being walked when the link was clicked.
 * Not walking: no way back (a bare "Back" stayed and later led to whatever was walked by then).
 */
function walkHost(): CodeLinkHost {
  const t = tour()
  const lj = t.tourJourney()
  const step = t.state.step
  return {
    clicked() {
      t.ownCursorFor(OWN_MOVE_MS) // the link's doing, not the person reading
      const card = lj && step && !t.inMap(lj, step) ? { uri: stepUri(lj, step).toString(), line: cardLine(lj, step) } : undefined
      const to = lj && step ? { journey: lj.key, step } : undefined
      t.linkClicked(to)
      return { card, back: lj && to ? { title: back(`Back to step ${step}`), tip: `Back to step ${to.step} of "${lj.j.title}"` } : undefined }
    },
    async backToCard() { if (lj && step) await t.goToStep(lj, step) },
    async goBack() {
      const b = t.state.linkBack
      t.linkClicked(undefined)
      if (lj && b && b.journey === lj.key && b.step === t.state.step) await t.goToStep(lj, b.step)
    },
  }
}
