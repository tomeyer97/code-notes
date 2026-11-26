// The rows of the Code Notes view (NoteNode), one object per row kept in noteNodes (viewSync.ts reveals rows by
// identity). The Journeys view's rows are in nodes.ts. No vscode at run time here.
import type * as vscode from 'vscode'
import type { Note } from '../notes/store'
import { sessionFileKey } from '../platform/keys'
import { NodeCache } from './nodeCache'

/** A session's group (a review), and the notes listed in it. */
export type SessionNode = { kind: 'session'; name: string; notes: Note[] }
/** The notes of one file (or folder), at the top (a session lists its notes without file rows). */
export type FileNode = { kind: 'file'; key: string; folder: vscode.WorkspaceFolder; file: string; notes: Note[]; isFolder?: boolean }
export type NoteRowNode = { kind: 'note'; note: Note }
/** A note file that can't be used: its title and its last good version, when known. */
export type BrokenNode = { kind: 'broken'; uri: string; why: string; title?: string; known?: Note }

export type NoteNode = SessionNode | FileNode | NoteRowNode | BrokenNode

/** The Code Notes view's rows by key (keyOf). */
export const noteNodes = new NodeCache<NoteNode>()

/** A row's key: the same for the row made again in the next drawing. */
export function keyOf(node: NoteNode): string {
  switch (node.kind) {
    case 'note': return `note:${node.note.data.id}`
    case 'session': return `session:${node.name}`
    case 'file': return `file:${node.key}`
    case 'broken': return `broken:${node.uri}`
  }
}

const kept = <T extends NoteNode>(node: T): T => noteNodes.get(keyOf(node), node)

export const noteNode = (note: Note) => kept<NoteRowNode>({ kind: 'note', note })

export const sessionNode = (name: string, notes: Note[]) => kept<SessionNode>({ kind: 'session', name, notes })

/** The file row of note `n`, holding `notes`. */
export function fileNode(n: Note, notes: Note[]): FileNode {
  return kept<FileNode>({
    kind: 'file', key: sessionFileKey(undefined, n.folder.uri, n.data.file), folder: n.folder, file: n.data.file, notes,
    ...(n.data.target === 'folder' ? { isFolder: true } : {}),
  })
}
