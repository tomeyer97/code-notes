// Finding journeys (docs/journey-list.md): one model of the list — rows with derived metadata, search, sort, groups —
// computed once in the extension and rendered by both the sidebar's Journeys view and the panel's home.
// No vscode API (the panel's tests load the compiled file as is): unit-tested in test/journeyList.test.ts. The search's
// word matching is match.ts.
import { matchScore, queryWords } from './match'
import { baseName } from '../paths'
import { ageOf, stamp } from '../time'
import { byPlace, Span, stepsIn } from './place'

/** Only journeys are listed; 'check' is the kind filter the panel can ask for (a check lives in the Check view). */
export type ListKind = 'journey' | 'check'
export type Sort = 'area' | 'newest' | 'walked' | 'name'
export const SORTS: { id: Sort; label: string }[] = [
  { id: 'area', label: 'By area' },
  { id: 'newest', label: 'Newest' },
  { id: 'walked', label: 'Recently walked' },
  { id: 'name', label: 'A–Z' },
]
/** "In this file" lists this many, then "Show all". */
export const HERE_CAP = 5
/** The sidebar lists fewer journeys than this in one flat list (no areas): grouping only helps a long list. */
export const FLAT_UNDER = 8

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
  /** The sidebar's groups: In this file · Continue · All (the rest: by area, or flat). */
  groups: Group[]
  /** The sidebar draws All's rows as its top rows, no heading: fewer than FLAT_UNDER journeys and All is the only
   *  group (a lone Continue or In this file keeps its heading: it says why the row is there). */
  flat: boolean
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

/** Ages and stamps: core/time.ts (with the other "how long ago"). */
export { ageOf, stamp } from '../time'

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
  const { inFile, onSpan } = stepsIn(it, new Set(o.activeFile ? [o.activeFile] : []), o.activeSpan)
  const cursorSteps = onSpan.length
  const hereSteps = inFile.length
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

/** A row the search found: how well it matched, and the words it matched (for highlighting). */
type Hit = { score: number; hits: string[] }

/**
 * The rows the search finds (all, without a query), and what each matched. Several words and no journey has them
 * all: rows with any of them, and one line saying so (an empty list is a dead end).
 */
interface Found { shown: ListRow[]; found: Map<string, Hit>; fallback?: ListModel['fallback'] }

function search(all: ListRow[], query: string, inFilter: (r: ListRow) => boolean): Found {
  const pick = (any: boolean) => {
    const found = new Map<string, Hit>()
    for (const r of all) {
      if (!inFilter(r)) continue
      const m = matchScore(r, query, any)
      if (m.score) found.set(r.key, m)
    }
    return { shown: all.filter((r) => found.has(r.key)), found }
  }
  const every = pick(false)
  const tokens = queryWords(query)
  if (every.shown.length || tokens.length < 2) return every
  const some = pick(true)
  if (!some.shown.length) return some
  const missing = tokens.filter((t) => !all.some((r) => inFilter(r) && matchScore(r, t).score))
  const matched = tokens.filter((t) => !missing.includes(t))
  const note = missing.length
    ? `No journey about ${quote(missing)}; closest for ${quote(matched)}`
    : 'No journey has every word; showing any'
  return { ...some, fallback: { missing, note } }
}

/** Sorted Newest: rows of the same age ("13 d") say when, so the newest can be told. The rows' new ages, by key. */
function sameAgeStamps(rows: ListRow[]): Map<string, string> {
  const byAge = new Map<string, ListRow[]>()
  for (const r of rows) if (r.age) byAge.set(r.age, [...(byAge.get(r.age) ?? []), r])
  const out = new Map<string, string>()
  for (const l of byAge.values()) {
    if (l.length < 2 || new Set(l.map(when)).size < 2) continue
    for (const r of l) out.set(r.key, stamp(when(r)))
  }
  return out
}

/** A row as the list shows it after the search and the sort: the words it matched, and its age as a stamp. */
function finished(r: ListRow, hit: Hit | undefined, age: string | undefined): ListRow {
  if (!hit && age === undefined) return r
  return {
    ...r,
    ...(age !== undefined ? { age, meta: [r.area, stepCount(r.steps), age].join(' · ') } : {}),
    hits: hit?.hits ?? [],
  }
}

/** In this file, ranked (place.ts): steps in the function under the cursor, then the most steps here; then the
 *  largest share of the journey. */
function hereRows(sorted: ListRow[]): ListRow[] {
  const share = (r: ListRow) => r.hereSteps / r.steps
  const place = (r: ListRow) => ({ onSpan: r.cursorSteps, inFile: r.hereSteps })
  return sorted.filter((r) => r.here).sort((x, y) => byPlace(place(x), place(y)) || share(y) - share(x) || byName(x, y))
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

/** The rows after the search, the filters and the sort, and the lists both views are made of. */
interface ListRows {
  sort: Sort
  sorted: ListRow[]
  /** In this file: all of them, and as many as are shown (HERE_CAP, unless shown in full). */
  inFileRows: ListRow[]; inFileShown: ListRow[]
  continueRows: ListRow[]; newRows: ListRow[]
  /** The active file's name, for "In <name>". */
  fileName?: string
}

/**
 * The panel's sections. A search: one, its results. The "here" chip: the rows in this file. Otherwise Continue,
 * In <file>, New, then the rest by area (or in one sorted section); each row once (what is listed above is not
 * repeated below). Empty sections are left out.
 */
function panelSections(p: ListRows, area: string, results?: ListRow[]): Section[] {
  if (results) return [part('results', `${results.length} found`, results)]
  if (area === 'here') return [part('here', `In ${p.fileName ?? 'this file'}`, p.inFileRows)]
  const hereSection = !!p.fileName
  const above = new Set([...p.continueRows, ...(hereSection ? p.inFileShown : []), ...p.newRows].map((r) => r.key))
  const rest = p.sorted.filter((r) => !above.has(r.key))
  const out: Section[] = [part('continue', 'Continue', p.continueRows)]
  if (hereSection) out.push(part('here', `In ${p.fileName}`, p.inFileShown, p.inFileRows.length - p.inFileShown.length))
  out.push(part('new', 'New', p.newRows))
  if (p.sort === 'area') out.push(...areaParts(rest))
  else out.push(part('all', SORTS.find((s) => s.id === p.sort)!.label, rest))
  return out.filter((s) => s.keys.length)
}

/** The sidebar's groups: In this file (but the walk's journey) and Continue when they have rows, then All: the rest,
 *  by area or flat (flat while the workspace has fewer than FLAT_UNDER journeys, `total`); each journey once in
 *  Continue or All. */
function sidebarGroups(p: ListRows, total: number): Group[] {
  const out: Group[] = []
  // The journey being walked (or listened to) is in Continue: not again in "In this file", which would come and go as
  // the walk changes files.
  const walking = new Set(p.continueRows.filter((r) => r.walking).map((r) => r.key))
  const hereShown = p.inFileShown.filter((r) => !walking.has(r.key))
  const hereAll = p.inFileRows.filter((r) => !walking.has(r.key))
  if (hereAll.length) out.push(part('here', 'In this file', hereShown, hereAll.length - hereShown.length))
  if (p.continueRows.length) out.push(part('continue', 'Continue', p.continueRows))
  const continued = new Set(keys(p.continueRows))
  const rest = p.sorted.filter((r) => !continued.has(r.key))
  if (!rest.length) return out
  if (p.sort === 'area' && total >= FLAT_UNDER) out.push({ id: 'all', label: 'All', keys: [], children: areaParts(rest) })
  else out.push(part('all', 'All', rest))
  return out
}

/** The filter chip: 'here' (in the active file), 'stale', an area, or '' (none). */
function chipFilter(area: string): (r: ListRow) => boolean {
  if (area === 'here') return (r) => r.here
  if (area === 'stale') return (r) => r.stale > 0
  return (r) => !area || r.area === area
}

/** The list: rows (derived metadata), filtered by search/kind/area, sorted, in the panel's sections and the sidebar's
 *  groups (one model: the panel and the sidebar show the same rows and counts). */
export function buildList(items: ListItem[], o: ListOptions = {}): ListModel {
  const query = (o.query ?? '').trim()
  const sort = o.sort ?? 'area'
  const kind = o.kind ?? 'all'
  const area = o.area ?? ''
  const now = o.now ?? Date.now()
  const base = items.map((it) => rowOf(it, o, now))
  const inChip = chipFilter(area)
  const { shown: found, found: hits, fallback } = search(base, query, (r) => (kind === 'all' || r.kind === kind) && inChip(r))
  const stamps = sort === 'newest' ? sameAgeStamps(found) : new Map<string, string>()
  const all = base.map((r) => finished(r, hits.get(r.key), stamps.get(r.key)))
  const rows: Record<string, ListRow> = Object.fromEntries(all.map((r) => [r.key, r]))
  const shown = found.map((r) => rows[r.key])
  const list = listRows(shown, sort, o)
  // A search keeps the list's order when one was picked (Newest, Recently walked, A–Z); "By area" means best match.
  const searchSort = o.searchSort ?? (sort === 'area' ? 'best' : sort)
  const best = (x: ListRow, y: ListRow) => (hits.get(y.key)!.score - hits.get(x.key)!.score) || ORDER[sort](x, y)
  const results = query ? [...shown].sort(searchSort === 'best' ? best : ORDER[searchSort]) : undefined
  const groups = sidebarGroups(list, all.length)
  return {
    rows, query, sort, searchSort, kind, area,
    ...(all.some((r) => r.here) ? { file: o.activeFile } : {}),
    kinds: [...countBy(all, (r) => r.kind)].map(([id, c]) => ({ id: id as ListKind, count: c })),
    areas: areaCounts(all),
    staleCount: all.filter((r) => r.stale > 0).length,
    ...(fallback ? { fallback } : {}),
    sections: panelSections(list, area, results),
    groups,
    flat: all.length < FLAT_UNDER && groups.length === 1 && groups[0].id === 'all' && !groups[0].children,
    count: shown.length,
    total: all.length,
  }
}

/** The shown rows sorted, and the lists both views are made of: In this file, Continue, New. */
function listRows(shown: ListRow[], sort: Sort, o: ListOptions): ListRows {
  const sorted = [...shown].sort(ORDER[sort])
  const inFileRows = hereRows(sorted)
  return {
    sort, sorted, inFileRows,
    inFileShown: o.hereAll ? inFileRows : inFileRows.slice(0, HERE_CAP),
    continueRows: continueRows(sorted),
    newRows: sorted.filter((r) => r.isNew),
    fileName: o.activeFile === undefined ? undefined : baseName(o.activeFile),
  }
}

/** The areas with rows, the largest first (for the chips). */
const areaCounts = (all: ListRow[]) => [...countBy(all, (r) => r.area)]
  .map(([name, count]) => ({ name, count }))
  .sort((x, y) => y.count - x.count || x.name.localeCompare(y.name))

/** "See also": seeAlso.ts. */
export { seeAlso } from './seeAlso'

/** The first step title holding a word the search matched ('' without one): said under a search result. */
export function matchedStep(r: Pick<ListRow, 'stepTitles' | 'hits'>): string {
  return r.stepTitles.find((t) => r.hits.some((h) => t.toLowerCase().includes(h))) ?? ''
}
