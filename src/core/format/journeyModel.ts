// A code journey (format v2: docs/journey-format.md): a nested map (systems ⊃ modules ⊃ functions) plus an ordered path of steps, embedded
// in the journey file. A step is NOT a note: it is read-only explanation, never unread, never counted.
// Pure (no imports): the extension uses it, and the map webview loads the compiled file as is. How step text is
// written out (paths in it, markdown) is journeys/textFormat.ts.

/** `store`: the app's own record/queue/table two parts of the path meet through: dashed on the map, never "external". */
export const KINDS = ['system', 'module', 'external', 'store', 'function'] as const
export type Kind = typeof KINDS[number]
/**
 * `blurb`: the short text shown in the box (the summary is then its tooltip); `path`: where it lives (tooltip, small
 * text). `lane`: still read, but the whole-journey map (0.21, ELK) lays boxes out itself and ignores it.
 */
export interface JNode {
  id: string; kind: Kind; label: string; summary: string; blurb?: string; path?: string; parent?: string; lane?: 'main' | 'side'
  at?: { file: string; start: number; end: number; anchor?: JAnchor }
}
/** `label`: what the map shows; `detail`: the sentence (tooltip). */
export interface JEdge { from: string; to: string; label: string; detail?: string; async?: boolean }
/**
 * The code a step is about, to find it again: v2 (`text`: the whole block, anchor.ts) or v3 (compact: first and last
 * lines, length, hash; compact.ts). `before`/`after`: the lines around it.
 */
export type JAnchor = { text: string; before: string; after: string }
  | { v: 3; head: string; tail: string; lines: number; hash: string; before: string; after: string }
/**
 * `n`: its position (1-based). `range`: 1-based lines as written in the file (the extension relocates them in memory).
 * `lead`: the short explanation always shown; `details`: markdown behind "More"; `refs`: up to 3 `path:line`.
 */
export interface JStep {
  /** Stable across edits of the journey; `#<n>` when the file has none (then position-based). */
  id: string; n: number; title: string; node: string; file: string; range: { start: number; end: number }; anchor?: JAnchor
  lead: string; details?: string; refs: string[]
  /** The step's animation (media/journey-scene.js says what is in it): played beat by beat in place of the map. */
  scene?: JScene
  /** Code links (codeLinkText.ts): phrases of the lead/details that link to the lines doing what they say. */
  links?: StepLink[]
  /** Value hints (valueHints.ts): what a variable holds in the example run, shown faintly above its line while the step is open. */
  values?: ValueHint[]
  /** Marks (marks/model.ts, as written: read when the step is walked): the parts of its lines the step is about. */
  marks?: unknown
}
/** A code link: `phrase`: words of the step's lead or details, as written; `text`: the first of its lines (to find them again). */
export interface StepLink { phrase: string; file: string; start: number; end: number; text: string }
/**
 * A value hint (valueHints.ts): `name`: the variable; `value`: what it holds, on one line; `text`: the line it is on (to
 * find it again); `note`: a few words on what the value is, after it on the same row.
 */
export interface ValueHint { name: string; value: string; note?: string; file: string; line: number; text: string }
/** `code`: the line that does what the beat shows; `example`: an example of the value in play there (written by the author, not captured);
 *  `marks`: as a step's, lit while the beat is (their file defaults to the beat's code file). */
export interface JBeat { focus: string; caption: string; muted?: string; code?: { file: string; line: number; text: string }; marks?: unknown; [k: string]: unknown }
export interface JScene { actors: unknown[]; wires?: unknown[]; beats: JBeat[] }
export interface Journey {
  id: string; question: string; title: string; summary: string; model?: string; commit?: string; createdAt?: string
  /** The journey to start with: marked "Start here" in the Journeys list. */
  start?: boolean
  nodes: JNode[]; edges: JEdge[]; steps: JStep[]
  /** What breaks the format's rules (dropped parts, long labels, crowded levels): shown on the map, not only logged. */
  problems: string[]
}

export const FORMAT_VERSION = 2
/** Journey file versions read (3: the same format, written with compact anchors). */
export const READ_VERSIONS = [2, 3]
export const MAX_REFS = 3

const str = (v: unknown) => (typeof v === 'string' ? v : '')
/** `{ [k]: v }` when `keep`, else nothing: spread into an object for an optional field. The same as noteModel.ts `opt`
 *  (keep the two in sync): this file has no imports, the map webview loads it as a plain script. */
const opt = <K extends string, V>(keep: unknown, k: K, v: V) => (keep ? { [k]: v } as { [P in K]: V } : {})
/** `{ [k]: text }` when `v` is a string with something in it, trimmed; else nothing. (noteModel.ts `optString` keeps
 *  any string as it is: a note file's strings are not trimmed.) */
const optTrimmed = <K extends string>(k: K, v: unknown) => opt(str(v).trim(), k, str(v).trim())
const line = (x: unknown) => (Number.isInteger(x) && (x as number) >= 1 ? (x as number) : undefined)

/** An anchor as written (v2 full text, or v3 compact); undefined when it is neither. */
export function readAnchor(v: any): JAnchor | undefined {
  if (!v || typeof v !== 'object') return undefined
  if (v.v === 3) {
    if (typeof v.head !== 'string' || !v.head.trim()) return undefined
    const lines = Number.isInteger(v.lines) && v.lines > 0 ? v.lines : v.head.split('\n').length
    return { v: 3, head: v.head, tail: str(v.tail) || v.head.split('\n').pop(), lines, hash: str(v.hash), before: str(v.before), after: str(v.after) }
  }
  return typeof v.text === 'string' ? { text: v.text, before: str(v.before), after: str(v.after) } : undefined
}

/** A node as written; why it is left out (no id, or one already used), as a string. */
function readNode(n: any, ids: Set<string>): JNode | string {
  if (!n || typeof n.id !== 'string' || !n.id) return 'a node without an id was left out'
  if (ids.has(n.id)) return `node "${n.id}" is defined twice (the second one was left out)`
  const anchor = n.at ? readAnchor(n.at.anchor) : undefined
  const at = n.at && typeof n.at.file === 'string' && Number.isInteger(n.at.start)
    ? { file: n.at.file, start: n.at.start, end: Number.isInteger(n.at.end) ? n.at.end : n.at.start, ...opt(anchor, 'anchor', anchor) } : undefined
  return {
    id: n.id, kind: KINDS.includes(n.kind) ? n.kind : 'module', label: str(n.label) || n.id, summary: str(n.summary),
    ...optTrimmed('blurb', n.blurb), ...optTrimmed('path', n.path),
    ...opt(typeof n.parent === 'string' && n.parent, 'parent', n.parent as string),
    ...opt(n.lane === 'main' || n.lane === 'side', 'lane', n.lane as 'main' | 'side'),
    ...opt(at, 'at', at!),
  }
}

/** A parent that doesn't exist, or a loop of parents: the node goes to the top level. */
function dropBadParents(nodes: JNode[], problems: string[]): void {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (const n of nodes) {
    const seen = new Set<string>([n.id])
    for (let p = n.parent; p; p = byId.get(p)?.parent) {
      if (!byId.has(p) || seen.has(p)) { problems.push(`node "${n.id}": parent "${p}" ${byId.has(p) ? 'makes a loop' : 'doesn\'t exist'}`); delete n.parent; break }
      seen.add(p)
    }
  }
}

/** An arrow between two boxes that exist; why it is hidden, as a string. */
function readEdge(e: any, nodes: JNode[]): JEdge | string {
  const label = (id: unknown) => {
    const n = nodes.find((x) => x.id === id)
    return n ? `"${n.label}"` : `a box that doesn't exist ("${id ?? '?'}")`
  }
  if (e && e.from === e.to) return `an arrow from ${label(e.from)} to itself is hidden`
  if (!e || !nodes.some((n) => n.id === e.from) || !nodes.some((n) => n.id === e.to)) return `an arrow from ${label(e?.from)} to ${label(e?.to)} is hidden`
  return { from: e.from, to: e.to, label: str(e.label), ...optTrimmed('detail', e.detail), ...opt(e.async, 'async', true as const) }
}

/** Why step `s` can't be shown, or ''. */
function stepProblem(s: any, ids: Set<string>): string {
  if (!s) return 'is empty'
  if (!ids.has(s.node)) return `is in an unknown box "${s.node}"`
  if (!str(s.file).trim()) return 'has no file'
  if (!(s.range && line(s.range.start))) return 'has no line range'
  return ''
}

/** A step's `links` as written in the journey file: the usable ones; `end` is at least `start`. */
export function readLinks(v: unknown): StepLink[] {
  if (!Array.isArray(v)) return []
  const usable = (l: any) => l
    && typeof l.phrase === 'string' && l.phrase.trim()
    && typeof l.file === 'string'
    && Number.isInteger(l.start) && l.start >= 1
  return v.filter(usable).map((l) => ({
    phrase: l.phrase.trim(), file: l.file.trim(), start: l.start,
    end: Math.max(l.start, Number.isInteger(l.end) ? l.end : l.start),
    text: typeof l.text === 'string' ? l.text : '',
  }))
}

/** A step's `values` as written in the journey file: the usable ones, each value and note on one line. */
export function readValues(v: unknown): ValueHint[] {
  if (!Array.isArray(v)) return []
  const usable = (x: any) => x
    && typeof x.name === 'string' && x.name.trim()
    && typeof x.value === 'string'
    && typeof x.file === 'string'
    && Number.isInteger(x.line) && x.line >= 1
  const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
  return v.filter(usable).map((x) => ({
    name: x.name.trim(), value: oneLine(x.value), file: x.file.trim(), line: x.line, text: typeof x.text === 'string' ? x.text : '',
    ...(typeof x.note === 'string' && x.note.trim() ? { note: oneLine(x.note) } : {}),
  }))
}

/** Step `n` (1-based, after the steps left out) as written; `stepIds`: ids taken so far. */
function readStep(s: any, n: number, stepIds: Set<string>, problems: string[]): JStep {
  const start = line(s.range.start)!
  const end = Math.max(start, line(s.range.end) ?? start)
  const refs = (Array.isArray(s.refs) ? s.refs : []).filter((r: unknown) => typeof r === 'string' && r.trim()).map((r: string) => r.trim())
  if (refs.length > MAX_REFS) problems.push(`step ${n}: ${refs.length} references (at most ${MAX_REFS} are shown)`)
  let id = str(s.id).trim() || `#${n}`
  if (stepIds.has(id)) { problems.push(`step ${n}: id "${id}" is used twice`); id = `#${n}` }
  stepIds.add(id)
  const a = readAnchor(s.anchor)
  const scene = s.scene && Array.isArray(s.scene.beats) && Array.isArray(s.scene.actors) && s.scene.beats.length
  return {
    id, n, title: str(s.title).trim() || `Step ${n}`, node: s.node, file: str(s.file).trim(), range: { start, end },
    ...opt(a, 'anchor', a!), lead: str(s.lead).trim(), ...optTrimmed('details', s.details), refs: refs.slice(0, MAX_REFS),
    ...opt(Array.isArray(s.links) && s.links.length, 'links', s.links),
    ...opt(Array.isArray(s.values) && s.values.length, 'values', s.values),
    ...opt(s.marks !== undefined, 'marks', s.marks as unknown),
    ...opt(scene, 'scene', s.scene as JScene),
  }
}

/** How parseJourney's reason for refusing a file in an old format (v1: steps as notes) starts. */
const OLD_FORMAT = 'format v'
/** parseJourney refused the file (`why`) because it is in an old format: it is not broken, it needs migrating. */
export const isOldFormat = (why: string) => why.startsWith(OLD_FORMAT)

/** Reads a journey file loosely: bad edges/steps are dropped; only an unusable file is refused (returns why). */
export function parseJourney(raw: string, name: string): Journey | string {
  let v: any
  try { v = JSON.parse(raw) } catch (e) { return `not valid JSON (${(e as Error).message})` }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'not a JSON object'
  if (!READ_VERSIONS.includes(v.version)) return `${OLD_FORMAT}${v.version ?? 1} (steps as notes): not read; migrate it to v${FORMAT_VERSION}`
  if (!Array.isArray(v.nodes) || !v.nodes.length) return '"nodes" must be a non-empty array'
  if (!Array.isArray(v.steps)) return '"steps" must be an array'
  const problems: string[] = []
  const keep = <T>(x: T | string): x is T => { if (typeof x === 'string') problems.push(x); return typeof x !== 'string' }
  const nodes: JNode[] = []
  const ids = new Set<string>()
  for (const x of v.nodes) { const n = readNode(x, ids); if (keep(n)) { ids.add(n.id); nodes.push(n) } }
  dropBadParents(nodes, problems)
  const edges = (Array.isArray(v.edges) ? v.edges : []).map((e: any) => readEdge(e, nodes)).filter(keep)
  const stepIds = new Set<string>()
  const steps = v.steps
    .filter((s: any, i: number) => {
      const why = stepProblem(s, ids)
      if (why) problems.push(`step ${i + 1}${s?.title ? ` ("${str(s.title)}")` : ''} ${why}: left out`)
      return !why
    })
    .map((s: any, i: number) => readStep(s, i + 1, stepIds, problems))
  const title = str(v.title) || str(v.question) || name
  return {
    id: str(v.id) || name, question: str(v.question) || title, title, summary: str(v.summary),
    ...optTrimmed('model', v.model),
    ...opt(typeof v.commit === 'string' && v.commit, 'commit', v.commit as string),
    ...opt(typeof v.createdAt === 'string', 'createdAt', v.createdAt as string),
    ...opt(v.start === true, 'start', true as const),
    nodes, edges, steps, problems: [...problems, ...rules(nodes)],
  }
}

export const MAX_BOXES = 7
export const MAX_NODE_LABEL = 30

/** The map's promises the journey must keep: short box labels, at most 7 boxes on a level. */
function rules(nodes: JNode[]): string[] {
  const out: string[] = []
  for (const n of nodes) {
    if (n.label.length > MAX_NODE_LABEL) out.push(`box "${n.label.slice(0, 24)}…": label longer than ${MAX_NODE_LABEL} characters`)
  }
  const count = new Map<string, number>()
  for (const n of nodes) count.set(n.parent ?? '', (count.get(n.parent ?? '') ?? 0) + 1)
  for (const [p, c] of count) {
    if (c <= MAX_BOXES) continue
    const level = p ? `inside "${nodes.find((n) => n.id === p)?.label ?? p}"` : 'the top level'
    out.push(`${level}: ${c} boxes (at most ${MAX_BOXES} keep the map readable)`)
  }
  return out
}

/** "calls", "calls per environment": say nothing a solid arrow doesn't; not drawn on the map. */
export const isGeneric = (label: string) => !label.trim() || /^calls?(\s|$)/i.test(label.trim())
