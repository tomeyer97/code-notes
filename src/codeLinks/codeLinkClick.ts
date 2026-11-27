// A code link clicked in a step card or a check thread: its code lit (the keyboard stays where the click was), and the
// way back to the step or the question. (codeLinks.ts lights the code; hosts.ts knows each place a link is clicked
// in; codeLinkText.ts marks the phrases.)
import { hostFor } from './hosts'
import { codeLinks, tour } from './ports'

/** codeNotes.codeLink: link `i` of the card or thread `key`; a second click on the lit phrase turns it off. */
export async function openCodeLink(key: string, i: number): Promise<void> {
  const host = hostFor(key)
  if (codeLinks().isLit(key, i)) {
    // Off again; back to the card if it was out of sight (its Back row showed).
    const away = codeLinks().state.back
    codeLinks().unlight()
    if (away) await host.backToCard()
    return
  }
  // Only lit: the caret and the keyboard stay where the click was, so typing next never lands in the code.
  await codeLinks().open(key, i, tour().codeColumn, { ...host.clicked(), keepFocus: true })
}

/** codeNotes.codeLinkBack: back to the question, or to the step being walked when the link was clicked. */
export async function codeLinkBack(): Promise<void> {
  const host = hostFor(codeLinks().state.key ?? '')
  codeLinks().unlight()
  await host.goBack()
}
