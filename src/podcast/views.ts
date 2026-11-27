// What a podcast view (a step, maybe one of its beats) shows of a journey: the file, the line.
import { stepFileUri } from '../journeys/codeGroup'
import { fileOf, LoadedJourney } from '../journeys/steps'
import type { View } from '../core/format/podcast/model'
import type { JBeat } from '../core/format/journeyModel'

/** Just the view of `v` (a segment, viewAt's result, a view with an id): its step, and its beat if it has one. */
export const viewOf = (v: View): View => (v.beat === undefined ? { step: v.step } : { step: v.step, beat: v.beat })

/** The code of beat `beat` of step `step` (1-based), as the journey writes it. */
export function beatCode(lj: LoadedJourney, step: number, beat: number | undefined): JBeat['code'] {
  return beat === undefined ? undefined : lj.j.steps[step - 1]?.scene?.beats?.[beat]?.code
}

/** The file a view shows ('' for the map): the beat's code file, else the step's. */
export function viewFile(lj: LoadedJourney, v: View): string {
  if (!v.step) return ''
  const code = beatCode(lj, v.step, v.beat)
  return code && typeof code.file === 'string' ? code.file : fileOf(lj, v.step)
}

/** Where view `v` puts the code: its beat's line, else its step's first line (file uri, 0-based line). `renames`:
 *  the journey's files as they are called now. */
export function viewTarget(lj: LoadedJourney, v: View, renames: Map<string, string>): { uri: string; line: number } | undefined {
  const st = lj.j.steps[v.step - 1]
  if (!v.step || !st) return undefined
  const code = beatCode(lj, v.step, v.beat)
  const line = (code && Number.isInteger(code.line) ? code.line : st.range?.start ?? 1) - 1
  return { uri: stepFileUri(lj.folder.uri, renames, viewFile(lj, v)).toString(), line: Math.max(0, line) }
}

/** A view with its step's id (from the journey as it is): the step is found again after the journey is edited. */
export function withId(lj: LoadedJourney, v: View): View & { id?: string } {
  const id = v.step ? lj.j.steps[v.step - 1]?.id : undefined
  return id ? { ...v, id } : { ...v }
}
