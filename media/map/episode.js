// The podcast episode as the storyline draws it: which chapter a time is in, and the chapters grouped by the rows
// they belong to (a step's row, or a part on the map: the intro, the recap, a map part after a step). Pure: tested in
// test/journeyMapPage.test.ts. The episode itself is journey-podcast.js's ({ chapters: [{ start, end, step? }],
// segments: [{ start, end, text, speaker? }] }).

/** A segment starting this close (s) before a chapter's start still belongs to it (times are rounded). */
const EDGE_S = 0.001

/**
 * Where time `t` is in `ep`: the chapter's index `i`, which part of the map that position is (`part`: the first
 * chapter is the intro, the last the recap, any other one a map part) and the storyline row the chapter is said on
 * (`key`: 's<n>' for a step's chapter, else 'intro', 'recap' or 'map<i>'; '' when the episode has no chapters).
 * @returns {{ i: number, part: 'intro' | 'recap' | 'map', key: string }}
 */
export function chapterAt(ep, t) {
  const cs = ep ? ep.chapters : []
  let i = 0
  for (let k = 0; k < cs.length; k++) if (t >= cs[k].start) i = k
  const part = partOf(i, cs.length)
  const c = cs[i]
  return { i, part, key: !c ? '' : c.step ? `s${c.step}` : partKey(i, part) }
}

/** Chapter `i` of `n` as a part of the map: the first is the intro, the last the recap. */
const partOf = (i, n) => (i === 0 ? 'intro' : i === n - 1 ? 'recap' : 'map')
/** The storyline row of map part `i`. */
const partKey = (i, part) => (part === 'map' ? `map${i}` : part)

/**
 * The episode's chapters by storyline row: `steps` (n -> { start, end, segs }: a step said in several chapters is one
 * row), `intro` and `recap` ({ start, end, segs, key }), `after` (n -> the map parts said after step n). Undefined
 * when there is no episode or it has no chapters.
 */
export function rowsOf(ep) {
  if (!ep || !ep.chapters.length) return undefined
  const steps = new Map(), after = new Map()
  let intro, recap, lastStep = 0
  const cs = ep.chapters
  for (const [i, c] of cs.entries()) {
    const segs = ep.segments.filter((x) => x.start >= c.start - EDGE_S && x.start < c.end - EDGE_S)
    if (c.step) {
      const had = steps.get(c.step)
      if (had) { had.end = c.end; had.segs.push(...segs) } else steps.set(c.step, { start: c.start, end: c.end, segs })
      lastStep = c.step
      continue
    }
    const part = partOf(i, cs.length)
    const row = { start: c.start, end: c.end, segs, key: partKey(i, part) }
    if (part === 'intro') intro = row
    else if (part === 'recap') recap = row
    else after.set(lastStep, [...(after.get(lastStep) || []), row])
  }
  return { steps, intro, recap, after }
}

/** Several voices in the episode: the transcript names who speaks. */
export const manySpeakers = (ep) => new Set(ep.segments.map((x) => x.speaker).filter(Boolean)).size > 1
