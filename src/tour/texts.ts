// Texts about journeys and steps that other features show too (no tour state here: importing it pulls in nothing of
// the tour).
import type { LoadedJourney } from '../journeys/steps'
import type { Note } from '../notes/store'

export const UPDATE_ASK = 'This step is out of date: its code changed or was deleted. Please update the step.'

/** A note asking the agent to update its step (made by askUpdate: it starts with UPDATE_ASK). */
export const isUpdateRequest = (n: Note) => !!n.data.messages[0]?.body.startsWith(UPDATE_ASK.slice(0, 30))

/** A journey's question, unless its title already says it. */
export function questionBesidesTitle(x: LoadedJourney): string {
  return x.j.question.toLowerCase().includes(x.j.title.toLowerCase()) ? '' : x.j.question
}
