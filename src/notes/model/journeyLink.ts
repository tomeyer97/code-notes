// A note asked from a journey's step (`extra.journey`): which step, and which loaded journey that is. Pure.

import type { LoadedJourney } from '../../journeys/steps'
import type { Note } from '../store'

export type StepLink = { id: string; step?: string; n: number }

/** The step a note was asked from: `extra.journey` = { id, step, n }. */
export function stepLinkOf(n: Note): StepLink | undefined {
  const v = n.data.extra?.journey as Partial<StepLink> | undefined
  return v && typeof v.id === 'string' && Number.isInteger(v.n) ? (v as StepLink) : undefined
}

/** The journey (of `loaded`) a note was asked from: the same id, in the note's workspace folder. */
export function journeyOfNote(n: Note, loaded: Iterable<LoadedJourney>): LoadedJourney | undefined {
  const l = stepLinkOf(n)
  if (!l) return undefined
  for (const x of loaded) if (x.j.id === l.id && x.folder.uri.toString() === n.folder.uri.toString()) return x
  return undefined
}
