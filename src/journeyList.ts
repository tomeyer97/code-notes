// Finding journeys (docs/journey-list.md): one model of the list — rows with derived metadata, search, sort, groups —
// computed once in the extension and rendered by both the sidebar's Journeys view and the panel's home.
// No vscode API (the panel's tests load the compiled file as is): unit-tested in test/journeyList.test.ts. The search's
// word matching is match.ts.
import { matchScore, queryWords } from './match'
import { baseName } from './paths'

/** Only journeys are listed ('review': nothing makes one yet). 'check' is not listed: a check lives in the Check view. */
export type ListKind = 'journey' | 'check' | 'review'
export type Sort = 'area' | 'newest' | 'walked' | 'name'
export const SORTS: { id: Sort; label: string }[] = [
  { id: 'area', label: 'By area' },
  { id: 'newest', label: 'Newest' },
  { id: 'walked', label: 'Recently walked' },
  { id: 'name', label: 'A–Z' },
]
/** "In this file" lists this many, then "Show all". */
export const HERE_CAP = 5

/** What the extension knows about one entry. */
export interface ListItem {
  key: string; kind: ListKind; title: string; question: string; summary: string
  createdAt?: string
  /** Each step's file (in order) and title: the area, "In this file", search. */
  files: string[]; stepTitles: string[]
  /** Each step's lines now (1-based, parallel to `files`): ranks "In this file" by the cursor. */
  ranges?: { start: number; end: number }[]
  steps: number
  /** Steps whose code changed since the journey was written: how many, and which (1-based). */
  stale: number
  staleSteps?: number[]
  /** Never opened (personal, workspace state). */
  isNew: boolean
  /** Left at this step (0: not started or finished; 1 is not "Continue": nothing was read yet). */
  resume: number
  /** The agent is refreshing its stale steps now. */
  refreshing?: boolean
  /** It is being walked now (the step is `resume`). */
  walking?: boolean
  /** When it was last walked (ms). */
  walkedAt?: number
  start?: boolean
  /** Unused here (a check's progress); not listed. */
  progress?: string; open?: boolean
}

export interface ListRow extends ListItem {
  area: string
  /** "today", "3 d", "2 wk", "5 mo", "1 y"; '' without a date. */
  age: string
  /** One of its steps is in the active editor's file: how many, and whether one is at the cursor. */
  here: boolean
  hereSteps: number
  atCursor: boolean
  /** Its steps in the function around the cursor. */
  cursorSteps: number
  /** Muted metadata: "api · 9 steps · 2 wk". */
  meta: string
  /** In "In this file": "3 of 7 steps here". */
  hereText: string
  /** The words of the query it matched (for highlighting). */
  hits: string[]
}
/** `more`: rows left out (the view offers "Show all"). */
export interface Section { id: string; label: string; keys: string[]; more?: number }
export interface Group { id: string; label: string; keys: string[]; children?: Group[]; more?: number }
export interface ListModel {
  rows: Record<string, ListRow>
  query: string; sort: Sort; kind: ListKind | 'all'
  /** The order of search results: 'best' (relevance) or a sort. */
  searchSort: Sort | 'best'
  /** The filter chip: '' (none), 'here' (in the active file), 'stale', or an area. */
  area: string
  /** The active editor's file (relative), when a journey has a step in it. */
  file?: string
  /** For chips: kinds and areas that have rows, with counts; how many are stale. */
  kinds: { id: ListKind; count: number }[]
  areas: { name: string; count: number }[]
  staleCount: number
  /** Several words and no journey has them all: rows with any of them, and one line saying so. */
  fallback?: { note: string; missing: string[] }
  /** The panel's sections (a search: one, "results", best first). */
  sections: Section[]
  /** The sidebar's groups: In this file · Continue · All (by area, or flat). */
  groups: Group[]
  /** Rows shown after filtering (search, kind, area). */
  count: number
  total: number
}

/** The top folder most steps visit ("api"); ties go to the first step's; files at the root: "(root)". */
export function areaOf(files: string[]): string {
  const top = (f: string) => (f.includes('/') ? f.split('/')[0] : '(root)')
  const n = new Map<string, number>()
  for (const f of files) n.set(top(f), (n.get(top(f)) ?? 0) + 1)
  if (!n.size) return '(root)'
  const best = Math.max(...n.values())
  return files.map(top).find((a) => n.get(a) === best)!
}

export function ageOf(at: string | undefined, now: number): string {
  const t = at ? Date.parse(at) : NaN
  if (Number.isNaN(t)) return ''
  const d = Math.max(0, Math.floor((now - t) / 86_400_000))
  if (d < 1) return 'today'
  if (d < 14) return `${d} d`
  if (d < 60) return `${Math.floor(d / 7)} wk`
  if (d < 365) return `${Math.floor(d / 30)} mo`
  return `${Math.floor(d / 365)} y`
}

export interface ListOptions {
  activeFile?: string
  /** The cursor's function (or line) in the active file, 1-based: journeys with a step there come first in "In this file". */
  activeSpan?: { start: number; end: number }
  /** "In this file" in full (else HERE_CAP rows and "Show all"). */
  hereAll?: boolean
  query?: string; sort?: Sort; kind?: ListKind | 'all'; area?: string; now?: number
  /** With a search: best match first (the default), or one of the sorts. */
  searchSort?: Sort | 'best'
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "3 Nov 14:05" (local time). */
export function stamp(t: number): string {
  const d = new Date(t), p = (n: number) => String(n).padStart(2, '0')
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 1-based lines, inclusive. */
type Span = { start: number; end: number }
/** Lines `r` and `span` share at least one line. */
const overlaps = (r: Span, span: Span) => r.start <= span.end && r.end >= span.start
/** How many lines lie between `r` and `span` (0: they overlap). */
function distance(r: Span, span: Span): number {
  if (r.end < span.start) return span.start - r.end
  if (r.start > span.end) return r.start - span.end
  return 0
}

const quote = (ws: string[]) => ws.map((w) => `“${w}”`).join(', ')
const stepCount = (n: number) => `${n} step${n === 1 ? '' : 's'}`
const keys = (l: ListRow[]) => l.map((r) => r.key)
const byName = (x: ListRow, y: ListRow) => x.title.localeCompare(y.title)
const when = (r: ListRow) => Date.parse(r.createdAt ?? '') || 0
const ORDER: Record<Sort, (x: ListRow, y: ListRow) => number> = {
  area: (x, y) => x.area.localeCompare(y.area) || byName(x, y),
  newest: (x, y) => when(y) - when(x) || byName(x, y),
  walked: (x, y) => (y.walkedAt ?? 0) - (x.walkedAt ?? 0) || byName(x, y),
  name: byName,
}

/** An item with what the list shows about it: area, age, its steps in the active file and at the cursor. */
function rowOf(it: ListItem, o: ListOptions, now: number): ListRow {
  const area = areaOf(it.files)
  const age = ageOf(it.createdAt, now)
  const hereIdx = o.activeFile ? it.files.flatMap((f, i) => (f === o.activeFile ? [i] : [])) : []
  const span = o.activeSpan
  const atSpan = (i: number) => {
    const r = it.ranges?.[i]
    return !!r && !!span && overlaps(r, span)
  }
  const cursorSteps = span ? hereIdx.filter(atSpan).length : 0
  const hereSteps = hereIdx.length
  return {
    ...it,
    area,
    age,
    here: hereSteps > 0,
    hereSteps,
    atCursor: cursorSteps > 0,
    cursorSteps,
    meta: [area, stepCount(it.steps), age].filter(Boolean).join(' · '),
    hereText: hereSteps ? `${hereSteps} of ${stepCount(it.steps)} here` : '',
    hits: [],
  }
}

/**
 * The rows the search finds (all, without a query), with their scores; their `hits` set. Several words and no journey
 * has them all: rows with any of them, and one line saying so (an empty list is a dead end).
 */
interface Found { shown: ListRow[]; scores: Map<string, number>; fallback?: ListModel['fallback'] }

function search(all: ListRow[], query: string, inFilter: (r: ListRow) => boolean): Found {
  const scores = new Map<string, number>()
  const pick = (any: boolean) => all.filter((r) => {
    if (!inFilter(r)) return false
    const m = matchScore(r, query, any)
    if (!m.score) return false
    r.hits = m.hits
    scores.set(r.key, m.score)
    return true
  })
  const shown = pick(false)
  const tokens = queryWords(query)
  if (shown.length || tokens.length < 2) return { shown, scores }
  const anyOf = pick(true)
  if (!anyOf.length) return { shown: anyOf, scores }
  const missing = tokens.filter((t) => !all.some((r) => inFilter(r) && matchScore(r, t).score))
  const found = tokens.filter((t) => !missing.includes(t))
  const note = missing.length
    ? `No journey about ${quote(missing)}; closest for ${quote(found)}`
    : 'No journey has every word; showing any'
  return { shown: anyOf, scores, fallback: { missing, note } }
}

/** Sorted Newest: rows of the same age ("13 d") say when, so the newest can be told. */
function stampSameAge(sorted: ListRow[]): void {
  const byAge = new Map<string, ListRow[]>()
  for (const r of sorted) if (r.age) byAge.set(r.age, [...(byAge.get(r.age) ?? []), r])
  for (const l of byAge.values()) {
    if (l.length < 2 || new Set(l.map(when)).size < 2) continue
    for (const r of l) {
      r.age = stamp(when(r))
      r.meta = [r.area, stepCount(r.steps), r.age].join(' · ')
    }
  }
}

/** In this file, ranked: a step in the function under the cursor, then the most steps here, then the largest share. */
function hereRows(sorted: ListRow[]): ListRow[] {
  const share = (r: ListRow) => r.hereSteps / r.steps
  return sorted.filter((r) => r.here).sort((x, y) =>
    y.cursorSteps - x.cursorSteps || y.hereSteps - x.hereSteps || share(y) - share(x) || byName(x, y))
}

/** Continue: past step 1 (opening a journey is not reading it), the one being walked first, then the last walked. */
function continueRows(sorted: ListRow[]): ListRow[] {
  return sorted.filter((r) => r.resume > 1 || r.walking).sort((x, y) =>
    Number(!!y.walking) - Number(!!x.walking) || (y.walkedAt ?? 0) - (x.walkedAt ?? 0))
}

/** Rows by area, the areas A–Z. */
function byArea(l: ListRow[]): [string, ListRow[]][] {
  const m = new Map<string, ListRow[]>()
  for (const r of l) m.set(r.area, [...(m.get(r.area) ?? []), r])
  return [...m].sort((x, y) => x[0].localeCompare(y[0]))
}

/** How many rows have each value of `key`. */
function countBy(rows: ListRow[], key: (r: ListRow) => string): Map<string, number> {
  const m = new Map<string, number>()
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1)
  return m
}

/** One section or group of rows; `more`: rows left out of a capped one. */
function part(id: string, label: string, rows: ListRow[], more = 0): Section {
  return { id, label, keys: keys(rows), ...(more ? { more } : {}) }
}

/** Each area's rows (areas A–Z), one part each. */
const areaParts = (rows: ListRow[]): Section[] => byArea(rows).map(([a, l]) => part(`area:${a}`, a, l))

/** What both the panel's sections and the sidebar's groups are made from. */
interface Parts {
  sort: Sort
  /** In this file (all of them, and as many as are shown). */
  here: ListRow[]; hereShown: ListRow[]
  cont: ListRow[]; fresh: ListRow[]; sorted: ListRow[]
  /** The active file's name, for "In <name>". */
  fileName?: string
}

/**
 * The panel's sections. A search: one, its results. The "here" chip: the rows in this file. Otherwise Continue,
 * In <file>, New, then the rest by area (or in one sorted section); each row once (what is listed above is not
 * repeated below). Empty sections are left out.
 */
function panelSections(p: Parts, area: string, results?: ListRow[]): Section[] {
  if (results) return [part('results', `${results.length} found`, results)]
  if (area === 'here') return [part('here', `In ${p.fileName ?? 'this file'}`, p.here)]
  const hereSection = !!p.fileName
  const above = new Set([...p.cont, ...(hereSection ? p.hereShown : []), ...p.fresh].map((r) => r.key))
  const rest = p.sorted.filter((r) => !above.has(r.key))
  const out: Section[] = [part('continue', 'Continue', p.cont)]
  if (hereSection) out.push(part('here', `In ${p.fileName}`, p.hereShown, p.here.length - p.hereShown.length))
  out.push(part('new', 'New', p.fresh))
  if (p.sort === 'area') out.push(...areaParts(rest))
  else out.push(part('all', SORTS.find((s) => s.id === p.sort)!.label, rest))
  return out.filter((s) => s.keys.length)
}

/** The sidebar's groups: In this file and Continue when they have rows, then All (by area, or flat). */
function sidebarGroups(p: Parts): Group[] {
  const out: Group[] = []
  if (p.here.length) out.push(part('here', 'In this file', p.hereShown, p.here.length - p.hereShown.length))
  if (p.cont.length) out.push(part('continue', 'Continue', p.cont))
  if (p.sort === 'area') out.push({ id: 'all', label: 'All', keys: [], children: areaParts(p.sorted) })
  else out.push(part('all', 'All', p.sorted))
  return out
}

/** The filter chip: 'here' (in the active file), 'stale', an area, or '' (none). */
function chipFilter(area: string): (r: ListRow) => boolean {
  if (area === 'here') return (r) => r.here
  if (area === 'stale') return (r) => r.stale > 0
  return (r) => !area || r.area === area
}

/** The list: rows (derived metadata), filtered by search/kind/area, sorted, in the panel's sections and the sidebar's groups. */
export function buildList(items: ListItem[], o: ListOptions = {}): ListModel {
  const now = o.now ?? Date.now()
  const query = (o.query ?? '').trim()
  const sort = o.sort ?? 'area'
  const kind = o.kind ?? 'all'
  const area = o.area ?? ''
  const rows: Record<string, ListRow> = Object.fromEntries(items.map((it) => [it.key, rowOf(it, o, now)]))
  const all = Object.values(rows)
  const inChip = chipFilter(area)
  const inFilter = (r: ListRow) => (kind === 'all' || r.kind === kind) && inChip(r)
  const { shown, scores, fallback } = search(all, query, inFilter)
  const sorted = [...shown].sort(ORDER[sort])
  if (sort === 'newest') stampSameAge(sorted)
  const here = hereRows(sorted)
  const parts: Parts = {
    sort, here, sorted,
    hereShown: o.hereAll ? here : here.slice(0, HERE_CAP),
    cont: continueRows(sorted),
    fresh: sorted.filter((r) => r.isNew),
    fileName: o.activeFile === undefined ? undefined : baseName(o.activeFile),
  }
  // A search keeps the list's order when one was picked (Newest, Recently walked, A–Z); "By area" means best match.
  const searchSort = o.searchSort ?? (sort === 'area' ? 'best' : sort)
  const best = (x: ListRow, y: ListRow) => (scores.get(y.key)! - scores.get(x.key)!) || ORDER[sort](x, y)
  const results = query ? [...shown].sort(searchSort === 'best' ? best : ORDER[searchSort]) : undefined
  const sections = panelSections(parts, area, results)
  const areas = [...countBy(all, (r) => r.area)]
    .map(([name, c]) => ({ name, count: c }))
    .sort((x, y) => y.count - x.count || x.name.localeCompare(y.name))
  return {
    rows, query, sort, searchSort, kind, area,
    ...(all.some((r) => r.here) ? { file: o.activeFile } : {}),
    kinds: [...countBy(all, (r) => r.kind)].map(([id, c]) => ({ id: id as ListKind, count: c })),
    areas,
    staleCount: all.filter((r) => r.stale > 0).length,
    ...(fallback ? { fallback } : {}),
    sections,
    groups: sidebarGroups(parts),
    count: shown.length,
    total: all.length,
  }
}

/**
 * "See also" under a check's question or at the end of its tour: the journey step that best shows `file` near `span`,
 * ranked as "In this file" ranks: a step on those lines first, then the journey with the most steps in the file, then
 * the nearest step. With several files (the tour's), the journey with the most steps in them, at its first one there.
 */
export function seeAlso(items: ListItem[], files: string[], span?: Span): { key: string; step: number } | undefined {
  const want = new Set(files)
  let best: { key: string; step: number; rank: SeeAlsoRank } | undefined
  for (const it of items) {
    if (it.kind !== 'journey') continue
    const here = it.files.flatMap((f, i) => (want.has(f) ? [i] : []))
    if (!here.length) continue
    const dist = (i: number) => {
      const r = it.ranges?.[i]
      return r && span ? distance(r, span) : FAR
    }
    const near = span ? here.reduce((a, i) => (dist(i) < dist(a) ? i : a)) : here[0]
    const rank = { onSpan: !!span && dist(near) === 0, stepsHere: here.length, distance: dist(near) }
    if (!best || byRank(rank, best.rank) < 0) best = { key: it.key, step: near + 1, rank }
  }
  return best && { key: best.key, step: best.step }
}

/** How well a journey shows the lines for "See also": a step on them, its steps in the file, its nearest step's distance. */
interface SeeAlsoRank { onSpan: boolean; stepsHere: number; distance: number }
/** The distance of a step without lines (or with no lines asked for): farther than any real one. */
const FAR = 1e6

/** Negative when `x` ranks before `y`: a step on the lines first, then the most steps in the file, then the nearest. */
function byRank(x: SeeAlsoRank, y: SeeAlsoRank): number {
  return Number(y.onSpan) - Number(x.onSpan) || y.stepsHere - x.stepsHere || x.distance - y.distance
}
