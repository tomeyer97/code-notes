// Code links: a phrase of a step's text that is a link to the lines doing what it says. Pure, unit-tested.

/** `phrase`: words of the step's lead or details, as written; `text`: the first of its lines (to find them again). */
export interface StepLink { phrase: string; file: string; start: number; end: number; text: string }

export function readLinks(v: unknown): StepLink[] {
  if (!Array.isArray(v)) return []
  return v.filter((l) => l && typeof l.phrase === 'string' && l.phrase.trim() && typeof l.file === 'string' && Number.isInteger(l.start) && l.start >= 1)
    .map((l) => ({ phrase: l.phrase.trim(), file: l.file.trim(), start: l.start, end: Math.max(l.start, Number.isInteger(l.end) ? l.end : l.start), text: typeof l.text === 'string' ? l.text : '' }))
}

/** True where `i` is inside a markdown link or a code span of `text` (a phrase there is left alone). */
function taken(text: string, i: number, len: number): boolean {
  for (const m of text.matchAll(/\[[^\]]*\]\([^)]*\)|`[^`]*`/g)) if (i < m.index! + m[0].length && i + len > m.index!) return true
  return false
}

/** Each phrase's first free occurrence in `text` becomes `make(i, phrase)`; phrases already `used` (by index) are skipped and found ones added. */
export function linkPhrases(text: string, links: StepLink[], used: Set<number>, make: (i: number, phrase: string) => string): string {
  const cuts: { at: number; len: number; i: number }[] = []
  links.forEach((l, i) => {
    if (used.has(i)) return
    let at = -1
    for (let from = 0; (at = text.indexOf(l.phrase, from)) >= 0; from = at + 1) if (!taken(text, at, l.phrase.length) && !cuts.some((c) => at < c.at + c.len && at + l.phrase.length > c.at)) break
    if (at >= 0) { cuts.push({ at, len: l.phrase.length, i }); used.add(i) }
  })
  cuts.sort((a, b) => b.at - a.at)
  for (const c of cuts) text = text.slice(0, c.at) + make(c.i, text.slice(c.at, c.at + c.len)) + text.slice(c.at + c.len)
  return text
}
