// A code link clicked in a step card or a check thread: its code lit (the keyboard stays where the click was), and the
// way back to the step or the question.

import { codeLinks } from './app'
import { backToQuestion, checkLinkNote } from './notes/reveal'
import { docUri } from './threads/anchoring'
import { cardLine, stepUri } from './tour/card'
import { card, tour, walk } from './tour/tour'

/** codeNotes.codeLink: link `i` of the card or thread `key`; a second click on the lit phrase turns it off. */
export async function openCodeLink(key: string, i: number): Promise<void> {
  // A link in a check thread: its note's lines are the card; the way back is the question.
  const cn = checkLinkNote(key)
  if (cn) {
    // Only lit: no selection, the keyboard stays in the thread (an answer typed next must never edit the code).
    if (codeLinks.isLit(key, i)) { const away = codeLinks.state.back; codeLinks.unlight(); if (away) await backToQuestion(cn.n); return }
    codeLinks.present(key, cn.n.folder.uri, cn.links, new Map(), cn.links.map((_l, k) => k))
    tour.linkBack = undefined
    await codeLinks.open(key, i, walk.codeColumn, '$(arrow-left) Back to question', { uri: docUri(cn.n).toString(), line: cn.n.data.range.start - 1 }, { keepFocus: true, backTip: `Back to the question: ${cn.n.data.messages[0]?.body.split('\n')[0].slice(0, 80) ?? ''}` })
    return
  }
  const lj = walk.tourJourney()
  // A second click on the lit phrase turns it off; the step comes back if its card was out of sight.
  if (codeLinks.isLit(key, i)) { const away = codeLinks.state.back; codeLinks.unlight(); if (away && lj && tour.step) await walk.goToStep(lj, tour.step); return }
  tour.cursorUntil = Date.now() + 1500
  const cardAt = lj && tour.step && !card.inMap(lj, tour.step) ? { uri: stepUri(lj, tour.step).toString(), line: cardLine(lj, tour.step) } : undefined
  // An icon and words, so it reads as a control and not as one more value. Only lit, as in a question's thread: the
  // caret and the keyboard stay where the click was, so typing next never lands in the code.
  // The way back names where it goes, and goes only there: the step being walked when the link was clicked. Not
  // walking: no way back (a bare "Back" stayed and later led to whatever was walked by then).
  tour.linkBack = lj && tour.step ? { journey: lj.key, step: tour.step } : undefined
  await codeLinks.open(key, i, walk.codeColumn, tour.linkBack ? `$(arrow-left) Back to step ${tour.step}` : '', cardAt, { keepFocus: true, ...(lj && tour.linkBack ? { backTip: `Back to step ${tour.linkBack.step} of "${lj.j.title}"` } : {}) })
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
