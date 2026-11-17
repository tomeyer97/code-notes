// Builders for the files the integration tests write: journeys (format v2) and notes. Each takes the fields its test
// is about and fills in the rest, so a call shows only what matters (the defaults-plus-overrides style of
// test/checkModel.test.ts).
import * as fs from 'fs'
import * as path from 'path'

export interface StepFixture {
  id: string
  title: string
  node: string
  file: string
  range: { start: number; end: number }
  lead: string
  refs: string[]
  [more: string]: unknown
}

/** A journey step on `file` lines `start`-`end`: id `<file's name>-<start>`, title "Line <start>", lead "Here.". */
export function step(file: string, start: number, end = start, over: Partial<StepFixture> = {}): StepFixture {
  return { id: `${path.basename(file).replace(/\W/g, '')}-${start}`, title: `Line ${start}`, node: 'f', file, range: { start, end }, lead: 'Here.', refs: [], ...over }
}

export interface NodeFixture { id: string; kind: string; label: string; summary?: string; parent?: string; [more: string]: unknown }

/** A function box per node the steps name (labelled by its id), unless `nodes` says otherwise. */
const nodesOf = (steps: StepFixture[]): NodeFixture[] => [...new Set(steps.map((s) => s.node))].map((id) => ({ id, kind: 'function', label: id }))

/** A journey file's content: version 2, `id`, the steps; question, title and summary made up unless given. */
export function journey(id: string, steps: StepFixture[], over: { question?: string; title?: string; summary?: string; nodes?: NodeFixture[]; edges?: object[]; [more: string]: unknown } = {}) {
  return { version: 2, id, question: `How does ${id} work?`, title: id, summary: '', nodes: nodesOf(steps), edges: [], ...over, steps }
}

/** Writes a journey to `<dir>/<id>.json` (or `name`.json); returns the path. */
export function writeJourney(dir: string, j: { id: string }, name = j.id): string {
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, `${name}.json`)
  fs.writeFileSync(p, JSON.stringify(j, null, 2))
  return p
}

/** A note file's content: open, on `file` line `line`, one agent message `body`. */
export function agentNote(file: string, line: number | undefined, body: string, over: object = {}) {
  return { file, ...(line === undefined ? {} : { range: { start: line, end: line } }), status: 'open', messages: [{ author: 'claude', role: 'agent', body }], ...over }
}

/** Writes a note to `<notesDir>/<id>.json`; returns the path. */
export function writeNote(notesDir: string, id: string, note: object): string {
  const p = path.join(notesDir, `${id}.json`)
  fs.writeFileSync(p, JSON.stringify(note, null, 2))
  return p
}

/** A source file of `lines` (a trailing newline added). */
export function writeLines(file: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, lines.join('\n') + '\n')
}
