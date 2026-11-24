// A note's lines in the two ways they are counted: a note file's "range" is 1-based (as editors number lines), a Loc
// (core/anchors) is 0-based (as documents do). Only these turn one into the other. Pure.

import type { Loc } from '../../core/anchors/anchor'
import type { NoteData } from '../../core/format/noteModel'

/** 1-based lines, as a note file has them. */
export type Range1 = NoteData['range']

/** A note's 1-based range as 0-based lines. */
export const locOf = (r: Range1): Loc => ({ start: r.start - 1, end: r.end - 1 })

/** 0-based lines as a note's 1-based range. */
export const range1Of = (loc: Loc): Range1 => ({ start: loc.start + 1, end: loc.end + 1 })

/** 1-based lines `line1`..`end1` as 0-based lines that exist in a document of `lineCount` lines (the end never before
 *  the start). */
export function clampLines(doc: { lineCount: number }, line1: number, end1: number): Loc {
  const last = doc.lineCount - 1
  const start = Math.max(0, Math.min(line1 - 1, last))
  return { start, end: Math.max(start, Math.min(end1 - 1, last)) }
}

/** 0-based lines cut to a file of `lineCount` lines: the end at most its last line, the start at most the end. */
export function withinLines(loc: Loc, lineCount: number): Loc {
  const end = Math.min(loc.end, lineCount - 1)
  return { start: Math.min(loc.start, end), end }
}

/** The same lines. */
export const sameRange = (a: Range1, b: Range1) => a.start === b.start && a.end === b.end
