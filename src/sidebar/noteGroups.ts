// The Code Notes view's structure, worked out once per drawing (NotesLayout): the rows, each row's parent, their order
// and the counts the rows show. getChildren and getParent read it; no row regroups the notes. No vscode at run time.
import type { Note } from '../notes/store'
import type { Severity } from '../core/format/noteModel'
import { order, sessionOf } from '../notes/model/query'
import { sessionFileKey } from '../platform/keys'
import { BrokenNode, FileNode, fileNode, keyOf, NoteNode, noteNode, sessionNode } from './noteNodes'

/** Most severe first; a note without a severity counts as medium. */
const SEV_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2, nit: 3 }

export const sevRank = (n: Note) => SEV_RANK[n.data.severity ?? 'medium']

/** The order of notes under a file row: severity, then the whole-file note, then notes/model's `order` (by line). */
export const rowOrder = (a: Note, b: Note) =>
  sevRank(a) - sevRank(b) || (a.data.target ? 0 : 1) - (b.data.target ? 0 : 1) || order(a, b)

/** The order of notes in a session (a review, read as one list): severity, then by file, then as under a file row. */
export const sessionOrder = (a: Note, b: Note) =>
  sevRank(a) - sevRank(b) || a.data.file.localeCompare(b.data.file) || rowOrder(a, b)

/** What a session's row counts: its notes listed, those with unread replies, and resolved ones out of all of its notes. */
export interface SessionCounts { unread: number; resolved: number; total: number }
/** What a file row counts: its stale notes and its notes with something unread. */
export interface FileCounts { stale: number; unread: number }

/** What a row shows that depends on the other rows. */
export interface RowFacts {
  /** No file row above the note's row (in a session, or in the Journeys view): the row names its file. */
  alone(n: Note): boolean
  session(name: string): SessionCounts
  file(key: string): FileCounts
}

const NO_SESSION: SessionCounts = { unread: 0, resolved: 0, total: 0 }
const NO_FILE: FileCounts = { stale: 0, unread: 0 }

/** What the layout is made from (the notes model's answers, read once). */
export interface LayoutInput {
  /** The notes listed: the filter's, without the questions asked from a step (they are in the Journeys view). */
  listed: Note[]
  /** Every note shown anywhere (a session's resolved count is out of all of its notes). */
  visible: Note[]
  broken: BrokenNode[]
  /** The session group a note is listed under, if any. */
  scopeOf(n: Note): string | undefined
  unread(n: Note): number
}

export class NotesLayout implements RowFacts {
  /** The top rows: note files that can't be used, the sessions (when grouped by session), then the files. */
  readonly roots: NoteNode[]
  private readonly kids = new Map<string, NoteNode[]>()
  private readonly parents = new Map<string, NoteNode>()
  private readonly sessions = new Map<string, SessionCounts>()
  private readonly files = new Map<string, FileCounts>()
  /** The notes listed under a file row (by id). */
  private readonly inFile = new Set<string>()

  constructor(private readonly input: LayoutInput) {
    const grouped = input.listed.filter((n) => input.scopeOf(n) !== undefined)
    const loose = input.listed.filter((n) => input.scopeOf(n) === undefined)
    this.roots = [...input.broken, ...this.sessionRows(grouped), ...this.fileRows(loose)]
  }

  children(node: NoteNode): NoteNode[] { return this.kids.get(keyOf(node)) ?? [] }

  parent(node: NoteNode): NoteNode | undefined { return this.parents.get(keyOf(node)) }

  alone(n: Note): boolean { return !this.inFile.has(n.data.id) }

  session(name: string): SessionCounts { return this.sessions.get(name) ?? NO_SESSION }

  file(key: string): FileCounts { return this.files.get(key) ?? NO_FILE }

  private under(parent: NoteNode, rows: NoteNode[]): NoteNode[] {
    this.kids.set(keyOf(parent), rows)
    for (const r of rows) this.parents.set(keyOf(r), parent)
    return rows
  }

  /** One row per session: those with unread replies first, then the newest. Notes without a session: "Notes". */
  private sessionRows(grouped: Note[]): NoteNode[] {
    const bySession = new Map<string, Note[]>()
    for (const n of grouped) bySession.set(sessionOf(n), [...(bySession.get(sessionOf(n)) ?? []), n])
    const latest = (list: Note[]) => list.map((n) => n.data.createdAt ?? n.data.id).sort().pop() ?? ''
    const hasNew = (list: Note[]) => (list.some((n) => this.input.unread(n) > 0) ? 0 : 1)
    return [...bySession].map(([name, list]) => {
      const node = sessionNode(name, list)
      const all = this.input.visible.filter((n) => sessionOf(n) === name)
      this.sessions.set(name, {
        unread: list.filter((n) => this.input.unread(n) > 0).length,
        resolved: all.filter((n) => n.data.status === 'resolved').length,
        total: all.length,
      })
      // A review reads as one list, most severe first: no file rows inside a session.
      this.under(node, [...list].sort(sessionOrder).map(noteNode))
      return node
    }).sort((x, y) => hasNew(x.notes) - hasNew(y.notes) || latest(y.notes).localeCompare(latest(x.notes)))
  }

  /** Notes grouped by file (or folder), by path; a file with one note is a file row too (one shape to scan). */
  private fileRows(list: Note[]): NoteNode[] {
    const groups = new Map<string, FileNode>()
    for (const n of list) {
      const key = sessionFileKey(undefined, n.folder.uri, n.data.file)
      if (!groups.has(key)) groups.set(key, fileNode(n, []))
      groups.get(key)!.notes.push(n)
      this.inFile.add(n.data.id)
    }
    // A stable order: the list must not jump while an agent writes; unread shows as dots.
    return [...groups.values()].sort((a, b) => a.file.localeCompare(b.file)).map((g) => this.fileRow(g))
  }

  private fileRow(g: FileNode): FileNode {
    this.files.set(g.key, {
      stale: g.notes.filter((n) => n.data.stale).length,
      unread: g.notes.filter((n) => this.input.unread(n) > 0).length,
    })
    this.under(g, [...g.notes].sort(rowOrder).map(noteNode))
    return g
  }
}
