// The journey panel's messages as the panel test (shoot.mjs, plain JS) writes them, typed against the protocol
// (src/protocol/map.ts): compiled to out/test/journey-map/messages.js by `npm run build`. A message renamed or a field
// changed there fails the build here, not a check at run time.
import type { FromMap, ToMap, TourInfo } from '../../src/protocol/map'
import type { Journey } from '../../src/core/format/journeyModel'

/** What every "journey" and "tour" message carries when a check says nothing else: not walking, no tutorial. */
export const DEFAULT_TOUR: TourInfo = {
  current: 0,
  marks: {},
  resume: 0,
  key: "Ctrl+'",
  moved: {},
  legendHidden: true,
  problems: [],
  tutorial: false,
}

/** The messages the extension sends the page, `info` over DEFAULT_TOUR (and the home list a check gives `home`). */
export function toMap(home: Pick<TourInfo, 'list' | 'home'> = {}) {
  const tour = (info: Partial<TourInfo>): TourInfo => ({ ...DEFAULT_TOUR, ...home, ...info })
  return {
    journey: (journey: Journey, info: Partial<TourInfo> = {}): ToMap => ({ type: 'journey', journey, ...tour(info) }),
    tour: (info: Partial<TourInfo> = {}): ToMap => ({ type: 'tour', ...tour(info) }),
    home: (): ToMap => ({ type: 'home' }),
    deleted: (file: string): ToMap => ({ type: 'deleted', file }),
  }
}

/** Every type of message the page posts (its own and the podcast player's), by name: `FROM.mapWidth`. The type
 *  makes the list whole; a name the protocol does not have throws. */
const fromNames: { [T in FromMap['type']]: T } = {
  ready: 'ready', rendered: 'rendered', story: 'story', view: 'view', error: 'error', closed: 'closed',
  step: 'step', end: 'end', finish: 'finish', openPath: 'openPath', openFile: 'openFile', ref: 'ref',
  details: 'details', beat: 'beat', ask: 'ask', restore: 'restore', authors: 'authors',
  question: 'question', checkpoint: 'checkpoint', nextStop: 'nextStop', tutorial: 'tutorial',
  home: 'home', walk: 'walk', list: 'list', preview: 'preview', refresh: 'refresh', hereAll: 'hereAll',
  legend: 'legend', panelWidth: 'panelWidth', mapWidth: 'mapWidth',
  podcastTime: 'podcastTime', podcastState: 'podcastState', podcastError: 'podcastError', podcastMeta: 'podcastMeta',
  podcastAsk: 'podcastAsk', podcastWhy: 'podcastWhy', podcastEnd: 'podcastEnd', podcastUnlocked: 'podcastUnlocked',
}
export const FROM = new Proxy(fromNames, {
  get(names, k) {
    if (typeof k === 'string' && !Object.hasOwn(names, k)) throw new Error(`the journey panel posts no "${k}" message`)
    return names[k as keyof typeof names]
  },
})
