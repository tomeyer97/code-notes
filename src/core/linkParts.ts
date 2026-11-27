// A text split at the phrases its code links name, so a page can draw each phrase as a link. Pure.

/** A piece of text; `link`: the index of the code link whose phrase it is. */
export interface Part { text: string; link?: number }

/** Where a link's phrase first appears in the text (`at`: -1 when it doesn't). */
interface Hit { i: number; at: number; len: number }

/** Earlier first; at the same place, the links keep their order. */
const byPlace = (a: Hit, b: Hit) => a.at - b.at

/** `text` split at the code links' phrases (each phrase once, the first time it appears; overlapping ones skipped). */
export function linkParts(text: string, links: { phrase: string }[] = []): Part[] {
  const hits = links
    .map((l, i) => ({ i, at: l.phrase ? text.indexOf(l.phrase) : -1, len: l.phrase.length }))
    .filter((h) => h.at >= 0)
    .sort(byPlace)
  const out: Part[] = []
  let pos = 0
  for (const h of hits) {
    if (h.at < pos) continue
    if (h.at > pos) out.push({ text: text.slice(pos, h.at) })
    out.push({ text: text.slice(h.at, h.at + h.len), link: h.i })
    pos = h.at + h.len
  }
  if (pos < text.length) out.push({ text: text.slice(pos) })
  return out
}
