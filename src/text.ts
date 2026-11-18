// Text as the lists, threads and messages show it: one line of markdown as plain text, a note's title and lines,
// counts of things, ages, shortened questions.

import type { Note } from './store'

/** Links and images as their text: "[text](url)" -> "text". */
const stripLinks = (s: string) => s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')

/** A heading's #s or a quote's > in front of the line. */
const stripLineMark = (s: string) => s.replace(/^\s*(#+|>)\s*/, '')

/** Bold, strike-through and code marks, then a single * or _ around words ("*this*" -> "this"). */
const stripEmphasis = (s: string) =>
  s.replace(/\*\*|__|~~|`/g, '').replace(/(^|[^\w*])[*_](?=\S)(.+?)(?<=\S)[*_](?![\w*])/g, '$1$2')

/** Runs of white space as one space, none at the ends. */
const oneSpaced = (s: string) => s.replace(/\s+/g, ' ').trim()

/** At most `max` characters: a longer text ends in "…". */
const cut = (t: string, max: number) => (t.length > max ? `${t.slice(0, max - 1)}…` : t)

/** One line of a markdown message (its first with text), as plain text. */
export function plain(s: string, max = 80): string {
  const line = s.split('\n').find((x) => x.trim()) ?? ''
  return cut(oneSpaced(stripEmphasis(stripLineMark(stripLinks(line)))), max)
}

/** A note as toasts and pickers name it: its first message, as plain text. */
export const noteTitle = (n: Note, max = 40) => plain(n.data.messages[0]?.body ?? '', max)

/** One note by its title in quotes, several by their number: "Fix the typo" / 3 notes. */
export const describeNotes = (list: Note[]) => (list.length === 1 ? `"${noteTitle(list[0])}"` : `${list.length} notes`)

/** Where a note is, short: "L3", "L3–5", "whole file" or "folder". */
export function rangeLabel(n: Note): string {
  const { target, range } = n.data
  if (target) return target === 'folder' ? 'folder' : 'whole file'
  return range.start === range.end ? `L${range.start}` : `L${range.start}–${range.end}`
}

/** "1 note", "2 notes"; `many` for a word that doesn't just take an s ("reply", "replies"). */
export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

/** Seconds per unit, largest first: an age is said in the first unit it reaches. */
const AGE_UNITS: [seconds: number, unit: string][] = [[86400, 'd'], [3600, 'h'], [60, 'min']]

/** How long ago an ISO time was: "just now", "5 min ago", "3 h ago", "2 d ago"; '' for no time. */
export function ago(at?: string): string {
  const t = Date.parse(at ?? '')
  if (!t) return ''
  const s = Math.max(0, (Date.now() - t) / 1000)
  const unit = AGE_UNITS.find(([secs]) => s >= secs)
  return unit ? `${Math.floor(s / unit[0])} ${unit[1]} ago` : 'just now'
}

/** Text in a Unicode isolate (FSI…PDI) when it holds right-to-left letters; plain text stays as it is. */
export const isolate = (t: string) => (/[֐-ࣿיִ-﷿ﹰ-﻿]/.test(t) ? `⁨${t}⁩` : t)

/** A question on one line, at most `max` characters. */
export const shortQ = (q: string, max = 60) => cut(oneSpaced(q), max)

/**
 * Text for a comment thread's label: VS Code HTML-escapes a label and then shows it as text ("&lt;script&gt;"), so
 * <, > and & are drawn with look-alikes (‹ › ＆) instead.
 */
export function labelSafe(text: string): string {
  return text.replace(/</g, '‹').replace(/>/g, '›').replace(/&/g, '＆')
}
