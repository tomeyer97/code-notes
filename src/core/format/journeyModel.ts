// A code journey (docs/journey-format.md; schema/journey.schema.json): a nested map (systems ⊃ modules ⊃ functions)
// plus an ordered path of steps, embedded in the journey file. A step is NOT a note: it is read-only explanation,
// never unread, never counted. The one reader of the file: the extension, the map page (through the extension) and
// the understanding CLI (a check's tour) all read it here. How step text is written out (paths in it, markdown) is
// journeys/textFormat.ts.
import type { Anchor } from '../anchors/kinds'
import { readAnchor } from '../anchors/kinds'
import type { CodeMark } from './marks'
import { accepted, parseJson, Parsed, refused } from './result'
import { isObj, line, opt, optTrimmed, str } from './read'
import { VERSIONS } from './versions'

export { readAnchor } from '../anchors/kinds'

/** `store`: the app's own record/queue/table two parts of the path meet through: dashed on the map, never "external". */
export const KINDS = ['system', 'module', 'external', 'store', 'function'] as const
export type Kind = typeof KINDS[number]

/** A step's or a box's anchor: the full text, or compact (core/anchors/kinds.ts). */
export type JAnchor = Anchor

/** A box of the map. */
export interface JNode {
  id: string
  kind: Kind
  label: string
  summary: string
  /** The short text shown in the box (the summary is then its tooltip). */
  blurb?: string
  /** Where it lives (tooltip, small text). */
  path?: string
  parent?: string
  /** Still read, but the whole-journey map (ELK) lays boxes out itself and ignores it. */
  lane?: 'main' | 'side'
  at?: { file: string; start: number; end: number; anchor?: JAnchor }
}

/** An arrow of the map. */
export interface JEdge {
  from: string
  to: string
  /** What the map shows. */
  label: string
  /** The sentence (tooltip). */
  detail?: string
  async?: boolean
}

/** A code link (codeLinkText.ts): words of the step's lead or details, as written; `text`: the first of its lines
 *  (to find them again). */
export interface StepLink {
  phrase: string
  file: string
  start: number
  end: number
  text: string
}

/**
 * A value hint (valueHints.ts): `name`: the variable; `value`: what it holds, on one line; `text`: the line it is on
 * (to find it again); `note`: a few words on what the value is, after it on the same row.
 */
export interface ValueHint {
  name: string
  value: string
  note?: string
  file: string
  line: number
  text: string
}

// ---------- a step's animation (media/journey-scene.js draws it; the schema has every actor's fields) ----------

/** One of the scene's fixed library of actors; the fields after `type` depend on it (schema/journey.schema.json). */
export interface JActor {
  id: string
  type: string
  /** Column on the stage. */
  col?: number
  label?: string
  sub?: string
  [field: string]: unknown
}

/** A wire requests travel on: `[fromId, toId]`. */
export type JWire = [string, string]

/** A pill travelling a wire as the beat starts. */
export interface JPacket {
  from: string
  to: string
  label?: string
}

/** One beat of a scene. */
export interface JBeat {
  /** The actor the camera goes to (the rest dims). */
  focus: string
  caption: string
  muted?: string
  /** What changes, by actor id: a beat's state is every `set` up to it. */
  set?: Record<string, Record<string, unknown>>
  packet?: JPacket
  /** Where the beat clicks (the actor draws the pointer there). */
  click?: unknown
  /** The line that does what the beat shows (the extension lights it). */
  code?: { file: string; line: number; text: string }
  /** An example of the value in play there (written by the author, not captured). */
  example?: { label: string; value: string; lang?: string }
  /** As a step's marks, lit while the beat is (their file defaults to the beat's code file). */
  marks?: CodeMark[]
}

/** A step's animation, played beat by beat in place of the map. */
export interface JScene {
  actors: JActor[]
  wires?: JWire[]
  beats: JBeat[]
}

/** A step of the path. */
export interface JStep {
  /** Stable across edits of the journey; `#<n>` when the file has none (then position-based). */
  id: string
  /** Its position (1-based). */
  n: number
  title: string
  node: string
  file: string
  /** 1-based lines as written in the file (the extension relocates them in memory). */
  range: { start: number; end: number }
  anchor?: JAnchor
  /** The short explanation always shown. */
  lead: string
  /** Markdown behind "More". */
  details?: string
  /** Up to MAX_REFS `path:line`. */
  refs: string[]
  /** The step's animation. A scene is kept as written (the page draws what it can); readStep only checks it has
   *  actors and beats. */
  scene?: JScene
  /** Code links: phrases of the lead/details that link to the lines doing what they say. */
  links?: StepLink[]
  /** Value hints: what a variable holds in the example run, shown faintly above its line while the step is open. */
  values?: ValueHint[]
  /** The parts of its lines the step is about. Kept as written: marks.ts readMarks checks each one when the step is
   *  walked, and says what is wrong with the rest. */
  marks?: CodeMark[]
}

export interface Journey {
  id: string
  question: string
  title: string
  summary: string
  model?: string
  commit?: string
  createdAt?: string
  /** The journey to start with: marked "Start here" in the Journeys list. */
  start?: boolean
  nodes: JNode[]
  edges: JEdge[]
  steps: JStep[]
  /** What breaks the format's rules (dropped parts, long labels, crowded levels): shown on the map, not only logged. */
  problems: string[]
}

export const FORMAT_VERSION = VERSIONS.journey
export const MAX_REFS = 3
export const MAX_BOXES = 7
export const MAX_NODE_LABEL = 30
/** How much of a too-long label a problem quotes. */
const LABEL_PREVIEW = 24

/** What is wrong with a journey as it is read: `note` keeps the part (or fixes it), `leftOut` drops it. */
class Problems {
  readonly all: string[] = []
  /** Steps left out: the walk would miss them (a check's tour refuses them). */
  readonly stepsLeftOut: string[] = []
  note(text: string): void { this.all.push(text) }
  leftOut(text: string): void { this.all.push(text); this.stepsLeftOut.push(text) }
}

// ---------- boxes and arrows ----------

/** A node as written; why it is left out (no id, or one already used), as a string. */
function readNode(n: any, ids: Set<string>): JNode | string {
  if (!n || typeof n.id !== 'string' || !n.id) return 'a node without an id was left out'
  if (ids.has(n.id)) return `node "${n.id}" is defined twice (the second one was left out)`
  const at = readAt(n.at)
  return {
    id: n.id,
    kind: KINDS.includes(n.kind) ? n.kind : 'module',
    label: str(n.label) || n.id,
    summary: str(n.summary),
    ...optTrimmed('blurb', n.blurb),
    ...optTrimmed('path', n.path),
    ...opt(typeof n.parent === 'string' && n.parent, 'parent', n.parent as string),
    ...opt(n.lane === 'main' || n.lane === 'side', 'lane', n.lane as 'main' | 'side'),
    ...opt(at, 'at', at!),
  }
}

/** A box's `at` (the code it stands for), when it names a file and a first line. */
function readAt(at: any): JNode['at'] | undefined {
  if (!at || typeof at.file !== 'string' || !Number.isInteger(at.start)) return undefined
  const anchor = readAnchor(at.anchor)
  return { file: at.file, start: at.start, end: Number.isInteger(at.end) ? at.end : at.start, ...opt(anchor, 'anchor', anchor) }
}

/** A parent that doesn't exist, or a loop of parents: the node goes to the top level. */
function dropBadParents(nodes: JNode[], problems: Problems): void {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (const n of nodes) {
    const seen = new Set<string>([n.id])
    for (let p = n.parent; p; p = byId.get(p)?.parent) {
      if (!byId.has(p) || seen.has(p)) {
        problems.note(`node "${n.id}": parent "${p}" ${byId.has(p) ? 'makes a loop' : 'doesn\'t exist'}`)
        delete n.parent
        break
      }
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
  const exists = (id: unknown) => nodes.some((n) => n.id === id)
  if (e && e.from === e.to) return `an arrow from ${label(e.from)} to itself is hidden`
  if (!e || !exists(e.from) || !exists(e.to)) return `an arrow from ${label(e?.from)} to ${label(e?.to)} is hidden`
  return { from: e.from, to: e.to, label: str(e.label), ...optTrimmed('detail', e.detail), ...opt(e.async, 'async', true as const) }
}

// ---------- steps ----------

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
    phrase: l.phrase.trim(),
    file: l.file.trim(),
    start: l.start,
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
    name: x.name.trim(),
    value: oneLine(x.value),
    file: x.file.trim(),
    line: x.line,
    text: typeof x.text === 'string' ? x.text : '',
    ...(typeof x.note === 'string' && x.note.trim() ? { note: oneLine(x.note) } : {}),
  }))
}

/** A step's scene when it has actors and at least one beat (the page draws the rest as it can). */
const readScene = (v: any): JScene | undefined =>
  (isObj(v) && Array.isArray(v.beats) && Array.isArray(v.actors) && v.beats.length ? v as JScene : undefined)

/** Step `n` (1-based, after the steps left out) as written; `stepIds`: ids taken so far. */
function readStep(s: any, n: number, stepIds: Set<string>, problems: Problems): JStep {
  const start = line(s.range.start)!
  const end = Math.max(start, line(s.range.end) ?? start)
  const refs = (Array.isArray(s.refs) ? s.refs : []).filter((r: unknown) => typeof r === 'string' && r.trim()).map((r: string) => r.trim())
  if (refs.length > MAX_REFS) problems.note(`step ${n}: ${refs.length} references (at most ${MAX_REFS} are shown)`)
  let id = str(s.id).trim() || `#${n}`
  if (stepIds.has(id)) {
    problems.note(`step ${n}: id "${id}" is used twice`)
    id = `#${n}`
  }
  stepIds.add(id)
  const anchor = readAnchor(s.anchor)
  const links = readLinks(s.links)
  const values = readValues(s.values)
  const scene = readScene(s.scene)
  return {
    id,
    n,
    title: str(s.title).trim() || `Step ${n}`,
    node: s.node,
    file: str(s.file).trim(),
    range: { start, end },
    ...opt(anchor, 'anchor', anchor!),
    lead: str(s.lead).trim(),
    ...optTrimmed('details', s.details),
    refs: refs.slice(0, MAX_REFS),
    ...opt(links.length, 'links', links),
    ...opt(values.length, 'values', values),
    ...opt(s.marks !== undefined, 'marks', s.marks as CodeMark[]),
    ...opt(scene, 'scene', scene!),
  }
}

/** The steps that can be shown, numbered by position; each one left out is a problem. */
function readSteps(written: unknown[], ids: Set<string>, problems: Problems): JStep[] {
  const usable = written.filter((s: any, i) => {
    const why = stepProblem(s, ids)
    if (why) problems.leftOut(`step ${i + 1}${s?.title ? ` ("${str(s.title)}")` : ''} ${why}: left out`)
    return !why
  })
  const stepIds = new Set<string>()
  return usable.map((s, i) => readStep(s, i + 1, stepIds, problems))
}

// ---------- the file ----------

/** How parseJourney says a file is in an old format (v1: steps as notes): `format v1 (steps as notes): …`. */
const OLD_FORMAT = 'format v'
const OLD_FORMAT_REASON = /^format v\S+ \(steps as notes\)/
/** parseJourney refused the file (`why`) because it is in an old format: it is not broken, it needs migrating. A newer
 *  version's reason ("format v3 is newer …") is not one. */
export const isOldFormat = (why: string) => OLD_FORMAT_REASON.test(why)

/** Why a file of `version` is not read: an old format (missing or older: steps as notes; it needs migrating), or a
 *  newer one (a newer extension wrote it); undefined for the current version. */
function versionProblem(version: unknown): string | undefined {
  if (version === FORMAT_VERSION) return undefined
  if (typeof version === 'number' && version > FORMAT_VERSION) {
    return `format v${version} is newer than this extension reads (v${FORMAT_VERSION})`
  }
  return `${OLD_FORMAT}${version ?? 1} (steps as notes): not read; migrate it to v${FORMAT_VERSION}`
}

/** A journey read, with the steps it left out (a check's tour refuses those). */
export interface ReadJourney { journey: Journey; stepsLeftOut: string[] }

/** Reads a journey file loosely: bad edges/steps are dropped (each a problem); only an unusable file is refused. */
export function parseJourney(raw: string, name: string): Parsed<Journey> {
  const json = parseJson(raw)
  if (!json.ok) return json
  const r = readJourney(json.value, name)
  return r.ok ? accepted(r.value.journey) : r
}

/** parseJourney for a journey already parsed from JSON (a check file embeds its tour). */
export function readJourney(v: any, name: string): Parsed<ReadJourney> {
  if (!isObj(v)) return refused('not a JSON object')
  const why = versionProblem(v.version)
  if (why) return refused(why)
  if (!Array.isArray(v.nodes) || !v.nodes.length) return refused('"nodes" must be a non-empty array')
  if (!Array.isArray(v.steps)) return refused('"steps" must be an array')
  const problems = new Problems()
  const nodes = readNodes(v.nodes, problems)
  const ids = new Set(nodes.map((n) => n.id))
  const edges = (Array.isArray(v.edges) ? v.edges : []).map((e: unknown) => readEdge(e, nodes)).filter(collectProblem(problems))
  const steps = readSteps(v.steps, ids, problems)
  const title = str(v.title) || str(v.question) || name
  const journey: Journey = {
    id: str(v.id) || name,
    question: str(v.question) || title,
    title,
    summary: str(v.summary),
    ...optTrimmed('model', v.model),
    ...opt(typeof v.commit === 'string' && v.commit, 'commit', v.commit as string),
    ...opt(typeof v.createdAt === 'string', 'createdAt', v.createdAt as string),
    ...opt(v.start === true, 'start', true as const),
    nodes,
    edges,
    steps,
    problems: [...problems.all, ...rules(nodes)],
  }
  return accepted({ journey, stepsLeftOut: problems.stepsLeftOut })
}

/** A filter that keeps the parts read and records why each other one was left out. */
const collectProblem = (problems: Problems) => <T>(x: T | string): x is T => {
  if (typeof x !== 'string') return true
  problems.note(x)
  return false
}

/** The boxes as written: the ones with a new id; then each bad parent dropped. */
function readNodes(written: unknown[], problems: Problems): JNode[] {
  const nodes: JNode[] = []
  const ids = new Set<string>()
  for (const x of written) {
    const n = readNode(x, ids)
    if (!collectProblem(problems)(n)) continue
    ids.add(n.id)
    nodes.push(n)
  }
  dropBadParents(nodes, problems)
  return nodes
}

/** The map's promises the journey must keep: short box labels, at most MAX_BOXES boxes on a level. */
function rules(nodes: JNode[]): string[] {
  const out: string[] = []
  for (const n of nodes) {
    if (n.label.length > MAX_NODE_LABEL) out.push(`box "${n.label.slice(0, LABEL_PREVIEW)}…": label longer than ${MAX_NODE_LABEL} characters`)
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
