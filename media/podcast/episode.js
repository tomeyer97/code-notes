// Where an episode is at a time, and what its parts are called. An episode is src/protocol/podcast.ts PodcastEpisode.

/** @typedef {import('../../src/protocol/podcast').PodcastEpisode} PodcastEpisode */

/** The chapter (part) at second `t` (-1: no episode). */
export function chapterAt(ep, t) {
  if (!ep) return -1
  const cs = ep.chapters
  for (let i = cs.length - 1; i >= 0; i--) if (t >= cs[i].start) return i
  return 0
}

/** The segment at second `t` (-1: none). */
export function segmentAt(ep, t) {
  if (!ep || !ep.segments.length) return -1
  const ss = ep.segments
  for (let i = ss.length - 1; i >= 0; i--) if (t >= ss[i].start) return i
  return 0
}

/** Where the next part starts (dir 1) or the part before (-1) from second `t`; past the last, `end`. ⏮ is always
 *  the part before, as the step card's ‹ Previous (src/core/format/podcast/model.ts chapterJump). */
export function partStart(ep, t, dir, end) {
  const cs = ep.chapters
  const i = chapterAt(ep, t)
  if (dir > 0) return i + 1 < cs.length ? cs[i + 1].start : end
  return i === 0 ? cs[0].start : cs[i - 1].start
}

/** From where step `n` starts to where its last part ends (undefined: the episode does not talk about it). */
export function stepSpan(ep, n) {
  const cs = ep.chapters
  const i = cs.findIndex((c) => c.step === n)
  if (i < 0) return undefined
  let j = i
  while (j + 1 < cs.length && cs[j + 1].step === n) j++
  return { start: cs[i].start, end: cs[j].end }
}

/**
 * The parts' names: "Step 6 of 14 · title" (short: "Step 6 · title"), or Intro / Map / Recap for a part on the map.
 * A step's title and the count are the episode's, else the page's (`fallback`: the journey it shows).
 * @param {{ stepTitle?: (n: number) => string, stepCount?: () => number }} fallback
 */
export function partNames(fallback) {
  const stepTitle = (ep, n) => (ep && ep.steps && ep.steps[n - 1] ? ep.steps[n - 1].title : fallback.stepTitle ? fallback.stepTitle(n) : '') || ''
  const stepCount = (ep) => (ep && ep.steps ? ep.steps.length : fallback.stepCount ? fallback.stepCount() : 0)
  /** A part on the map (no step): the first is the intro, the last the recap. */
  const mapName = (ep, i) => (i === 0 ? 'Intro' : i === ep.chapters.length - 1 ? 'Recap' : 'Map')
  /** @param {PodcastEpisode} ep @param {number} i @param {boolean} [short] */
  return (ep, i, short) => {
    const c = ep.chapters[i]
    if (!c) return ''
    if (!c.step) return mapName(ep, i)
    const t = stepTitle(ep, c.step)
    return `${short ? `Step ${c.step}` : `Step ${c.step} of ${stepCount(ep) || '?'}`}${t ? ` · ${t}` : ''}`
  }
}
