// A note file's content, without the vscode API (unit-tested in test/noteModel.test.ts): its fields, reading one
// (parseNote), writing one (serialize), and merging a change made on disk into ours (merge). Reading and writing the
// files themselves is store.ts.
import { isAbsolutePath } from './paths'

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
  const t = v.trim().replace(/\\/g, '/').replace(/\/+$/, '')
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

/** `{ [k]: v }` when `keep`, else nothing: spread into an object for an optional field. */
const opt = <K extends string, V>(keep: unknown, k: K, v: V) => (keep ? { [k]: v } as { [P in K]: V } : {})
/** `{ [k]: v }` when `v` is a string (`nonEmpty`: with something in it), else nothing. */
const optStr = <K extends string>(k: K, v: unknown, nonEmpty = false) => opt(typeof v === 'string' && (!nonEmpty || v), k, v as string)

/** Why a parsed note file is not a note, or undefined. Lines are checked after a file/folder note got its 1-1 range. */
function noteProblem(v: any): string | undefined {
  if (!v || typeof v !== 'object') return 'not a JSON object'
  if (typeof v.file !== 'string' || !v.file) return 'missing "file"'
  if (v.target !== undefined && v.target !== 'file' && v.target !== 'folder') return `"target" is "${v.target}": use "file" or "folder" (or leave it out for lines)`
  const r = v.target ? { start: 1, end: 1 } : v.range
  if (!r || !Number.isInteger(r.start) || !Number.isInteger(r.end)) return '"range" needs integer start and end (or "target": "file" for a whole file)'
  if (r.start < 1) return `"range.start" is ${r.start}: lines are 1-based`
  if (r.end < r.start) return `"range" ends (${r.end}) before it starts (${r.start})`
  if (v.status !== undefined && v.status !== 'open' && v.status !== 'resolved') return `"status" is "${v.status}": use "open" or "resolved"`
  if (!Array.isArray(v.messages)) return '"messages" must be an array'
  if (!v.messages.length) return '"messages" is empty: a note needs at least one message'
  for (const [i, m] of v.messages.entries()) if (!m || typeof m.body !== 'string') return `message ${i + 1} needs a "body" string`
  return undefined
}

const readRole = (r: unknown) => opt(r === 'human' || r === 'agent', 'role', r as Role)

function readAnchor(a: any): NoteData['anchor'] {
  return {
    text: String(a?.text ?? ''), before: String(a?.before ?? ''), after: String(a?.after ?? ''),
    ...optStr('commit', a?.commit), ...optStr('branch', a?.branch),
  }
}

/** A plain string (the obvious shorthand) is the text; columns are only informational. */
function readSelection(s: any): Pick<NoteData, 'selection'> {
  if (typeof s === 'string' && s.trim()) return { selection: { text: s, startCol: 0, endCol: 0 } }
  if (s && typeof s.text === 'string') return { selection: { text: s.text, startCol: Number(s.startCol) || 0, endCol: Number(s.endCol) || 0 } }
  return {}
}

/** A missing "at" stays missing: unread state does not depend on it, and inventing one would be a lie. */
const readMessage = (m: any): Message => ({ author: String(m.author ?? 'unknown'), ...readRole(m.role), body: m.body, ...optStr('at', m.at) })

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
    ...optStr('claudeSession', v.claudeSession, true),
    ...readSelection(v.selection),
    status: v.status === 'resolved' ? 'resolved' : 'open',
    stale: !target && !!v.stale,
    ...optStr('createdAt', v.createdAt),
    messages: v.messages.map(readMessage),
    ...opt(severity, 'severity', severity!),
    ...opt(events.length, 'events', events),
    ...opt(target, 'target', target!),
    ...opt(Object.keys(extra).length, 'extra', extra),
  }
}

/** The README the extension writes into the notes folder (named `folder`): the note format, for agents, naming `person`. */
export function agentReadme(person: string, folder: string): string {
  return `# Code notes

Notes **${person}** left on the code in this folder, one JSON file per note. The VS Code extension "Code Notes" shows
them as comment threads and lists them in its sidebar. Agents answer and resolve them by editing these files; the
extension picks changes up live and shows new messages to ${person} as unread.

## Format

\`\`\`json
{
  "id": "20261111-153012-ab12",
  "file": "src/main.ts",
  "range": { "start": 33, "end": 40 },
  "anchor": { "text": "  const token = readToken()", "before": "export function main() {", "after": "  use(token)" },
  "status": "open",
  "stale": false,
  "createdAt": "2026-11-11T15:30:12.000Z",
  "messages": [
    { "author": "${person}", "role": "human", "body": "Why is the token never removed?", "at": "2026-11-11T15:30:12.000Z" }
  ]
}
\`\`\`

| Field | Meaning |
|---|---|
| file name | The note's identity: \`<id>.json\`. Keep it when you edit a note. |
| \`file\` | The code file, relative to the folder that contains \`${folder}/\` (e.g. \`src/main.ts\`). Files outside that folder are refused. |
| \`range\` | Lines in \`file\`, 1-based, inclusive. |
| \`anchor\` | The lines the note is about (\`text\`), the lines around them, and the git \`branch\`/\`commit\` it was written on. The extension uses them to follow the code. |
| \`session\` | Optional: a name that groups notes (e.g. \`Review: render.go\`). The sidebar groups by session; a session can be hidden, resolved or deleted as a whole. |
| \`selection\` | Optional, when the note is about part of a line: \`{ "text": "readToken", "startCol": 8, "endCol": 17 }\` (0-based columns on the first line of \`range\`). A plain string is accepted as the text. |
| \`status\` | \`open\` or \`resolved\`. |
| \`stale\` | \`true\`: the code at \`range\` changed since the note was written; \`anchor.text\` is what it was about. |
| \`messages\` | The conversation, oldest first. \`role\` is \`human\` (${person}) or \`agent\`. |
| \`severity\` | Optional, for review findings: \`high\`, \`medium\`, \`low\` or \`nit\`. The sidebar shows an icon and lists the most severe first. |
| \`target\` | Optional: \`"file"\` for a note on a whole file, \`"folder"\` for a folder (\`file\` is then the folder, e.g. \`src/api\`). No \`range\` or \`anchor\`. |
| \`journey\` | Set on a question asked from a journey step: \`{ "id": "<journey id>", "step": "<step id>", "n": <its number then> }\`. The step is \`step\` in \`<notes folder>/journeys/<id>.json\` (find it by id: numbers change). |
| \`events\` | Status changes, oldest first: \`{ "type": "resolved" \\| "reopened", "by": "<name>", "role": "agent", "at": "<ISO 8601>" }\`. |

A note on a whole file or folder:

\`\`\`json
{ "file": "src/api", "target": "folder", "status": "open", "messages": [{ "author": "claude", "role": "agent", "body": "This folder mixes HTTP and storage code." }] }
\`\`\`

## For agents

- **Which notes need an answer:** \`status\` is \`open\` and the last message has \`"role": "human"\`.
- **Answer:** append \`{ "author": "<your name>", "role": "agent", "body": "<markdown>", "at": "<ISO 8601 now>" }\`
  to \`messages\`. Keep every other field as it is.
- **Read the code** at \`file\` / \`range\` first. If \`stale\` is true, the code changed: \`anchor.text\` is what the note was about.
- **Resolve** (only when asked): set \`"status": "resolved"\` and append \`{ "type": "resolved", "by": "<your name>", "role": "agent", "at": "<now>" }\`
  to \`events\`, in the same write as your last message if you add one. A reply on a resolved note reopens it.
- **Create a note** for ${person}: write \`<id>.json\` (id \`YYYYMMDD-HHMMSS-xxxx\`: the current time and 4 random
  letters, so many notes written in one second don't collide) with \`file\`, \`range\`, \`"status": "open"\` and one message
  with \`"role": "agent"\`. Leave \`anchor\` out: the extension fills it from the code at \`range\`.
- **A question from a journey step** (\`journey\` is set): answer about that step (its code is at the step's
  \`file\`/\`range\` in the journey file). A note starting "This step is out of date" asks you to fix the step itself
  (the code-journey skill's \`journey.py\`), then reply saying what you changed and resolve the note.
- **A review** (several findings): one note per finding, all with the same \`session\` (e.g. \`"Security review"\`)
  and a \`severity\`. The first line of the message is the note's title in the list: make it a one-sentence summary.
- **Suggest a fix:** a fenced block with the language \`suggestion\` holds the replacement for the note's lines
  (all of \`range\`, whole lines). ${person} gets an Apply button; nothing changes until they press it.
  \`\`\`\`
  \`\`\`suggestion
    const token = readToken()
    defer clear(token)
  \`\`\`
  \`\`\`\`
- **Link code** as \`path:line\` or \`[text](path#L12)\`: the thread turns them into links.
- **You changed the code a note points at** (moved or rewrote it): update \`file\` and \`range\` to where the code is now
  and set \`anchor\` to \`{}\`; the extension refills it from the new lines and clears \`stale\`. Leave other notes alone:
  the extension follows code that moved by itself.
- **Never delete note files**: resolve them. ${person} deletes notes.
- Write complete, valid JSON (no comments): write \`<id>.json.tmp\`, then rename it to \`<id>.json\`.
`
}
