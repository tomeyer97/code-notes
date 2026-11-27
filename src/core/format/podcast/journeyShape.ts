// What a podcast needs of its journey, and where a segment's `at` lands in it. A shape of its own, not the journey
// type, because the check also runs outside the extension: journey.py and the CLI send it as plain JSON (step ids,
// beat counts, files), and the test cases are written in it. journeyShapeOf makes it from a journey read by
// journeyModel.ts, so the extension has one way to get it.

import type { Journey } from '../journeyModel'
import type { WrittenSegment } from './format'
import { isObj } from './guards'

/** A step as the podcast sees it: its id, how many beats its animation has, its file, and each beat's code file
 *  (null: the beat names none). */
export interface StepShape {
  id: string
  beats: number
  file?: string
  beatFiles?: (string | null)[]
}

/** What the podcast needs of the journey: its steps, in order. */
export interface JourneyShape { steps: StepShape[] }

/** A journey's shape with its id: what the full check is given (validate.ts). */
export type IdentifiedJourneyShape = JourneyShape & { id: string }

/** The shape of a journey as journeyModel.ts reads it. */
export function journeyShapeOf(j: Pick<Journey, 'id' | 'steps'>): IdentifiedJourneyShape {
  return {
    id: j.id,
    steps: j.steps.map((s) => {
      const beats = s.scene?.beats ?? []
      return { id: s.id, beats: beats.length, file: s.file, beatFiles: beats.map((b) => (typeof b.code?.file === 'string' ? b.code.file : null)) }
    }),
  }
}

/** A journey's steps by id, with their number (1-based). */
export type StepIndex = Map<string, StepShape & { n: number }>

export const stepIndex = (journey: JourneyShape): StepIndex => new Map(journey.steps.map((s, i) => [s.id, { ...s, n: i + 1 }]))

/** The step a segment's `at` names, as written: undefined when `at` names none (the map, not a step, an unknown id). */
export function stepAt(s: WrittenSegment, steps: StepIndex): { step: StepShape & { n: number }; beat: unknown } | undefined {
  const at = s.at
  if (!isObj(at) || typeof at.step !== 'string') return undefined
  const step = steps.get(at.step)
  return step && { step, beat: at.beat }
}

/** A beat as written that is a position (1-based) a step's beats could have. */
const isBeatNumber = (b: unknown): b is number => typeof b === 'number' && Number.isInteger(b) && b >= 1

/** The file a segment shows (a mark's default): its beat's code file, else its step's; '' when the journey doesn't
 *  say. A beat the step doesn't have shows the step's. */
export function segmentFile(s: WrittenSegment, steps: StepIndex): string {
  const at = stepAt(s, steps)
  if (!at) return ''
  const beatFile = s.cue !== 'map' && isBeatNumber(at.beat) ? at.step.beatFiles?.[at.beat - 1] : undefined
  return beatFile ?? at.step.file ?? ''
}

/** The segment names a beat its step doesn't have (or a beat that isn't a number): the step only is shown. */
export function hasBadBeat(s: WrittenSegment, steps: StepIndex): boolean {
  const at = stepAt(s, steps)
  if (!at || at.beat === undefined || s.cue === 'map') return false
  return !(isBeatNumber(at.beat) && at.beat <= at.step.beats)
}
