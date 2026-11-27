// Text as the lists, threads and messages show it: one line of markdown as plain text, a note's title and lines,
// counts of things, shortened questions. (Markdown's marks: markdown.ts; ages: time.ts.)

import type { NoteData } from './format/noteModel'
import { markdownAsText } from './markdown'

/** What these helpers read of a note. */
type NoteLike = { data: Pick<NoteData, 'messages' | 'target' | 'range'> }

/** Runs of white space as one space, none at the ends. */
const oneSpaced = (s: string) => s.replace(/\s+/g, ' ').trim()

/** At most `max` characters: a longer text ends in "…". */
const cut = (t: string, max: number) => (t.length > max ? `${t.slice(0, max - 1)}…` : t)

/** One line of a markdown message (its first with text), as plain text. Anything but a string (a note file written
 *  by hand or by an old bug) is no text. */
export function plain(s: unknown, max = 80): string {
  if (typeof s !== 'string') return ''
  const line = s.split('\n').find((x) => x.trim()) ?? ''
  return cut(oneSpaced(markdownAsText(line)), max)
}

/** A note as toasts and pickers name it: its first message, as plain text. */
export const noteTitle = (n: NoteLike, max = 40) => plain(n.data.messages[0]?.body ?? '', max)

/** One note by its title in quotes, several by their number: "Fix the typo" / 3 notes. */
export const describeNotes = (list: NoteLike[]) => (list.length === 1 ? `"${noteTitle(list[0])}"` : `${list.length} notes`)

/** Where a note is, short: "L3", "L3–5", "whole file" or "folder". */
export function rangeLabel(n: NoteLike): string {
  const { target, range } = n.data
  if (target) return target === 'folder' ? 'folder' : 'whole file'
  return range.start === range.end ? `L${range.start}` : `L${range.start}–${range.end}`
}

/** "1 note", "2 notes"; `many` for a word that doesn't just take an s ("reply", "replies"). */
export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

/** Re-exported for the rows that say an age: time.ts. */
export { ago } from './time'

/** Unicode's first-strong isolate and pop directional isolate (FSI, PDI). */
const FSI = '⁨', PDI = '⁩'

/** Right-to-left letters: Hebrew, Arabic, Syriac, Thaana, NKo … (U+0590–U+08FF), and their presentation forms
 *  (U+FB1D–U+FDFF, U+FE70–U+FEFF). */
const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/

/** Text in a Unicode isolate (FSI…PDI) when it holds right-to-left letters; plain text stays as it is. */
export const isolate = (t: string) => (RTL.test(t) ? `${FSI}${t}${PDI}` : t)

/** A question on one line, at most `max` characters. */
export const shortQ = (q: string, max = 60) => cut(oneSpaced(q), max)
