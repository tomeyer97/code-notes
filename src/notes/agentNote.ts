// A note another program writes through the extension (a bridge controller): on lines of a file in an open folder,
// its first message the program's, in the session it names. Anchored as a note an agent writes into the notes
// folder is: the text at its lines (unsaved edits count) and the commit and branch (reanchor.ts adoptAnchor).
import * as vscode from 'vscode'
import { now } from '../platform/host'
import { linesOfUri, relPath } from '../platform/documents'
import { newId } from './create'
import { anchorAt } from './location'
import { inNotesFolder } from './notesFolder'
import { store } from './ports'

export interface AgentNote {
  uri: vscode.Uri
  /** 1-based, inclusive. */
  start: number
  end: number
  body: string
  session: string
  author: string
}

/** The note's id once saved; or why it can't be made (a reason a caller may show). */
export type AgentNoteResult = { id: string; file: string } | { error: string }

export async function addAgentNote(a: AgentNote): Promise<AgentNoteResult> {
  if (inNotesFolder(a.uri)) return { error: "no notes on Code Notes' own files" }
  const folder = vscode.workspace.getWorkspaceFolder(a.uri)
  if (!folder) return { error: 'the file is not in an open folder' }
  const lines = await linesOfUri(a.uri)
  if (!lines) return { error: 'the file cannot be read' }
  if (a.start > lines.length) return { error: `the file has ${lines.length} lines` }
  const end = Math.min(a.end, lines.length)
  const id = newId()
  const at = now()
  const n = {
    folder, uri: store().uriFor(folder, id),
    data: {
      id, file: relPath(folder, a.uri), range: { start: a.start, end },
      anchor: await anchorAt(lines, a.start - 1, end - 1, folder),
      session: a.session, status: 'open' as const, stale: false, createdAt: at,
      messages: [{ author: a.author, role: 'agent' as const, body: a.body, at }],
    },
  }
  if (!(await store().save(n))) return { error: 'the note could not be saved' }
  return { id, file: n.data.file }
}
