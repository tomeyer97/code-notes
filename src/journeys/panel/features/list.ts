// The Journeys list in the journey panel (its home): search, sort and chips, a journey's preview, walking one; and the
// list's part of what the panel shows.

import type { HomeInfo, HomeListModel, PanelListRow, RowPodcast } from '../../../protocol/map'
import type { ListModel } from '../../../core/list/journeyList'
import { ageOf } from '../../../core/list/journeyList'
import type { PodcastStatus } from '../../../tour/api'
import { fileOf, LoadedJourney } from '../../steps'
import type { PanelFeature, PanelMessage } from '../controller'
import { staleSince } from '../staleSteps'
import { journeys, mapPanel, refreshJourneyList } from '../../../tour/ports'
import { podcast, walk } from '../../../tour/instances'
import { walkJourney } from '../../../tour/commands'
import { refreshJourney } from '../../../write/refreshJourney'
import { gitIn } from '../../../platform/checkout'
import { fireAndForget } from '../../../platform/run'
import { STATE, StateStore } from '../../../platform/state'

type HomeQuery = { query: string; kind: NonNullable<PanelMessage<'list'>['kind']>; area: string; searchSort?: PanelMessage<'list'>['searchSort'] }

/** What the list in the panel needs of the Journeys list (its model and state live with the Journeys view). */
export interface ListFeatureDeps {
  listModel(q: HomeQuery): ListModel
  /** The home's search, chips and sort as last asked. */
  setHomeQuery(q: HomeQuery): void
  homeQuery(): HomeQuery
  /** "In this file" shown in full. */
  showAllHere(): void
  /** The window's state (read when used). */
  stored(): StateStore
}

export function listFeature(d: ListFeatureDeps): PanelFeature {
  const withJourney = (key: string, f: (lj: LoadedJourney) => void) => {
    const lj = journeys().list.get(key)
    if (lj) f(lj)
  }
  return {
    name: 'the Journeys list',
    handlers: {
      list: (_lj, m) => homeQueryChanged(d, m),
      preview: (_lj, m) => withJourney(m.key, (x) => fireAndForget(sendPreview(x), 'panel: sendPreview')),
      refresh: (_lj, m) => withJourney(m.key, (x) => fireAndForget(refreshJourney(x), 'panel: refreshJourney')),
      hereAll: () => { d.showAllHere(); mapPanel().update() },
      walk: (_lj, m) => withJourney(m.key, (x) => fireAndForget(walkJourney(x, { keepFocus: 'panel' }), 'panel: walkJourney')),
    },
    slice: (lj): HomeInfo => ({
      list: journeys().all().map((x) => listRow(x, lj)),
      home: withPodcasts(d.listModel(d.homeQuery())),
    }),
  }
}

/** The panel home's search, chips or sort changed. */
function homeQueryChanged(d: ListFeatureDeps, m: PanelMessage<'list'>): void {
  d.setHomeQuery({ query: String(m.query ?? ''), kind: m.kind ?? 'all', area: String(m.area ?? ''), searchSort: m.searchSort })
  if (!m.sort) { mapPanel().update(); return }
  const sorted = d.stored().set(STATE.journeySort, m.sort).then(() => { refreshJourneyList(); mapPanel().update() })
  fireAndForget(sorted, 'panel: store journeySort')
}

/** A journey in the panel home's list (`here`: the one the panel is about). */
function listRow(x: LoadedJourney, shown: LoadedJourney): PanelListRow {
  return {
    key: x.key,
    title: x.j.title,
    question: x.j.question,
    steps: x.j.steps.length,
    resume: walk().resumeAt(x),
    ...(x.key === shown.key ? { here: true } : {}),
    ...(x.j.start ? { start: true } : {}),
  }
}

/** A row's podcast, when it has a playable one: its length; listening, or where it was paused. */
function rowPodcast(p: PodcastStatus | undefined): RowPodcast | undefined {
  if (p?.state !== 'ok') return undefined
  return { duration: p.duration ?? 0, playing: !!p.playing, at: p.session && !p.playing ? p.t ?? 0 : undefined }
}

/** The home's rows, each with its podcast when it has one. */
function withPodcasts(m: ListModel): HomeListModel {
  const rows: HomeListModel['rows'] = {}
  for (const [key, row] of Object.entries(m.rows)) {
    const lj = journeys().list.get(key)
    const p = rowPodcast(lj && podcast()?.status(lj))
    rows[key] = p ? { ...row, podcast: p } : row
  }
  return { ...m, rows }
}

/** A journey's preview in the panel's list: the journey, and which steps are stale since when. */
async function sendPreview(lj: LoadedJourney): Promise<void> {
  const stale = lj.at.flatMap((a, i) => (a.stale ? [{ n: i + 1, file: fileOf(lj, i + 1) }] : []))
  mapPanel().send({ type: 'preview', key: lj.key, journey: lj.j, stale: await staleSince(stale, (f) => lastChange(lj, f)) })
}

/** "uncommitted", or the last commit to `file` since the journey's (else ever): "a1b2c3d · 3 days ago"; '' unknown. */
async function lastChange(lj: LoadedJourney, file: string): Promise<string> {
  if (await gitIn(lj.folder, ['status', '--porcelain', '--', file])) return 'uncommitted'
  const lastCommit = (range: string[]) => gitIn(lj.folder, ['log', '-1', '--format=%h %ct', ...range, '--', file])
  const l = (lj.j.commit ? await lastCommit([`${lj.j.commit}..HEAD`]) : undefined) ?? await lastCommit([])
  if (!l) return ''
  const [hash, time] = l.split(' ')
  const age = ageOf(new Date(Number(time) * 1000).toISOString(), Date.now())
  return `${hash} · ${age === 'today' ? age : `${age} ago`}`
}
