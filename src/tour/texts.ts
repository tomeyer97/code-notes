// Texts about journeys and steps that other features show too (no tour state here: importing it pulls in nothing of
// the tour).
import type { LoadedJourney } from '../journeys/steps'
import type { Note } from '../notes/store'

export const UPDATE_ASK = 'This step is out of date: its code changed or was deleted. Please update the step.'

/** What a note asked from a step is, when it is not a question: a request to update the step (askUpdate). */
export const UPDATE_REQUEST = 'updateRequest'
export type StepNoteKind = typeof UPDATE_REQUEST

/** A note's link to the step it was asked from (`extra.journey`): the journey's id, the step's id and number, and
 *  what kind of note it is (none: a question). */
export interface StepNoteLink { id: string; step: string; n: number; kind?: StepNoteKind }

/** A note asking the agent to update its step (made by askUpdate). Notes written before the link said so are known by
 *  the words they start with. */
export function isUpdateRequest(n: Note): boolean {
  const link = n.data.extra?.journey as Partial<StepNoteLink> | undefined
  if (link?.kind !== undefined) return link.kind === UPDATE_REQUEST
  return !!n.data.messages[0]?.body.startsWith(UPDATE_ASK.slice(0, 30))
}

/** The line a question asked from a step ends with: the step by its title and id, and its journey. */
export const aboutStepLine = (stepTitle: string, stepId: string, journeyTitle: string) =>
  `_About the step “${stepTitle}” (id \`${stepId}\`) of the journey “${journeyTitle}”_`

/** A journey's question, unless its title already says it. */
export function questionBesidesTitle(x: LoadedJourney): string {
  return x.j.question.toLowerCase().includes(x.j.title.toLowerCase()) ? '' : x.j.question
}
