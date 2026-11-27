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

/** What a session's row counts: its notes listed, those with unread replies, and resolved ones out of all of its notes. */
export interface SessionCounts { unread: number; resolved: number; total: number }
/** What a file row counts: its stale notes and its unread messages. */
export interface FileCounts { stale: number; newMessages: number }

/** What a row shows that depends on the other rows. */
export interface RowFacts {
  /** The note is a row of its own (no file row above it): the row names its file. */
  alone(n: Note): boolean
  session(name: string): SessionCounts
  file(key: string): FileCounts
}

const NO_SESSION: SessionCounts = { unread: 0, resolved: 0, total: 0 }
const NO_FILE: FileCounts = { stale: 0, newMessages: 0 }

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

/** The key of the file row a note falls in, under `scope`. */
const fileKeyOf = (n: Note, scope: string | undefined) => sessionFileKey(scope, n.folder.uri, n.data.file)

export class NotesLayout implements RowFacts {
  /** The top rows: note files that can't be used, the sessions (when grouped by session), then the notes by file. */
  readonly roots: NoteNode[]
  private readonly kids = new Map<string, NoteNode[]>()
  private readonly parents = new Map<string, NoteNode>()
  private readonly sessions = new Map<string, SessionCounts>()
  private readonly files = new Map<string, FileCounts>()
  /** How many listed notes fall in each file row's key. */
  private readonly perFile = new Map<string, number>()

  constructor(private readonly input: LayoutInput) {
    const grouped = input.listed.filter((n) => input.scopeOf(n) !== undefined)
    const loose = input.listed.filter((n) => input.scopeOf(n) === undefined)
    this.roots = [...input.broken, ...this.sessionRows(grouped), ...this.fileRows(loose, undefined)]
  }

  children(node: NoteNode): NoteNode[] { return this.kids.get(keyOf(node)) ?? [] }

  parent(node: NoteNode): NoteNode | undefined { return this.parents.get(keyOf(node)) }

  /** At most one listed note in its file (itself, or one other when it is not listed: a step's question). */
  alone(n: Note): boolean { return (this.perFile.get(fileKeyOf(n, this.input.scopeOf(n))) ?? 0) <= 1 }

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
      this.under(node, this.fileRows(list, name))
      return node
    }).sort((x, y) => hasNew(x.notes) - hasNew(y.notes) || latest(y.notes).localeCompare(latest(x.notes)))
  }

  /** Notes grouped by file (or folder); a file with one note is that note's row. */
  private fileRows(list: Note[], session: string | undefined): NoteNode[] {
    const groups = new Map<string, FileNode>()
    for (const n of list) {
      const key = fileKeyOf(n, session)
      if (!groups.has(key)) groups.set(key, fileNode(n, session, []))
      groups.get(key)!.notes.push(n)
      this.perFile.set(key, (this.perFile.get(key) ?? 0) + 1)
    }
    // A stable order: the list must not jump while an agent writes; unread shows as dots.
    // In a session (a review): the most severe findings first, then by file.
    const worst = (g: FileNode) => (session !== undefined ? Math.min(...g.notes.map(sevRank)) : 0)
    return [...groups.values()]
      .sort((a, b) => worst(a) - worst(b) || a.file.localeCompare(b.file))
      .map((g) => (g.notes.length === 1 ? noteNode(g.notes[0]) : this.fileRow(g)))
  }

  private fileRow(g: FileNode): FileNode {
    this.files.set(g.key, {
      stale: g.notes.filter((n) => n.data.stale).length,
      newMessages: g.notes.reduce((a, n) => a + this.input.unread(n), 0),
    })
    this.under(g, [...g.notes].sort(rowOrder).map(noteNode))
    return g
  }
}
