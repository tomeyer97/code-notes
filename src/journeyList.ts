// Finding journeys (docs/journey-list.md): one model of the list — rows with derived metadata, search, sort, groups —
// computed once in the extension and rendered by both the sidebar's Journeys view and the panel's home.
// Pure (no imports): unit-tested in test/journeyList.test.ts.

/** Only journeys are listed ('review': nothing makes one yet). 'check' is not listed: a check lives in the Check view. */
export type ListKind = 'journey' | 'check' | 'review'
export type Sort = 'area' | 'newest' | 'walked' | 'name'
export const SORTS: { id: Sort; label: string }[] = [
  { id: 'area', label: 'By area' }, { id: 'newest', label: 'Newest' }, { id: 'walked', label: 'Recently walked' }, { id: 'name', label: 'A–Z' },
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
  const first = files.map(top).find((a) => n.get(a) === best)!
  return first
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

const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean)
/** A word matches a query token when it starts with it ("retr" → "retries"); tokens of 4+ letters also inside a word. */
/** A light stem: "retries" and "retry", "charged" and "charge" meet. */
const stem = (w: string) => (w.length > 4 ? w.replace(/ies$/, 'y').replace(/(es|s|ed|ing)$/, '') : w)
const wordHit = (w: string, t: string) => w.startsWith(t) || (t.length >= 4 && w.includes(t)) || (t.length >= 4 && stem(w).startsWith(stem(t)))

/**
 * How well an item matches the query (0: not at all): every token must be found in the title, question, summary,
 * step titles or file paths (`any`: at least one); title hits weigh most. Also returns the words that matched.
 */
export function matchScore(it: ListItem, query: string, any = false): { score: number; hits: string[] } {
  const tokens = words(query)
  if (!tokens.length) return { score: 1, hits: [] }
  const fields: [string[], number][] = [[words(it.title), 6], [words(it.question), 4], [words(it.stepTitles.join(' ')), 2], [words(it.summary), 1.5], [words(it.files.join(' ')), 1]]
  let score = 0
  const hits = new Set<string>()
  for (const t of tokens) {
    let best = 0
    for (const [ws, w] of fields) for (const x of ws) if (wordHit(x, t)) { best = Math.max(best, w * (x === t ? 1.5 : 1)); hits.add(x) }
    if (!best && !any) return { score: 0, hits: [] }
    score += best
  }
  return { score, hits: [...hits] }
}

export interface ListOptions {
  activeFile?: string
  /** The cursor's function (or line) in the active file, 1-based: journeys with a step there come first in "In this file". */
  activeSpan?: { start: number; end: number }
  /** "In this file" in full (else HERE_CAP rows and "Show all"). */
  hereAll?: boolean
  query?: string; sort?: Sort; kind?: ListKind | 'all'; area?: string; now?: number
}

const quote = (ws: string[]) => ws.map((w) => `“${w}”`).join(', ')

/** The list: rows (derived metadata), filtered by search/kind/area, sorted, in the panel's sections and the sidebar's groups. */
export function buildList(items: ListItem[], o: ListOptions = {}): ListModel {
  const now = o.now ?? Date.now()
  const query = (o.query ?? '').trim(), sort = o.sort ?? 'area', kind = o.kind ?? 'all', area = o.area ?? ''
  const rows: Record<string, ListRow> = {}
  const span = o.activeSpan
  for (const it of items) {
    const a = areaOf(it.files), age = ageOf(it.createdAt, now)
    const hereIdx = o.activeFile ? it.files.flatMap((f, i) => (f === o.activeFile ? [i] : [])) : []
    const atCursor = !!span && hereIdx.some((i) => { const r = it.ranges?.[i]; return !!r && r.start <= span.end && r.end >= span.start })
    const meta = [a, `${it.steps} step${it.steps === 1 ? '' : 's'}`, age].filter(Boolean).join(' · ')
    const hereText = hereIdx.length ? `${hereIdx.length} of ${it.steps} step${it.steps === 1 ? '' : 's'} here` : ''
    rows[it.key] = { ...it, area: a, age, here: hereIdx.length > 0, hereSteps: hereIdx.length, atCursor, meta, hereText, hits: [] }
  }
  const all = Object.values(rows)
  const inFilter = (r: ListRow) => (kind === 'all' || r.kind === kind) && (area === 'here' ? r.here : area === 'stale' ? r.stale > 0 : !area || r.area === area)
  const scores = new Map<string, number>()
  const pick = (any: boolean) => all.filter((r) => {
    if (!inFilter(r)) return false
    const m = matchScore(r, query, any)
    if (!m.score) return false
    r.hits = m.hits
    scores.set(r.key, m.score)
    return true
  })
  let shown = pick(false)
  // Several words and no journey has them all: any of them, said in one line (an empty list is a dead end).
  let fallback: ListModel['fallback']
  const tokens = words(query)
  if (!shown.length && tokens.length > 1) {
    shown = pick(true)
    if (shown.length) {
      const missing = tokens.filter((t) => !all.some((r) => inFilter(r) && matchScore(r, t).score))
      const found = tokens.filter((t) => !missing.includes(t))
      fallback = { missing, note: missing.length ? `Nothing mentions ${quote(missing)}; showing ${quote(found)}` : 'No journey has every word; showing any' }
    }
  }
  const byName = (x: ListRow, y: ListRow) => x.title.localeCompare(y.title)
  const order: Record<Sort, (x: ListRow, y: ListRow) => number> = {
    area: (x, y) => x.area.localeCompare(y.area) || byName(x, y),
    newest: (x, y) => (y.createdAt ?? '').localeCompare(x.createdAt ?? '') || byName(x, y),
    walked: (x, y) => (y.walkedAt ?? 0) - (x.walkedAt ?? 0) || byName(x, y),
    name: byName,
  }
  const sorted = [...shown].sort(order[sort])
  const keys = (l: ListRow[]) => l.map((r) => r.key)
  const fileName = o.activeFile?.split('/').pop()
  // In this file, ranked: a step in the function under the cursor, then the most steps here, then the largest share.
  const hereRows = sorted.filter((r) => r.here).sort((x, y) => Number(y.atCursor) - Number(x.atCursor) || y.hereSteps - x.hereSteps || y.hereSteps / y.steps - x.hereSteps / x.steps || byName(x, y))
  const capped = o.hereAll ? hereRows : hereRows.slice(0, HERE_CAP)
  const hereMore = hereRows.length - capped.length
  // Continue: past step 1 (opening a journey is not reading it), the one being walked first.
  const cont = sorted.filter((r) => r.resume > 1 || r.walking).sort((x, y) => Number(!!y.walking) - Number(!!x.walking) || (y.walkedAt ?? 0) - (x.walkedAt ?? 0))
  const fresh = sorted.filter((r) => r.isNew)
  const byArea = (l: ListRow[]) => {
    const m = new Map<string, ListRow[]>()
    for (const r of l) m.set(r.area, [...(m.get(r.area) ?? []), r])
    return [...m].sort((x, y) => x[0].localeCompare(y[0]))
  }
  const hereSection = fileName && area !== 'here'
  let sections: Section[]
  if (query) sections = [{ id: 'results', label: `${shown.length} found`, keys: keys([...shown].sort((x, y) => (scores.get(y.key)! - scores.get(x.key)!) || order[sort](x, y))) }]
  else if (area === 'here') sections = [{ id: 'here', label: `In ${fileName ?? 'this file'}`, keys: keys(hereRows) }]
  else {
    const above = new Set([...cont, ...(hereSection ? capped : []), ...fresh].map((r) => r.key))
    sections = [
      { id: 'continue', label: 'Continue', keys: keys(cont) },
      ...(hereSection ? [{ id: 'here', label: `In ${fileName}`, keys: keys(capped), ...(hereMore ? { more: hereMore } : {}) }] : []),
      { id: 'new', label: 'New', keys: keys(fresh) },
      // The rest: each row once on the panel (what is listed above is not repeated below).
      ...(sort === 'area' ? byArea(sorted.filter((r) => !above.has(r.key))).map(([a, l]) => ({ id: `area:${a}`, label: a, keys: keys(l) })) : [{ id: 'all', label: SORTS.find((s) => s.id === sort)!.label, keys: keys(sorted.filter((r) => !above.has(r.key))) }]),
    ].filter((s) => s.keys.length)
  }
  const groups: Group[] = [
    ...(hereRows.length ? [{ id: 'here', label: 'In this file', keys: keys(capped), ...(hereMore ? { more: hereMore } : {}) }] : []),
    ...(cont.length ? [{ id: 'continue', label: 'Continue', keys: keys(cont) }] : []),
    { id: 'all', label: 'All', keys: sort === 'area' ? [] : keys(sorted), ...(sort === 'area' ? { children: byArea(sorted).map(([a, l]) => ({ id: `area:${a}`, label: a, keys: keys(l) })) } : {}) },
  ]
  const count = (pick: (r: ListRow) => string) => { const m = new Map<string, number>(); for (const r of all) m.set(pick(r), (m.get(pick(r)) ?? 0) + 1); return m }
  return {
    rows, query, sort, kind, area, ...(all.some((r) => r.here) ? { file: o.activeFile } : {}),
    kinds: [...count((r) => r.kind)].map(([id, c]) => ({ id: id as ListKind, count: c })),
    areas: [...count((r) => r.area)].map(([name, c]) => ({ name, count: c })).sort((x, y) => y.count - x.count || x.name.localeCompare(y.name)),
    staleCount: all.filter((r) => r.stale > 0).length,
    ...(fallback ? { fallback } : {}),
    sections, groups, count: shown.length, total: all.length,
  }
}

/**
 * "See also" under a check's question or at the end of its tour: the journey step that best shows `file` near `span`,
 * ranked as "In this file" ranks: a step on those lines first, then the journey with the most steps in the file, then
 * the nearest step. With several files (the tour's), the journey with the most steps in them, at its first one there.
 */
export function seeAlso(items: ListItem[], files: string[], span?: { start: number; end: number }): { key: string; step: number } | undefined {
  const want = new Set(files)
  let best: { key: string; step: number; rank: number[] } | undefined
  for (const it of items) {
    if (it.kind !== 'journey') continue
    const here = it.files.flatMap((f, i) => (want.has(f) ? [i] : []))
    if (!here.length) continue
    const dist = (i: number) => { const r = it.ranges?.[i]; if (!r || !span) return 1e6; return r.end < span.start ? span.start - r.end : r.start > span.end ? r.start - span.end : 0 }
    const near = span ? here.reduce((a, i) => (dist(i) < dist(a) ? i : a)) : here[0]
    const rank = [span && dist(near) === 0 ? 0 : 1, -here.length, dist(near)]
    const k = best ? rank.findIndex((v, i) => v !== best!.rank[i]) : -1
    if (!best || (k >= 0 && rank[k] < best.rank[k])) best = { key: it.key, step: near + 1, rank }
  }
  return best && { key: best.key, step: best.step }
}
