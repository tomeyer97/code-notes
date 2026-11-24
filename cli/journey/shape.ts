// The shapes every journey.py command relies on, checked once when a journey is read: what cannot be read (a
// PROBLEM each), and the hand-edits it can read anyway (an "at" written as "file:a-b", a range without an anchor),
// returned as upgrades for journey.py to apply. Nothing is changed here.
import { isInt, isObj, repr } from './py'

/** The kinds of box, in the order the messages list them. */
const KINDS = ['system', 'module', 'function', 'external', 'store']
const ANCHOR_TEXT = ['text', 'before', 'after', 'head', 'tail', 'hash']
const LISTS: [string, string[]][] = [['links', ['phrase', 'file', 'start', 'end']], ['values', ['name', 'value', 'file', 'line']]]

/** A hand-edit read anyway: the box's (or step's) anchor is made from `file` lines start-end. `at`: the box's "at"
 *  was this string, and becomes {file, start, end, anchor}. */
export interface Upgrade { node?: number; step?: number; file: string; start: number; end: number; at?: boolean; note: string }

export interface Shape { problems: string[]; upgrades: Upgrade[] }

const isStr = (v: unknown): v is string => typeof v === 'string'

function anchorOk(a: unknown): boolean {
  if (!isObj(a) || !ANCHOR_TEXT.every((k) => isStr(k in a ? a[k] : ''))) return false
  return a.v !== 3 || (isStr(a.head) && isInt(a.lines))
}

export function shapeProblems(j: Record<string, any>): Shape {
  const problems: string[] = []
  const upgrades: Upgrade[] = []
  for (const key of ['nodes', 'edges', 'steps']) if (!Array.isArray(j[key])) problems.push(`"${key}" must be a list`)
  if (!isStr(j.title)) problems.push('"title" must be a string (meta title "…")')
  for (const key of ['question', 'summary', 'commit']) if (key in j && !isStr(j[key])) problems.push(`"${key}" must be a string`)
  if (problems.length) return { problems, upgrades }
  j.nodes.forEach((n: unknown, i: number) => nodeShape(n, i, problems, upgrades))
  j.edges.forEach((e: unknown, i: number) => edgeShape(e, i, problems))
  j.steps.forEach((s: unknown, i: number) => stepShape(s, i + 1, problems, upgrades))
  return { problems, upgrades }
}

function nodeShape(n: unknown, i: number, problems: string[], upgrades: Upgrade[]) {
  if (!isObj(n) || !isStr(n.id) || !n.id) {
    problems.push(`nodes[${i}]: a box is an object with a string "id"`)
    return
  }
  const name = `box ${n.id}`
  if (!KINDS.includes(n.kind)) problems.push(`${name}: kind ${repr(n.kind)} is not one of ${KINDS.join(', ')}`)
  if (!isStr(n.label)) problems.push(`${name}: "label" must be a string`)
  for (const key of ['blurb', 'summary', 'path', 'parent']) if (key in n && !isStr(n[key])) problems.push(`${name}: "${key}" must be a string`)
  if (!('at' in n)) return
  const at = n.at
  if (isStr(at)) {
    const m = /^(.+):(\d+)(?:-(\d+))?$/.exec(at.trim())
    if (!m) {
      problems.push(`${name}: "at" is the string ${repr(at)}; it must be {file, start, end, anchor}: remove the line, then \`set ${n.id} at <file:start-end>\``)
      return
    }
    const [f, a, b] = [m[1], Number(m[2]), Number(m[3] ?? m[2])]
    upgrades.push({ node: i, file: f, start: a, end: b, at: true,
      note: `${name}: "at" was hand-written as the string "${at}"; it must be {file, start, end, anchor}: run \`set ${n.id} at ${f}:${a}-${b}\` (never edit the file by hand)` })
  } else if (!(isObj(at) && isStr(at.file) && isInt(at.start) && isInt(at.end))) {
    problems.push(`${name}: "at" must be {file, start, end, anchor} with whole line numbers: remove it, then \`set ${n.id} at <file:start-end>\``)
  } else if (!anchorOk(at.anchor)) {
    upgrades.push({ node: i, file: at.file, start: at.start, end: at.end,
      note: `${name}: "at" has no anchor (hand-written): run \`set ${n.id} at ${at.file}:${at.start}-${at.end}\`` })
  }
}

function edgeShape(e: unknown, i: number, problems: string[]) {
  if (!isObj(e) || !['from', 'to', 'label'].every((k) => isStr(e[k]))) {
    problems.push(`edges[${i}]: an edge is an object with string "from", "to" and "label" (rewrite it with \`edge\`)`)
  } else if ('detail' in e && !isStr(e.detail)) {
    problems.push(`edge ${e.from} -> ${e.to}: "detail" must be a string`)
  }
}

function stepShape(st: unknown, k: number, problems: string[], upgrades: Upgrade[]) {
  const name = `step ${k}`
  if (!isObj(st)) {
    problems.push(`${name}: a step is an object`)
    return
  }
  for (const key of ['title', 'node', 'file']) if (!isStr(st[key])) problems.push(`${name}: "${key}" must be a string`)
  for (const key of ['lead', 'details', 'id']) if (key in st && !isStr(st[key])) problems.push(`${name}: "${key}" must be a string`)
  const r = st.range
  if (isStr(r) || !(isObj(r) && isInt(r.start) && isInt(r.end))) {
    problems.push(`${name}: "range" must be {start, end} with whole line numbers (and "file" beside it): put the old value back, then \`restep ${k} range <file> <start> <end>\``)
  } else if (!anchorOk(st.anchor) && isStr(st.file)) {
    upgrades.push({ step: k - 1, file: st.file, start: r.start, end: r.end,
      note: `${name}: no anchor (hand-written range): run \`restep ${k} range ${st.file} ${r.start} ${r.end}\`` })
  }
  for (const [key, need] of LISTS) {
    const ok = (x: unknown) => isObj(x) && need.every((f) => (['start', 'end', 'line'].includes(f) ? isInt : isStr)(x[f]))
    if (key in st && !(Array.isArray(st[key]) && st[key].every(ok))) {
      problems.push(`${name}: "${key}" must be a list of {${need.join(', ')}, text} objects (rewrite them with \`${key.slice(0, -1)}\`, after removing the line)`)
    }
  }
  if ('scene' in st && !(isObj(st.scene) && Array.isArray(st.scene.actors) && Array.isArray(st.scene.beats))) {
    problems.push(`${name}: "scene" must be {actors, wires, beats} (remove it, then \`scene ${k}\` < the JSON)`)
  }
  if ('refs' in st && !(Array.isArray(st.refs) && st.refs.every(isStr))) {
    problems.push(`${name}: "refs" must be a list of strings, each one sentence with a path:line in it (restep ${k} refs "…")`)
  }
}
