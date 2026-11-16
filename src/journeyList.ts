// Finding journeys (docs/journey-list.md): one model of the list — rows with derived metadata, search, sort, groups —
// computed once in the extension and rendered by both the sidebar's Journeys view and the panel's home.
// Pure (no imports): unit-tested in test/journeyList.test.ts.

export type ListKind = 'journey' | 'check' | 'review'
export type Sort = 'area' | 'newest' | 'walked' | 'name'
export const SORTS: { id: Sort; label: string }[] = [
  { id: 'area', label: 'By area' }, { id: 'newest', label: 'Newest' }, { id: 'walked', label: 'Recently walked' }, { id: 'name', label: 'A–Z' },
]

/** What the extension knows about one entry. */
export interface ListItem {
  key: string; kind: ListKind; title: string; question: string; summary: string
  createdAt?: string
  /** Each step's file (in order) and title: the area, "In this file", search. */
  files: string[]; stepTitles: string[]
  steps: number
  /** Steps whose code changed since the journey was written. */
  stale: number
  /** Never opened (personal, workspace state). */
  isNew: boolean
  /** Left at this step (0: not started or finished). */
  resume: number
  /** When it was last walked (ms). */
  walkedAt?: number
  /** A check's progress ("2/4 ✓") and whether it is still open (not passed). */
  progress?: string; open?: boolean
  start?: boolean
}

export interface ListRow extends ListItem {
  area: string
  /** "today", "3 d", "2 wk", "5 mo", "1 y"; '' without a date. */
  age: string
  /** One of its steps is in the active editor's file. */
  here: boolean
  /** Muted metadata: "api · 9 steps · 2 wk" (a check: "2/4 ✓"). */
  meta: string
  /** The words of the query it matched (for highlighting). */
  hits: string[]
}
export interface Section { id: string; label: string; keys: string[] }
export interface Group { id: string; label: string; keys: string[]; children?: Group[] }
export interface ListModel {
  rows: Record<string, ListRow>
  query: string; sort: Sort; kind: ListKind | 'all'; area: string
  /** The active editor's file (relative), when a journey has a step in it. */
  file?: string
  /** For chips: kinds and areas that have rows, with counts. */
  kinds: { id: ListKind; count: number }[]
  areas: { name: string; count: number }[]
  /** The panel's sections (a search: one, "results", best first). */
  sections: Section[]
  /** The sidebar's groups: In this file · Continue · Checks · All (by area, or flat). */
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
 * step titles or file paths; title hits weigh most. Also returns the words that matched.
 */
export function matchScore(it: ListItem, query: string): { score: number; hits: string[] } {
  const tokens = words(query)
  if (!tokens.length) return { score: 1, hits: [] }
  const fields: [string[], number][] = [[words(it.title), 6], [words(it.question), 4], [words(it.stepTitles.join(' ')), 2], [words(it.summary), 1.5], [words(it.files.join(' ')), 1]]
  let score = 0
  const hits = new Set<string>()
  for (const t of tokens) {
    let best = 0
    for (const [ws, w] of fields) for (const x of ws) if (wordHit(x, t)) { best = Math.max(best, w * (x === t ? 1.5 : 1)); hits.add(x) }
    if (!best) return { score: 0, hits: [] }
    score += best
  }
  return { score, hits: [...hits] }
}

export interface ListOptions { activeFile?: string; query?: string; sort?: Sort; kind?: ListKind | 'all'; area?: string; now?: number }

/** The list: rows (derived metadata), filtered by search/kind/area, sorted, in the panel's sections and the sidebar's groups. */
export function buildList(items: ListItem[], o: ListOptions = {}): ListModel {
  const now = o.now ?? Date.now()
  const query = (o.query ?? '').trim(), sort = o.sort ?? 'area', kind = o.kind ?? 'all', area = o.area ?? ''
  const rows: Record<string, ListRow> = {}
  for (const it of items) {
    const a = areaOf(it.files), age = ageOf(it.createdAt, now)
    const here = !!o.activeFile && it.files.includes(o.activeFile)
    const meta = it.kind === 'check' ? [it.progress, age].filter(Boolean).join(' · ') : [a, `${it.steps} step${it.steps === 1 ? '' : 's'}`, age].filter(Boolean).join(' · ')
    rows[it.key] = { ...it, area: a, age, here, meta, hits: [] }
  }
  const all = Object.values(rows)
  const scores = new Map<string, number>()
  const shown = all.filter((r) => {
    if (kind !== 'all' && r.kind !== kind) return false
    if (area === 'here' ? !r.here : area && r.area !== area) return false
    const m = matchScore(r, query)
    if (!m.score) return false
    r.hits = m.hits
    scores.set(r.key, m.score)
    return true
  })
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
  const hereRows = sorted.filter((r) => r.here)
  const cont = sorted.filter((r) => r.resume > 0 && r.kind !== 'check').sort((x, y) => (y.walkedAt ?? 0) - (x.walkedAt ?? 0))
  // Checks: the open ones (a passed one only when asked for by its chip); never under All or an area.
  const checks = sorted.filter((r) => r.kind === 'check' && (r.open !== false || kind === 'check'))
  const fresh = sorted.filter((r) => r.isNew && r.kind !== 'check')
  const byArea = (l: ListRow[]) => {
    const m = new Map<string, ListRow[]>()
    for (const r of l) m.set(r.area, [...(m.get(r.area) ?? []), r])
    return [...m].sort((x, y) => x[0].localeCompare(y[0]))
  }
  const rest = sorted.filter((r) => r.kind !== 'check')
  let sections: Section[]
  if (query) sections = [{ id: 'results', label: `${shown.length} found`, keys: keys([...shown].sort((x, y) => (scores.get(y.key)! - scores.get(x.key)!) || order[sort](x, y))) }]
  else {
    const above = new Set([...cont, ...(fileName && area !== 'here' ? hereRows : []), ...checks, ...fresh].map((r) => r.key))
    sections = [
      { id: 'continue', label: 'Continue', keys: keys(cont) },
      ...(fileName && area !== 'here' ? [{ id: 'here', label: `In ${fileName}`, keys: keys(hereRows) }] : []),
      { id: 'checks', label: 'Checks', keys: keys(checks) },
      { id: 'new', label: 'New', keys: keys(fresh) },
      // The rest: each row once on the panel (what is listed above is not repeated below).
      ...(sort === 'area' ? byArea(rest.filter((r) => !above.has(r.key))).map(([a, l]) => ({ id: `area:${a}`, label: a, keys: keys(l) })) : [{ id: 'all', label: SORTS.find((s) => s.id === sort)!.label, keys: keys(rest.filter((r) => !above.has(r.key))) }]),
    ].filter((s) => s.keys.length)
  }
  const groups: Group[] = [
    ...(hereRows.length ? [{ id: 'here', label: 'In this file', keys: keys(hereRows) }] : []),
    ...(cont.length ? [{ id: 'continue', label: 'Continue', keys: keys(cont) }] : []),
    ...(checks.length ? [{ id: 'checks', label: 'Checks', keys: keys(checks) }] : []),
    { id: 'all', label: 'All', keys: sort === 'area' ? [] : keys(rest), ...(sort === 'area' ? { children: byArea(rest).map(([a, l]) => ({ id: `area:${a}`, label: a, keys: keys(l) })) } : {}) },
  ]
  const count = (pick: (r: ListRow) => string) => { const m = new Map<string, number>(); for (const r of all) m.set(pick(r), (m.get(pick(r)) ?? 0) + 1); return m }
  return {
    rows, query, sort, kind, area, ...(hereRows.length || all.some((r) => r.here) ? { file: o.activeFile } : {}),
    kinds: [...count((r) => r.kind)].map(([id, c]) => ({ id: id as ListKind, count: c })),
    areas: [...count((r) => r.area)].map(([name, c]) => ({ name, count: c })).sort((x, y) => y.count - x.count || x.name.localeCompare(y.name)),
    sections, groups, count: shown.length, total: all.length,
  }
}
