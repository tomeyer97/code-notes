// What the Journeys home (journey-home.js) says about a row: the sort menu's entries, the stale and podcast marks, the
// preview's Walk button. Pure: unit-tested in test/journeyHome.test.ts.
import { clock } from '../podcast/format.js'

/**
 * The sort menu: the extension's sorts (src/core/list/journeyList.ts SORTS, same ids and labels: the unit test holds
 * them together) and `best`, offered only while searching.
 * @type {[import('../../src/core/list/journeyList').Sort | 'best', string][]}
 */
export const SORTS = [
  ['best', 'Best match'],
  ['area', 'By area'],
  ['newest', 'Newest'],
  ['walked', 'Recently walked'],
  ['name', 'A–Z'],
]

/** "Step 4 changed since it was written", for a stale row's mark. */
export function staleTip(r) {
  const n = r.staleSteps || []
  if (n.length) return `${n.length === 1 ? `Step ${n[0]}` : `Steps ${n.join(', ')}`} changed since it was written`
  return `${r.stale} step${r.stale === 1 ? '' : 's'} changed since it was written`
}

/** Whether a journey is in progress: being walked, or left past step 1. */
export const inProgress = (r) => !!r.walking || r.resume > 1

/** The preview's button, one verb per state: on from where the walk is or was left ("Resume · 3/10"), else Walk. */
export function walkLabel(r) {
  return inProgress(r) ? `Resume · ${r.resume}/${r.steps}` : 'Walk'
}

/**
 * A row's podcast mark: its length, that it is being listened to, or where it was paused; and its tooltip.
 * @param {import('../../src/protocol/map').RowPodcast} p
 */
export function podcastBadge(p) {
  if (p.playing) return { text: '♪ Listening', tip: 'Listening to its podcast' }
  if (p.at !== undefined) return { text: `♪ ${clock(p.at)}`, tip: `Podcast paused at ${clock(p.at)} of ${clock(p.duration)}` }
  return { text: `♪ ${clock(p.duration)}`, tip: `Podcast, ${clock(p.duration)}: ▶ Listen on its row in the Journeys view` }
}

/** `s` with the characters a RegExp gives a meaning escaped: it matches itself. */
export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
