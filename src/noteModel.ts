// A note file's content, without the vscode API (unit-tested in test/noteModel.test.ts): its fields, reading one
// (parseNote), writing one (serialize), and merging a change made on disk into ours (merge). Reading and writing the
// files themselves is store.ts. The README written for agents beside the notes is media/notes-README.md (agentReadme).
import * as fs from 'fs'
import * as path from 'path'
import { isAbsolutePath, slashPath } from './paths'

export type Role = 'human' | 'agent'
export interface Message { author: string; body: string; at?: string; role?: Role }
export const SEVERITIES = ['high', 'medium', 'low', 'nit'] as const
export type Severity = typeof SEVERITIES[number]
/** A status change: who resolved or reopened the note, and when (shown as a grey line in the thread). */
export interface NoteEvent { type: 'resolved' | 'reopened'; by: string; role?: Role; at: string }

export interface NoteData {
  id: string
  /** Path relative to the workspace folder, with forward slashes. */
  file: string
  /** 1-based, inclusive. */
  range: { start: number; end: number }
  anchor: { text: string; before: string; after: string; commit?: string; branch?: string }
  /** The exact text selected when the note was made, when that was part of a line (e.g. one token). */
  selection?: { text: string; startCol: number; endCol: number }
  /** A set of notes that belong together (one review, one topic). The sidebar groups by it; it can be hidden. */
  session?: string
  status: 'open' | 'resolved'
  stale?: boolean
  /** The Claude Code session that answered this note: follow-ups resume it. */
  claudeSession?: string
  createdAt?: string
  messages: Message[]
  /** Review findings: how much it matters (sidebar icon and order). */
  severity?: Severity
  /** Status changes, oldest first. */
  events?: NoteEvent[]
  /** A note on a whole file or folder: no lines (range is 1-1 in memory and not written). */
  target?: 'file' | 'folder'
  /** Fields of the file this version doesn't know (a newer extension or an agent wrote them): written back as they were. */
  extra?: Record<string, unknown>
}

/**
 * Every field of a note file this version knows, and what `merge` does with it when the file changed on disk while
 * we changed the note: `ours` (ours if we changed it, else theirs), `theirs` (never changed here after it is made),
 * `append` (both sides' new entries). Checked against NoteData: a field added there must be added here.
 */
const NOTE_FIELDS = {
  id: 'theirs',
  file: 'ours',
  range: 'ours',
  anchor: 'ours',
  selection: 'theirs',
  session: 'ours',
  status: 'ours',
  stale: 'ours',
  claudeSession: 'ours',
  createdAt: 'theirs',
  messages: 'append',
  severity: 'ours',
  events: 'append',
  target: 'ours',
} as const satisfies Record<Exclude<keyof NoteData, 'extra'>, 'ours' | 'theirs' | 'append'>

/** Fields this version knows: everything else in a note file is kept as is when the extension rewrites it. */
const KNOWN = new Set<string>(Object.keys(NOTE_FIELDS))
const OURS_IF_CHANGED = (Object.keys(NOTE_FIELDS) as (keyof typeof NOTE_FIELDS)[]).filter((k) => NOTE_FIELDS[k] === 'ours')

const msgKey = (m: Message) => `${m.author}\u0000${m.at ?? ''}\u0000${m.body}`
const evKey = (e: NoteEvent) => `${e.type}\u0000${e.by}\u0000${e.at}`
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
/** `theirs`, then the entries of `ours` neither `base` nor `theirs` has. */
const appendNew = <T>(base: T[], ours: T[], theirs: T[], key: (x: T) => string): T[] => {
  const known = new Set([...base, ...theirs].map(key))
  return [...theirs, ...ours.filter((x) => !known.has(key(x)))]
}

/**
 * Three-way merge of a note that changed on disk (an agent wrote it) while we changed it in memory. Messages and
 * events are append-only: theirs plus our new ones. Every other field: as NOTE_FIELDS says.
 */
export function merge(base: NoteData, ours: NoteData, theirs: NoteData): NoteData {
  const out: NoteData = { ...theirs, messages: appendNew(base.messages, ours.messages, theirs.messages, msgKey) }
  const o = out as unknown as Record<string, unknown>
  for (const k of OURS_IF_CHANGED) o[k] = same(ours[k], base[k]) ? theirs[k] : ours[k]
  const events = appendNew(base.events ?? [], ours.events ?? [], theirs.events ?? [], evKey)
  if (events.length) out.events = events; else delete out.events
  for (const k of ['severity', 'target'] as const) if (out[k] === undefined) delete out[k]
  return out
}

/** Lines of context kept around a note's lines in its anchor (before and after). */
const ANCHOR_CONTEXT_LINES = 2

/** A note's anchor on lines start..end (0-based, inclusive): their text, two lines before and two after. */
export function captureAnchor(lines: string[], start: number, end: number): NoteData['anchor'] {
  return {
    text: lines.slice(start, end + 1).join('\n'),
    before: lines.slice(Math.max(0, start - ANCHOR_CONTEXT_LINES), start).join('\n'),
    after: lines.slice(end + 1, end + 1 + ANCHOR_CONTEXT_LINES).join('\n'),
  }
}

/** Why a notes folder setting can't be used (C116), or undefined. Stricter than a note's "file" (paths.ts placeFile):
 *  no `..` at all, even one that stays inside. */
export function folderProblem(v: string): string | undefined {
  const t = slashPath(v.trim())
  if (!t || t === '.' || t === './') return 'it must be a sub-folder of its own, like .code-notes'
  if (isAbsolutePath(t)) return 'it must be relative to the workspace folder'
  if (t.split('/').includes('..')) return 'it must stay inside the workspace folder'
  return undefined
}

/** The first message of a note file that can't be used, to name it in the list. */
export function titleOf(raw: string): string | undefined {
  try { const b = JSON.parse(raw)?.messages?.[0]?.body; return typeof b === 'string' && b.trim() ? b : undefined } catch { return undefined }
}

export function serialize(d: NoteData): string {
  const { extra, ...rest } = d
  const out: Record<string, unknown> = { ...rest }
  // A file or folder note has no lines: no range or anchor in its file.
  if (d.target) for (const k of ['range', 'anchor', 'stale', 'selection']) delete out[k]
  return JSON.stringify({ ...out, ...extra }, null, 2) + '\n'
}

/** `{ [k]: v }` when `keep`, else nothing: spread into an object for an optional field. The same as journeyModel.ts
 *  `opt` (keep the two in sync): that file has no imports, the map webview loads it as a plain script. */
const opt = <K extends string, V>(keep: unknown, k: K, v: V) => (keep ? { [k]: v } as { [P in K]: V } : {})
/** `{ [k]: v }` when `v` is a string (`nonEmpty`: with something in it), as it is: a note file's strings are not
 *  trimmed. (journeyModel.ts `optTrimmed` trims and drops empty strings.) */
const optString = <K extends string>(k: K, v: unknown, nonEmpty = false) => opt(typeof v === 'string' && (!nonEmpty || v), k, v as string)

/** Why a parsed note file is not a note, or undefined. Lines are checked after a file/folder note got its 1-1 range. */
function noteProblem(v: any): string | undefined {
  if (!v || typeof v !== 'object') return 'not a JSON object'
  if (typeof v.file !== 'string' || !v.file) return 'missing "file"'
  if (v.target !== undefined && v.target !== 'file' && v.target !== 'folder') {
    return `"target" is "${v.target}": use "file" or "folder" (or leave it out for lines)`
  }
  const r = v.target ? { start: 1, end: 1 } : v.range
  if (!r || !Number.isInteger(r.start) || !Number.isInteger(r.end)) {
    return '"range" needs integer start and end (or "target": "file" for a whole file)'
  }
  if (r.start < 1) return `"range.start" is ${r.start}: lines are 1-based`
  if (r.end < r.start) return `"range" ends (${r.end}) before it starts (${r.start})`
  if (v.status !== undefined && v.status !== 'open' && v.status !== 'resolved') {
    return `"status" is "${v.status}": use "open" or "resolved"`
  }
  if (!Array.isArray(v.messages)) return '"messages" must be an array'
  if (!v.messages.length) return '"messages" is empty: a note needs at least one message'
  for (const [i, m] of v.messages.entries()) {
    if (!m || typeof m.body !== 'string') return `message ${i + 1} needs a "body" string`
  }
  return undefined
}

const readRole = (r: unknown) => opt(r === 'human' || r === 'agent', 'role', r as Role)

function readAnchor(a: any): NoteData['anchor'] {
  return {
    text: String(a?.text ?? ''), before: String(a?.before ?? ''), after: String(a?.after ?? ''),
    ...optString('commit', a?.commit), ...optString('branch', a?.branch),
  }
}

/** A plain string (the obvious shorthand) is the text; columns are only informational. */
function readSelection(s: any): Pick<NoteData, 'selection'> {
  if (typeof s === 'string' && s.trim()) return { selection: { text: s, startCol: 0, endCol: 0 } }
  if (s && typeof s.text === 'string') return { selection: { text: s.text, startCol: Number(s.startCol) || 0, endCol: Number(s.endCol) || 0 } }
  return {}
}

/** A missing "at" stays missing: unread state does not depend on it, and inventing one would be a lie. */
const readMessage = (m: any): Message => ({ author: String(m.author ?? 'unknown'), ...readRole(m.role), body: m.body, ...optString('at', m.at) })

function readEvents(v: unknown): NoteEvent[] {
  return (Array.isArray(v) ? v : [])
    .filter((e: any) => e && (e.type === 'resolved' || e.type === 'reopened') && typeof e.at === 'string')
    .map((e: any) => ({ type: e.type, by: String(e.by ?? 'unknown'), ...readRole(e.role), at: e.at }))
}

/** Checks a note file's content; returns the note or why it is not one. `id` is the file's name. */
export function parseNote(raw: string, id: string): NoteData | string {
  let v: any
  try { v = JSON.parse(raw) } catch (e) { return `not valid JSON (${(e as Error).message})` }
  const why = noteProblem(v)
  if (why) return why
  const target: 'file' | 'folder' | undefined = v.target
  const range = target ? { start: 1, end: 1 } : v.range
  const start = Math.max(1, range.start)
  // An unknown severity ("critical") is not an error: it is kept in the file but shown as none.
  const severity = SEVERITIES.includes(v.severity) ? v.severity as Severity : undefined
  const extra = Object.fromEntries(Object.entries(v).filter(([k]) => !KNOWN.has(k) || (k === 'severity' && !severity)))
  const events = readEvents(v.events)
  const session = typeof v.session === 'string' ? v.session.trim() : ''
  return {
    id,
    file: v.file.replace(/\\/g, '/').replace(/^\.\//, ''),
    range: { start, end: Math.max(start, range.end) },
    anchor: readAnchor(v.anchor),
    ...opt(session, 'session', session),
    ...optString('claudeSession', v.claudeSession, true),
    ...readSelection(v.selection),
    status: v.status === 'resolved' ? 'resolved' : 'open',
    stale: !target && !!v.stale,
    ...optString('createdAt', v.createdAt),
    messages: v.messages.map(readMessage),
    ...opt(severity, 'severity', severity!),
    ...opt(events.length, 'events', events),
    ...opt(target, 'target', target!),
    ...opt(Object.keys(extra).length, 'extra', extra),
  }
}

/** media/notes-README.md: the README with `${person}` and `${folder}` where agentReadme puts them. */
const README_TEMPLATE = path.join(__dirname, '..', '..', 'media', 'notes-README.md')
let readme: string | undefined

/** The README the extension writes into the notes folder (named `folder`): the note format, for agents, naming `person`. */
export function agentReadme(person: string, folder: string): string {
  readme ??= fs.readFileSync(README_TEMPLATE, 'utf8')
  return readme.replace(/\$\{(person|folder)\}/g, (_m, k: string) => (k === 'person' ? person : folder))
}
