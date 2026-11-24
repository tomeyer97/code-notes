// Where a journey's steps are against a place in the code (files, and lines there): the one rule "In this file"
// (journeyList.ts) and "See also" (seeAlso.ts) both rank by: steps on the lines first, then the most steps in the file.

/** 1-based lines, inclusive. */
export type Span = { start: number; end: number }

/** Lines `r` and `span` share at least one line. */
export const overlaps = (r: Span, span: Span) => r.start <= span.end && r.end >= span.start

/** How many lines lie between `r` and `span` (0: they overlap). */
export function distance(r: Span, span: Span): number {
  if (r.end < span.start) return span.start - r.end
  if (r.start > span.end) return r.start - span.end
  return 0
}

/** A journey's steps (0-based) in `files`, and those of them on `span` (none without a span or a step's lines). */
export function stepsIn(it: { files: string[]; ranges?: Span[] }, files: ReadonlySet<string>, span?: Span): { inFile: number[]; onSpan: number[] } {
  const inFile = it.files.flatMap((f, i) => (files.has(f) ? [i] : []))
  const onSpan = inFile.filter((i) => {
    const r = it.ranges?.[i]
    return !!r && !!span && overlaps(r, span)
  })
  return { inFile, onSpan }
}

/** How well a journey shows a place: its steps on the lines, its steps in the file. */
export interface Place { onSpan: number; inFile: number }

/** Negative when `x` shows the place better: more steps on the lines, then more steps in the file. */
export const byPlace = (x: Place, y: Place) => y.onSpan - x.onSpan || y.inFile - x.inFile
