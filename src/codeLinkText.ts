// Code links: a phrase of a step's text that is a link to the lines doing what it says. Pure, unit-tested. What a link
// is in the journey file (StepLink, readLinks) is journeyModel.ts.
import type { StepLink } from './journeyModel'
import { baseName } from './paths'

/** A markdown link (`[text](target)`) or a code span: a phrase inside one is left alone. */
const LINK_OR_CODE = /\[[^\]]*\]\([^)]*\)|`[^`]*`/g

/** True where `i` is inside a markdown link or a code span of `text` (a phrase there is left alone). */
function taken(text: string, i: number, len: number): boolean {
  for (const m of text.matchAll(LINK_OR_CODE)) {
    const start = m.index!
    const end = start + m[0].length
    if (i < end && i + len > start) return true
  }
  return false
}

/** Where `phrase` first occurs in `text` at a place `free` allows; -1: nowhere. */
function firstFree(text: string, phrase: string, free: (at: number, len: number) => boolean): number {
  for (let at = text.indexOf(phrase); at >= 0; at = text.indexOf(phrase, at + 1)) {
    if (free(at, phrase.length)) return at
  }
  return -1
}

/** Each phrase's first free occurrence in `text` becomes `make(i, phrase)`; phrases already `used` (by index) are skipped and found ones added. */
export function linkPhrases(text: string, links: StepLink[], used: Set<number>, make: (i: number, phrase: string) => string): string {
  const cuts: { at: number; len: number; i: number }[] = []
  // Free: not in a link or code span, and not overlapping a phrase already linked.
  const free = (at: number, len: number) => !taken(text, at, len) && !cuts.some((c) => at < c.at + c.len && at + len > c.at)
  links.forEach((l, i) => {
    if (used.has(i)) return
    const at = firstFree(text, l.phrase, free)
    if (at < 0) return
    cuts.push({ at, len: l.phrase.length, i })
    used.add(i)
  })
  cuts.sort((a, b) => b.at - a.at)
  for (const c of cuts) text = text.slice(0, c.at) + make(c.i, text.slice(c.at, c.at + c.len)) + text.slice(c.at + c.len)
  return text
}

/**
 * A code link's markup: the phrase in the text's own colour on a faint tint, a command link that lights its lines.
 * VS Code styles every span in a comment `white-space: pre`, so one span around the phrase can't wrap: a span per word
 * (its space inside, so the tint has no gaps) and a <wbr> between them to break at (a zero-width space was copied
 * with the text: copied words no longer matched a search).
 */
export function codeLinkMarkup(key: string, i: number, l: { file: string; start: number; end: number }, phrase: string, tint = 'var(--vscode-toolbar-hoverBackground)', what = 'show the code that does this'): string {
  const tip = `${baseName(l.file)}:${l.start}${l.end > l.start ? `-${l.end}` : ''} · ${what}`
  const words = String(phrase).split(/ +/).filter(Boolean)
  const tinted = words.map((w, k) => `<span style="color:var(--vscode-foreground);background-color:${tint};">${w}${k < words.length - 1 ? ' ' : ''}</span>`).join('<wbr>')
  return `[${tinted}](command:codeNotes.codeLink?${encodeURIComponent(JSON.stringify([key, i]))} "${tip}")`
}
/** A phrase marked as code link i in text that is escaped next; PH_RE finds the marks again to put the markup in. */
export const PH = (i: number, phrase: string) => `\u27E6${i}\u27E7${phrase}\u27E6/\u27E7`
export const PH_RE = /\u27E6(\d+)\u27E7([\s\S]*?)\u27E6\/\u27E7/g
