// The walk's decisions that need no editor: where a journey resumes, where Next and Previous go, what a change of the
// journey file did to the step on screen. Pure, so walk.ts's transitions are unit-tested (test/walkMoves.test.ts).
import { atOf, LoadedJourney, stepOf } from '../journeys/steps'
import type { JourneyPos } from '../platform/state'
import type { ShownAt } from './state'

/** How many steps the journey has. */
export const stepCount = (lj: Pick<LoadedJourney, 'j'>): number => lj.j.steps.length

/** The number (1-based) of the step with this id; 0 when no step has it. */
export function numberOf(lj: Pick<LoadedJourney, 'j'>, id: string | undefined): number {
  return id === undefined ? 0 : lj.j.steps.findIndex((s) => s.id === id) + 1
}

/** Where a journey was left (`pos`, 0: never started): the same step by id when it still exists, else the same
 *  number, at most the last. */
export function resumeStep(lj: Pick<LoadedJourney, 'j'>, pos: JourneyPos | undefined): number {
  if (!pos) return 0
  return numberOf(lj, pos.id) || Math.min(pos.step, stepCount(lj))
}

/** The positions without one journey's (`key`): its walk starts over. */
export function withoutPos(positions: Record<string, JourneyPos>, key: string): Record<string, JourneyPos> {
  return Object.fromEntries(Object.entries(positions).filter(([k]) => k !== key))
}

/** Next or Previous from step `n` of a journey (not a check's tour): the step, or which end was passed. */
export function stepBy(n: number, dir: 1 | -1, total: number): number | 'finish' | 'first' {
  const to = n + dir
  if (to > total) return 'finish'
  if (to < 1) return 'first'
  return to
}

/** The step on screen was removed: the walk goes to the one now at its number (or the last); 0: none is left. */
export const stepAfterRemoval = (n: number, total: number): number => (total ? Math.min(n, total) : 0)

/** Where a step is now, as ShownAt keeps it. */
export type Place = Pick<ShownAt, 'file' | 'start' | 'end' | 'removed' | 'wrote'>

/** Step n's place now: its file (`file`, renames followed), its lines, and where the journey file puts it (`wrote`). */
export function placeOf(lj: Pick<LoadedJourney, 'j' | 'at'>, n: number, file: string): Place {
  const at = atOf(lj, n)
  const s = stepOf(lj, n)
  return { file, start: at.start, end: at.end, removed: !!at.removed, wrote: `${s.file}:${s.range.start}-${s.range.end}` }
}

/** The step's code is where it was shown: same file, same lines, removed or not alike. */
export function samePlace(was: Place, now: Place): boolean {
  return was.file === now.file && was.start === now.start && was.end === now.end && was.removed === now.removed
}

/**
 * What a change of the journey file did to the step on screen (found again by id):
 * - `same`: same place, same text in the journey file: drawn again;
 * - `edited`: same place, but the journey file's text for it changed: drawn again;
 * - `moved`: its code moved (or came back) with the journey file as it was: shown where it is now;
 * - `rewritten`: the journey file puts it elsewhere now (re-anchored): shown there, and the card says so.
 */
export type StepChange = 'same' | 'edited' | 'moved' | 'rewritten'

export function classifyChange(was: Place, now: Place): StepChange {
  const rewritten = was.wrote !== now.wrote
  if (samePlace(was, now)) return rewritten ? 'edited' : 'same'
  return rewritten ? 'rewritten' : 'moved'
}
