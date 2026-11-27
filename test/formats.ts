// Test helpers for the format parsers (src/core/format/): the value of a file a test expects to be read.
import { Journey, parseJourney } from '../src/core/format/journeyModel'

/** The journey in `raw`; throws with the reason when parseJourney refuses it. */
export function journeyOf(raw: string, name: string): Journey {
  const r = parseJourney(raw, name)
  if (!r.ok) throw new Error(`${name}: refused: ${r.why}`)
  return r.value
}
