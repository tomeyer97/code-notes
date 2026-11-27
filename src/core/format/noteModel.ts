// A note file's content (schema/note.schema.json), without the vscode API (unit-tested in test/noteModel.test.ts): its
// fields, reading one (parseNote), writing one (serialize), and merging a change made on disk into ours (merge).
// Reading and writing the files themselves, and the README written for agents beside them, is notes/store.ts.
import type { FullAnchor } from '../anchors/kinds'
import { isAbsolutePath, slashPath } from '../paths'
import { opt, optString } from './read'
import { accepted, parseJson, Parsed, refused } from './result'
import { VERSIONS } from './versions'

export type Role = 'human' | 'agent'
export interface Message { author: string; body: string; at?: string; role?: Role }
export const SEVERITIES = ['high', 'medium', 'low', 'nit'] as const
export type Severity = typeof SEVERITIES[number]
/** A status change: who resolved or reopened the note, and when (shown as a grey line in the thread). */
export interface NoteEvent { type: 'resolved' | 'reopened'; by: string; role?: Role; at: string }

/** A note's anchor: the full text it was written on (core/anchors/anchor.ts follows it), and where it was written. */
export interface NoteAnchor extends FullAnchor { commit?: string; branch?: string }

/** The file's own field, not part of a note in memory: `version` (VERSIONS.md). Files without it are version 1. */
const FILE_FIELDS = ['version']

export interface NoteData {
  id: string
  /** Path relative to the workspace folder, with forward slashes. */
  file: string
  /** 1-based, inclusive. */
  range: { start: number; end: number }
  anchor: NoteAnchor
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
 * Every field of a note file this version knows: what `merge` does with it when the file changed on disk while we
 * changed the note (`ours`: ours if we changed it, else theirs; `theirs`: never changed here after it is made;
 * `append`: both sides' new entries), whether it is left out of the file when it is unset (`optional`), and whether it
 * is about lines (`lines`: not written for a note on a whole file or folder). Checked against NoteData: a field added
 * there must be added here.
 */
type FieldRule = { merge: 'ours' | 'theirs' | 'append'; optional?: true; lines?: true }
const NOTE_FIELDS = {
  id: { merge: 'theirs' },
  file: { merge: 'ours' },
  range: { merge: 'ours', lines: true },
  anchor: { merge: 'ours', lines: true },
  selection: { merge: 'theirs', lines: true },
  session: { merge: 'ours' },
  status: { merge: 'ours' },
  stale: { merge: 'ours', lines: true },
  claudeSession: { merge: 'ours' },
  createdAt: { merge: 'theirs' },
  messages: { merge: 'append' },
  severity: { merge: 'ours', optional: true },
  events: { merge: 'append' },
  target: { merge: 'ours', optional: true },
} as const satisfies Record<Exclude<keyof NoteData, 'extra'>, FieldRule>

type Field = keyof typeof NOTE_FIELDS
const fieldsWhere = (rule: (r: FieldRule) => boolean) => (Object.keys(NOTE_FIELDS) as Field[]).filter((k) => rule(NOTE_FIELDS[k]))

/** Fields this version knows: everything else in a note file is kept as is when the extension rewrites it. */
const KNOWN = new Set<string>([...FILE_FIELDS, ...Object.keys(NOTE_FIELDS)])
const OURS_IF_CHANGED = fieldsWhere((r) => r.merge === 'ours')
/** Left out of the file when unset (after a merge too). */
const OPTIONAL = fieldsWhere((r) => r.optional === true)
/** About lines: a note on a whole file or folder has none of them in its file. */
const LINE_FIELDS = fieldsWhere((r) => r.lines === true)

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
  for (const k of OPTIONAL) if (out[k] === undefined) delete out[k]
  return out
}

/** Lines of context kept around a note's lines in its anchor (before and after). */
const ANCHOR_CONTEXT_LINES = 2

/** A note's anchor on lines start..end (0-based, inclusive): their text, two lines before and two after. */
export function captureAnchor(lines: string[], start: number, end: number): NoteAnchor {
  return {
    text: lines.slice(start, end + 1).join('\n'),
    before: lines.slice(Math.max(0, start - ANCHOR_CONTEXT_LINES), start).join('\n'),
    after: lines.slice(end + 1, end + 1 + ANCHOR_CONTEXT_LINES).join('\n'),
  }
}

/** Why a notes folder setting can't be used, or undefined. Stricter than a note's "file" (paths.ts placeFile):
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

/** A note's file: its version first, then its fields in order, then the fields this version doesn't know. */
export function serialize(d: NoteData): string {
  const { extra, ...rest } = d
  const out: Record<string, unknown> = { version: VERSIONS.note, ...rest }
  // A file or folder note has no lines: no range or anchor in its file.
  if (d.target) for (const k of LINE_FIELDS) delete out[k]
  return JSON.stringify({ ...out, ...extra }, null, 2) + '\n'
}

/** The lines a note is on as written: a file or folder note has none, and is on 1-1 in memory. */
const rangeOf = (v: any) => (v.target ? { start: 1, end: 1 } : v.range)

/** Why a parsed note file is not a note, or undefined. Lines are checked after a file/folder note got its 1-1 range. */
function noteProblem(v: any): string | undefined {
  if (!v || typeof v !== 'object') return 'not a JSON object'
  if (v.version !== undefined && v.version !== VERSIONS.note) {
    return `"version" is ${JSON.stringify(v.version)}: this extension reads note files of version ${VERSIONS.note}`
  }
  if (typeof v.file !== 'string' || !v.file) return 'missing "file"'
  if (v.target !== undefined && v.target !== 'file' && v.target !== 'folder') {
    return `"target" is "${v.target}": use "file" or "folder" (or leave it out for lines)`
  }
  const r = rangeOf(v)
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

function readNoteAnchor(a: any): NoteAnchor {
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
export function parseNote(raw: string, id: string): Parsed<NoteData> {
  const json = parseJson(raw)
  if (!json.ok) return json
  const v: any = json.value
  const why = noteProblem(v)
  if (why) return refused(why)
  const target: 'file' | 'folder' | undefined = v.target
  const range = rangeOf(v)
  const start = Math.max(1, range.start)
  // An unknown severity ("critical") is not an error: it is kept in the file but shown as none.
  const severity = SEVERITIES.includes(v.severity) ? v.severity as Severity : undefined
  const extra = Object.fromEntries(Object.entries(v).filter(([k]) => !KNOWN.has(k) || (k === 'severity' && !severity)))
  const events = readEvents(v.events)
  const session = typeof v.session === 'string' ? v.session.trim() : ''
  return accepted({
    id,
    file: v.file.replace(/\\/g, '/').replace(/^\.\//, ''),
    range: { start, end: Math.max(start, range.end) },
    anchor: readNoteAnchor(v.anchor),
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
  })
}

/** The keys a README template (media/notes-README.template.md) fills as `${key}`, and the comment at its top that
 *  says so (not written out). */
const README_KEYS = /\$\{(person|folder)\}/g
const TEMPLATE_COMMENT = /^<!--[\s\S]*?-->\n/

/** The README the extension writes into the notes folder (named `folder`): the note format, for agents, naming
 *  `person`. `template`: media/notes-README.template.md. */
export function fillReadme(template: string, person: string, folder: string): string {
  return template.replace(TEMPLATE_COMMENT, '').replace(README_KEYS, (_m, k: string) => (k === 'person' ? person : folder))
}
