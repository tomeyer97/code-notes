// A code link clicked in a step card or a check thread: its code lit (the keyboard stays where the click was), and the
// way back to the step or the question. (codeLinks.ts lights the code; codeLinkText.ts marks the phrases.)

import { docUri } from '../notes/location'
import type { Note } from '../notes/store'
import { cardLine, stepUri } from '../tour/stepPlace'
import { OWN_MOVE_MS } from '../platform/timings'
import { checkLinks, codeLinks, tour } from './ports'

/** A code link key of a check thread: its note and links (none before the check started). */
const checkLinkNote = (key: string) => checkLinks()?.noteOf(key)
const backToQuestion = (n: Note) => checkLinks()?.backToQuestion(n)

/** A second click on the lit phrase turns it off; if the way back was shown, `goBack` goes there. */
async function unlightAndReturn(goBack: () => Promise<void> | undefined): Promise<void> {
  const away = codeLinks().state.back
  codeLinks().unlight()
  if (away) await goBack()
}

/** codeNotes.codeLink: link `i` of the card or thread `key`; a second click on the lit phrase turns it off. */
export async function openCodeLink(key: string, i: number): Promise<void> {
  // A link in a check thread: its note's lines are the card; the way back is the question.
  const cn = checkLinkNote(key)
  if (cn) {
    // Only lit: no selection, the keyboard stays in the thread (an answer typed next must never edit the code).
    if (codeLinks().isLit(key, i)) return unlightAndReturn(() => backToQuestion(cn.n))
    const n = cn.n
    codeLinks().present(key, n.folder.uri, cn.links, new Map(), cn.links.map((_l, k) => k))
    tour().linkClicked(undefined)
    const question = n.data.messages[0]?.body.split('\n')[0].slice(0, 80) ?? ''
    await codeLinks().open(key, i, tour().codeColumn, '$(arrow-left) Back to question',
      { uri: docUri(n).toString(), line: n.data.range.start - 1 },
      { keepFocus: true, backTip: `Back to the question: ${question}` })
    return
  }
  const lj = tour().tourJourney()
  // A second click on the lit phrase turns it off; the step comes back if its card was out of sight.
  const { state } = tour()
  if (codeLinks().isLit(key, i)) return unlightAndReturn(() => (lj && state.step ? tour().goToStep(lj, state.step) : undefined))
  tour().ownCursorFor(OWN_MOVE_MS) // the link's doing, not the person reading
  const cardAt = lj && state.step && !tour().inMap(lj, state.step) ? { uri: stepUri(lj, state.step).toString(), line: cardLine(lj, state.step) } : undefined
  // An icon and words, so it reads as a control and not as one more value. Only lit, as in a question's thread: the
  // caret and the keyboard stay where the click was, so typing next never lands in the code.
  // The way back names where it goes, and goes only there: the step being walked when the link was clicked. Not
  // walking: no way back (a bare "Back" stayed and later led to whatever was walked by then).
  const back = lj && state.step ? { journey: lj.key, step: state.step } : undefined
  tour().linkClicked(back)
  const backLabel = back ? `$(arrow-left) Back to step ${state.step}` : ''
  const backTip = lj && back ? { backTip: `Back to step ${back.step} of "${lj.j.title}"` } : {}
  await codeLinks().open(key, i, tour().codeColumn, backLabel, cardAt, { keepFocus: true, ...backTip })
}

/** codeNotes.codeLinkBack: back to the question, or to the step being walked when the link was clicked. */
export async function codeLinkBack(): Promise<void> {
  const cn = checkLinkNote(codeLinks().state.key ?? '')
  const b = tour().state.linkBack
  tour().linkClicked(undefined)
  codeLinks().unlight()
  if (cn) { await backToQuestion(cn.n); return }
  const lj = tour().tourJourney()
  if (lj && b && b.journey === lj.key && b.step === tour().state.step) await tour().goToStep(lj, b.step)
}
