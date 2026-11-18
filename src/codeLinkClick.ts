// A code link clicked in a step card or a check thread: its code lit (the keyboard stays where the click was), and the
// way back to the step or the question. (codeLinks.ts lights the code; codeLinkText.ts marks the phrases.)

import { codeLinks } from './app'
import { docUri } from './notes/location'
import { cardLine, stepUri } from './tour/card'
import { card, tour, walk } from './tour/tour'
import { backToQuestion, checkLinkNote } from './check/wiring'

/** After a click on a step's link, the cursor moving there for this long is the link's doing, not the person reading. */
const LINK_CURSOR_MS = 1500

/** A second click on the lit phrase turns it off; if the way back was shown, `goBack` goes there. */
async function unlightAndReturn(goBack: () => Promise<void> | undefined): Promise<void> {
  const away = codeLinks.state.back
  codeLinks.unlight()
  if (away) await goBack()
}

/** codeNotes.codeLink: link `i` of the card or thread `key`; a second click on the lit phrase turns it off. */
export async function openCodeLink(key: string, i: number): Promise<void> {
  // A link in a check thread: its note's lines are the card; the way back is the question.
  const cn = checkLinkNote(key)
  if (cn) {
    // Only lit: no selection, the keyboard stays in the thread (an answer typed next must never edit the code).
    if (codeLinks.isLit(key, i)) return unlightAndReturn(() => backToQuestion(cn.n))
    const n = cn.n
    codeLinks.present(key, n.folder.uri, cn.links, new Map(), cn.links.map((_l, k) => k))
    tour.linkBack = undefined
    const question = n.data.messages[0]?.body.split('\n')[0].slice(0, 80) ?? ''
    await codeLinks.open(key, i, walk.codeColumn, '$(arrow-left) Back to question',
      { uri: docUri(n).toString(), line: n.data.range.start - 1 },
      { keepFocus: true, backTip: `Back to the question: ${question}` })
    return
  }
  const lj = walk.tourJourney()
  // A second click on the lit phrase turns it off; the step comes back if its card was out of sight.
  if (codeLinks.isLit(key, i)) return unlightAndReturn(() => (lj && tour.step ? walk.goToStep(lj, tour.step) : undefined))
  tour.cursorUntil = Date.now() + LINK_CURSOR_MS
  const cardAt = lj && tour.step && !card.inMap(lj, tour.step) ? { uri: stepUri(lj, tour.step).toString(), line: cardLine(lj, tour.step) } : undefined
  // An icon and words, so it reads as a control and not as one more value. Only lit, as in a question's thread: the
  // caret and the keyboard stay where the click was, so typing next never lands in the code.
  // The way back names where it goes, and goes only there: the step being walked when the link was clicked. Not
  // walking: no way back (a bare "Back" stayed and later led to whatever was walked by then).
  tour.linkBack = lj && tour.step ? { journey: lj.key, step: tour.step } : undefined
  const backLabel = tour.linkBack ? `$(arrow-left) Back to step ${tour.step}` : ''
  const backTip = lj && tour.linkBack ? { backTip: `Back to step ${tour.linkBack.step} of "${lj.j.title}"` } : {}
  await codeLinks.open(key, i, walk.codeColumn, backLabel, cardAt, { keepFocus: true, ...backTip })
}

/** codeNotes.codeLinkBack: back to the question, or to the step being walked when the link was clicked. */
export async function codeLinkBack(): Promise<void> {
  const cn = checkLinkNote(codeLinks.state.key ?? '')
  const b = tour.linkBack
  tour.linkBack = undefined
  codeLinks.unlight()
  if (cn) { await backToQuestion(cn.n); return }
  const lj = walk.tourJourney()
  if (lj && b && b.journey === lj.key && b.step === tour.step) await walk.goToStep(lj, b.step)
}
