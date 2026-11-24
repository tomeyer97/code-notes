// "See also" under a check's question or at the end of its tour: the journey step that best shows some lines.
import type { ListItem } from './journeyList'
import { byPlace, distance, Place, Span, stepsIn } from './place'

/** The distance of a step without lines (or with no lines asked for): farther than any real one. */
const FAR = 1e6

/**
 * The journey step that best shows `file` near `span`, ranked as "In this file" ranks (place.ts): a step on those
 * lines first, then the journey with the most steps in the file; then the nearest step. With several files (the
 * tour's), the journey with the most steps in them, at its first one there.
 */
export function seeAlso(items: ListItem[], files: string[], span?: Span): { key: string; step: number } | undefined {
  const want = new Set(files)
  let best: { key: string; step: number; place: Place; distance: number } | undefined
  for (const it of items) {
    if (it.kind !== 'journey') continue
    const { inFile } = stepsIn(it, want)
    if (!inFile.length) continue
    const dist = (i: number) => {
      const r = it.ranges?.[i]
      return r && span ? distance(r, span) : FAR
    }
    const near = span ? inFile.reduce((a, i) => (dist(i) < dist(a) ? i : a)) : inFile[0]
    // One step on the lines is enough: the nearest one is then on them.
    const place = { onSpan: Number(!!span && dist(near) === 0), inFile: inFile.length }
    const better = !best || (byPlace(place, best.place) || dist(near) - best.distance) < 0
    if (better) best = { key: it.key, step: near + 1, place, distance: dist(near) }
  }
  return best && { key: best.key, step: best.step }
}
