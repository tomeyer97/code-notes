// Which notes a command is about: the selected rows, a tree node, a thread or reply, a link's id, or the cursor.

import * as vscode from 'vscode'
import { byId } from '../app'
import { order } from '../sidebar/nodes'
import { Note } from '../store'
import { noteTitle, rangeLabel } from '../text'
import { notesFor } from '../threads/anchoring'
import { noteOfThread, revealed } from '../threads/threads'

/** The notes a command is about: sidebar selection, a tree node, a comment thread or reply, or the note at the cursor. */
export function notesFrom(arg: any, many?: any[]): Note[] {
  const fromNode = (x: any): Note | undefined => (x?.kind === 'note' ? x.note : undefined)
  if (Array.isArray(many) && many.length > 1) return many.map(fromNode).filter((n): n is Note => !!n)
  if (arg?.kind === 'note') return [arg.note]
  if (typeof arg === 'string') { const n = byId(arg); return n ? [n] : [] } // a link in the thread
  if (arg?.thread) { const n = noteOfThread(arg.thread); return n ? [n] : [] }
  if (arg && typeof arg === 'object' && 'uri' in arg && 'range' in arg) { const n = noteOfThread(arg as vscode.CommentThread); return n ? [n] : [] }
  const editor = vscode.window.activeTextEditor
  if (!editor) return []
  const here = notesAtCursor(editor)
  if (revealed.id) { const r = here.find((n) => n.data.id === revealed.id); if (r) return [r] }
  return here.slice(0, 1)
}

/** Notes covering the cursor line, innermost (smallest) first. */
function notesAtCursor(editor: vscode.TextEditor): Note[] {
  const line = editor.selection.active.line + 1
  const span = (n: Note) => n.data.range.end - n.data.range.start
  return notesFor(editor.document.uri).filter((n) => line >= n.data.range.start && line <= n.data.range.end)
    .sort((a, b) => span(a) - span(b) || order(a, b))
}

/** For palette commands: the note at the cursor, asking which when several overlap. */
export async function target(arg: any, many?: any[]): Promise<Note[]> {
  if (arg !== undefined || many) return notesFrom(arg, many)
  const editor = vscode.window.activeTextEditor
  const here = editor ? notesAtCursor(editor) : []
  if (!here.length) { vscode.window.setStatusBarMessage('$(info) No note at the cursor', 2500); return [] }
  if (here.length === 1) return here
  const pick = await vscode.window.showQuickPick(here.map((n) => ({ label: noteTitle(n, 70), description: rangeLabel(n), note: n })), { title: 'Which note?' })
  return pick ? [pick.note] : []
}
