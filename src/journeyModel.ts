// A code journey (format v2: docs/journey-format.md): a nested map (systems ⊃ modules ⊃ functions) plus an ordered path of steps, embedded
// in the journey file. A step is NOT a note: it is read-only explanation, never unread, never counted.
// Pure (no imports): the extension uses it, and the map webview loads the compiled file as is.

/** `store`: the app's own record/queue/table two parts of the path meet through: dashed on the map, never "external". */
export type Kind = 'system' | 'module' | 'external' | 'store' | 'function'
/** `blurb`: the short text shown in the box (the summary is then its tooltip); `path`: where it lives (tooltip, small text). */
/** `lane`: still read, but the whole-journey map (0.21, ELK) lays boxes out itself and ignores it. */
export interface JNode { id: string; kind: Kind; label: string; summary: string; blurb?: string; path?: string; parent?: string; lane?: 'main' | 'side'; at?: { file: string; start: number; end: number; anchor?: JAnchor } }
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
  links?: { phrase: string; file: string; start: number; end: number; text: string }[]
  /** Value hints (valueHints.ts): what a variable holds in the example run, shown faintly above its line while the step is open. */
  values?: { name: string; value: string; note?: string; file: string; line: number; text: string }[]
}
/** `code`: the line that does what the beat shows; `example`: an example of the value in play there (written by the author, not captured). */
export interface JBeat { focus: string; caption: string; muted?: string; code?: { file: string; line: number; text: string }; [k: string]: unknown }
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

const KINDS: Kind[] = ['system', 'module', 'external', 'store', 'function']
const str = (v: unknown) => (typeof v === 'string' ? v : '')
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

/** Reads a journey file loosely: bad edges/steps are dropped; only an unusable file is refused (returns why). */
export function parseJourney(raw: string, name: string): Journey | string {
  let v: any
  try { v = JSON.parse(raw) } catch (e) { return `not valid JSON (${(e as Error).message})` }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'not a JSON object'
  if (!READ_VERSIONS.includes(v.version)) return `format v${v.version ?? 1} (steps as notes): not read; migrate it to v${FORMAT_VERSION}`
  if (!Array.isArray(v.nodes) || !v.nodes.length) return '"nodes" must be a non-empty array'
  if (!Array.isArray(v.steps)) return '"steps" must be an array'
  const problems: string[] = []
  const nodes: JNode[] = []
  const ids = new Set<string>()
  for (const n of v.nodes) {
    if (!n || typeof n.id !== 'string' || !n.id) { problems.push('a node without an id was left out'); continue }
    if (ids.has(n.id)) { problems.push(`node "${n.id}" is defined twice (the second one was left out)`); continue }
    ids.add(n.id)
    const at = n.at && typeof n.at.file === 'string' && Number.isInteger(n.at.start)
      ? { file: n.at.file, start: n.at.start, end: Number.isInteger(n.at.end) ? n.at.end : n.at.start, ...(readAnchor(n.at.anchor) ? { anchor: readAnchor(n.at.anchor) } : {}) } : undefined
    nodes.push({
      id: n.id, kind: KINDS.includes(n.kind) ? n.kind : 'module', label: str(n.label) || n.id, summary: str(n.summary),
      ...(str(n.blurb).trim() ? { blurb: str(n.blurb).trim() } : {}), ...(str(n.path).trim() ? { path: str(n.path).trim() } : {}),
      ...(typeof n.parent === 'string' && n.parent ? { parent: n.parent } : {}), ...(n.lane === 'main' || n.lane === 'side' ? { lane: n.lane } : {}), ...(at ? { at } : {}),
    })
  }
  // A parent that doesn't exist, or a loop of parents: the node goes to the top level.
  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (const n of nodes) {
    const seen = new Set<string>([n.id])
    for (let p = n.parent; p; p = byId.get(p)?.parent) {
      if (!byId.has(p) || seen.has(p)) { problems.push(`node "${n.id}": parent "${p}" ${byId.has(p) ? 'makes a loop' : 'doesn\'t exist'}`); delete n.parent; break }
      seen.add(p)
    }
  }
  const rawEdges = Array.isArray(v.edges) ? v.edges : []
  const edges: JEdge[] = rawEdges
    .filter((e: any) => {
      const ok = e && ids.has(e.from) && ids.has(e.to) && e.from !== e.to
      const lbl = (id: unknown) => (ids.has(id as string) ? `"${nodes.find((n) => n.id === id)!.label}"` : `a box that doesn't exist ("${id ?? '?'}")`)
      if (!ok) problems.push(e && e.from === e.to ? `an arrow from ${lbl(e.from)} to itself is hidden` : `an arrow from ${lbl(e?.from)} to ${lbl(e?.to)} is hidden`)
      return ok
    })
    .map((e: any) => ({ from: e.from, to: e.to, label: str(e.label), ...(str(e.detail).trim() ? { detail: str(e.detail).trim() } : {}), ...(e.async ? { async: true } : {}) }))
  const line = (x: unknown) => (Number.isInteger(x) && (x as number) >= 1 ? (x as number) : undefined)
  const stepIds = new Set<string>()
  const steps: JStep[] = v.steps
    .filter((s: any, i: number) => {
      const why = !s ? 'is empty' : !ids.has(s.node) ? `is in an unknown box "${s.node}"` : !str(s.file).trim() ? 'has no file' : !(s.range && line(s.range.start)) ? 'has no line range' : ''
      if (why) problems.push(`step ${i + 1}${s?.title ? ` ("${str(s.title)}")` : ''} ${why}: left out`)
      return !why
    })
    .map((s: any, i: number) => {
      const start = line(s.range.start)!
      const end = Math.max(start, line(s.range.end) ?? start)
      const a = readAnchor(s.anchor)
      const refs = (Array.isArray(s.refs) ? s.refs : []).filter((r: unknown) => typeof r === 'string' && r.trim()).map((r: string) => r.trim())
      if (refs.length > MAX_REFS) problems.push(`step ${i + 1}: ${refs.length} references (at most ${MAX_REFS} are shown)`)
      let id = str(s.id).trim() || `#${i + 1}`
      if (stepIds.has(id)) { problems.push(`step ${i + 1}: id "${id}" is used twice`); id = `#${i + 1}` }
      stepIds.add(id)
      return {
        id, n: i + 1, title: str(s.title).trim() || `Step ${i + 1}`, node: s.node, file: str(s.file).trim(), range: { start, end },
        ...(a ? { anchor: a } : {}), lead: str(s.lead).trim(), ...(str(s.details).trim() ? { details: str(s.details).trim() } : {}), refs: refs.slice(0, MAX_REFS),
        ...(Array.isArray(s.links) && s.links.length ? { links: s.links } : {}),
        ...(Array.isArray(s.values) && s.values.length ? { values: s.values } : {}),
        ...(s.scene && Array.isArray(s.scene.beats) && Array.isArray(s.scene.actors) && s.scene.beats.length ? { scene: s.scene as JScene } : {}),
      }
    })
  const title = str(v.title) || str(v.question) || name
  return {
    id: str(v.id) || name, question: str(v.question) || title, title, summary: str(v.summary),
    ...(str(v.model).trim() ? { model: str(v.model).trim() } : {}),
    ...(typeof v.commit === 'string' && v.commit ? { commit: v.commit } : {}),
    ...(typeof v.createdAt === 'string' ? { createdAt: v.createdAt } : {}),
    ...(v.start === true ? { start: true } : {}),
    nodes, edges, steps, problems: [...problems, ...rules(nodes)],
  }
}

export const MAX_BOXES = 7
export const MAX_NODE_LABEL = 30

/** The map's promises the journey must keep: short box labels, at most 7 boxes on a level. */
function rules(nodes: JNode[]): string[] {
  const out: string[] = []
  for (const n of nodes) if (n.label.length > MAX_NODE_LABEL) out.push(`box "${n.label.slice(0, 24)}…": label longer than ${MAX_NODE_LABEL} characters`)
  const count = new Map<string, number>()
  for (const n of nodes) count.set(n.parent ?? '', (count.get(n.parent ?? '') ?? 0) + 1)
  for (const [p, c] of count) if (c > MAX_BOXES) out.push(`${p ? `inside "${nodes.find((n) => n.id === p)?.label ?? p}"` : 'the top level'}: ${c} boxes (at most ${MAX_BOXES} keep the map readable)`)
  return out
}

/** "calls", "calls per environment": say nothing a solid arrow doesn't; not drawn on the map. */
export const isGeneric = (label: string) => !label.trim() || /^calls?(\s|$)/i.test(label.trim())

/**
 * Every `path/to/file.ext:line` (also `:a-b` and `#Ln`) in step text, in or out of backticks and parentheses, but
 * not one that already is a markdown link's text or target.
 */
export const REF_IN_TEXT = /(?<![\w/[])(?<!\]\()`?((?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z]{1,6})(?::(\d+)(?:[-–]\d+)?|#L(\d+))`?/g
/** Replaces each reference in `t` with what `link` makes of it (its text without backticks, the file, the first line). */
export function linkPaths(t: string, link: (text: string, file: string, line: number) => string): string {
  return t.replace(REF_IN_TEXT, (m: string, file: string, l1?: string, l2?: string) => link(m.replace(/`/g, ''), file, Number(l1 ?? l2) || 1))
}

/** Step numbers as short text: 1, 3–7, 10. */
export function stepRanges(ns: number[]): string {
  const out: string[] = []
  for (let i = 0; i < ns.length; i++) {
    let k = i
    while (k + 1 < ns.length && ns[k + 1] === ns[k] + 1) k++
    out.push(k > i + 1 ? `${ns[i]}–${ns[k]}` : k === i + 1 ? `${ns[i]}, ${ns[k]}` : `${ns[i]}`)
    i = k
  }
  return out.join(', ')
}

/**
 * Markdown for VS Code's renderer (no HTML allowed): `<name>`, `<id>` outside code is text, not a tag that the sanitizer
 * swallows. Code spans and fenced blocks are left as they are; `<` and `>` elsewhere get a backslash.
 */
export function escapeTags(md: string): string {
  return md.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, i) => (i % 2 ? part : part.replace(/\\?([<>])/g, '\\$1'))).join('')
}
