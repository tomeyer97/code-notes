// The caption's timing, pure: a segment's sentences with their times, when each character is said, and the caption's
// parts of two lines. The listening page (media/journey-podcast.js) imports this file through its bundle, so the
// extension's tests and the page run the same code.
import { escapeHtml as escHtml } from '../core/escape'

/** What a caption is cut from: a segment as the page gets it (src/protocol/podcast.ts PodcastEpisode), and its marks
 *  when it has them (word-timed phrases). */
export interface CaptionSegment {
  start: number
  end: number
  text?: string
  speaker?: string
  sentences?: { start: number; text: string }[]
  marks?: { phrase?: unknown; at?: unknown }[]
}

/** A sentence and when it is said; an estimated one keeps its segment's clock and where it starts in the text. */
export interface TimedSentence {
  start: number
  end: number
  text: string
  clock?: (c: number) => number
  off?: number
}

/** One part of the caption: shown from `start`, as `html`. */
export interface CaptionPart { start: number; end: number; html: string }

/** A sentence ends at . ! ? … (and closing quotes or brackets) followed by a space or the end of the text: never at
 *  the dot inside `repo.ReadTestFile`. */
const SENTENCE = /[\s\S]*?(?:[.!?…]+["'”’)\]]*(?=\s|$)|$)\s*/g

/** A segment's sentences with their times: the file's (`sentences`, checked by the extension), else estimated by
 *  each sentence's share of the segment's characters. */
export function sentencesOf(seg: CaptionSegment): TimedSentence[] {
  const end = Math.max(seg.end, seg.start)
  if (Array.isArray(seg.sentences) && seg.sentences.length) {
    return seg.sentences.map((x, i, a) => ({ start: x.start, end: i + 1 < a.length ? a[i + 1].start : end, text: x.text }))
  }
  const text = seg.text || ''
  const clock = charClock(seg, end)
  const out: TimedSentence[] = []
  const re = new RegExp(SENTENCE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) && m[0]) {
    const lead = m[0].length - m[0].trimStart().length
    const t = m[0].trim()
    if (!t) continue
    const off = m.index + lead
    out.push({ start: clock(off), end: clock(off + t.length), text: t, clock, off })
  }
  return out
}

/**
 * When character `c` of the segment's text is said (s): the marks' phrases are said at their times (word-timed by
 * the script), so they anchor it; in between, and with no marks, the time is shared by the characters.
 */
export function charClock(seg: CaptionSegment, end: number): (c: number) => number {
  const text = seg.text || ''
  const pts: [number, number][] = [[0, seg.start]]
  let from = 0
  for (const mk of Array.isArray(seg.marks) ? seg.marks : []) {
    if (!mk || typeof mk.phrase !== 'string' || !mk.phrase || typeof mk.at !== 'number') continue
    const i = text.indexOf(mk.phrase, from)
    const t = seg.start + mk.at
    const [pi, pt] = pts[pts.length - 1]
    if (i < 0 || i <= pi || t <= pt || t >= end) continue
    pts.push([i, t])
    from = i + mk.phrase.length
  }
  pts.push([Math.max(text.length, pts[pts.length - 1][0] + 1), end])
  return (c) => {
    let k = 1
    while (k < pts.length - 1 && pts[k][0] < c) k++
    const [a, ta] = pts[k - 1], [b, tb] = pts[k]
    return ta + ((tb - ta) * Math.max(0, Math.min(b - a, c - a))) / (b - a)
  }
}

const capitalized = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

/** Whether `html` fits two lines of the caption (the page measures it); undefined: no width yet, a sentence a part. */
export type FitsTwoLines = ((html: string) => boolean) | undefined

/** Segment `si` of `segments` as caption parts: each sentence, split where it would need a third line. The speaker
 *  goes before the first part when the voice changed (and the episode has more than one). */
export function captionParts(segments: CaptionSegment[], si: number, fits: FitsTwoLines): CaptionPart[] {
  const seg = segments[si]
  const speakers = new Set(segments.map((x) => x.speaker).filter(Boolean))
  const prev = si > 0 ? segments[si - 1].speaker : ''
  const who = speakers.size > 1 && seg.speaker && seg.speaker !== prev ? `<b class="pod-who">${escHtml(capitalized(seg.speaker))}:</b> ` : ''
  const out: CaptionPart[] = []
  for (const [k, sen] of sentencesOf(seg).entries()) out.push(...fitTwoLines(sen, k === 0 ? who : '', fits))
  return out
}

/** A sentence in parts that fit two lines, each timed from when its first word is said. */
function fitTwoLines(sen: TimedSentence, lead: string, fits: FitsTwoLines): CaptionPart[] {
  if (!fits) return [{ start: sen.start, end: sen.end, html: lead + escHtml(sen.text) }]
  const words = sen.text.split(/\s+/).filter(Boolean)
  const groups: string[][] = []
  let cur: string[] = []
  for (const word of words) {
    const next = [...cur, word]
    const html = (groups.length ? '' : lead) + escHtml(next.join(' '))
    if (cur.length && !fits(html)) { groups.push(cur); cur = [word] } else cur = next
  }
  if (cur.length) groups.push(cur)
  const chars = words.join(' ').length || 1
  // Each part from when its first word is said (the segment's clock: the marks anchor it), else by its share.
  const at = (c: number) => (sen.clock ? sen.clock((sen.off ?? 0) + c) : sen.start + ((sen.end - sen.start) * c) / chars)
  let c = 0
  return groups.map((g, k) => {
    const text = g.join(' ')
    const part = { start: at(c), end: at(c + text.length), html: (k === 0 ? lead : '') + escHtml(text) }
    c += text.length + 1
    return part
  })
}

/** The part of `parts` shown at second `t`: the last one started (the first before any has). */
export function partAt(parts: CaptionPart[], t: number): CaptionPart | undefined {
  let p = parts[0]
  for (const x of parts) if (t >= x.start) p = x
  return p
}
