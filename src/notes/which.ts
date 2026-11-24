// Which notes a command is about: the selected rows, a tree node, a thread or reply, a link's id, or the cursor.

import * as vscode from 'vscode'
import { byId } from './visible'
import { order, selection } from './model'
import { noteOfRow } from './model/rows'
import { Note } from './store'
import { noteTitle, rangeLabel } from '../core/text'
import { notesAtLine } from './location'
import { noteOfThread } from '../threads/sync'

/**
 * What a command is given, by who calls it: a row of the Code Notes view (its node, and with several selected, all of
 * them as `many`), a link in a thread (the note's id), a thread's reply box (a CommentReply), a thread's title menu (the
 * CommentThread), or nothing (the palette, a key: the note at the cursor).
 */
export type CommandArg = { kind: string } | string | vscode.CommentReply | vscode.CommentThread | undefined

/** A thread's reply box (Ctrl+Enter, its buttons): the thread and the text typed. */
export const isReply = (arg: unknown): arg is vscode.CommentReply =>
  !!arg && typeof arg === 'object' && 'thread' in arg && 'text' in arg

/** The notes a command is about: sidebar selection, a tree node, a comment thread or reply, or the note at the cursor. */
export function notesFrom(arg: CommandArg | any, many?: any[]): Note[] {
  const one = (n: Note | undefined) => (n ? [n] : [])
  // A link in a thread (it never comes with a selection).
  if (typeof arg === 'string') return one(byId(arg))
  // Rows: several selected.
  if (Array.isArray(many) && many.length > 1) return many.map(noteOfRow).filter((n): n is Note => !!n)
  // A row.
  const row = noteOfRow(arg)
  if (row) return [row]
  // A reply box.
  if (arg?.thread) return one(noteOfThread(arg.thread))
  // A thread's title menu.
  if (arg && typeof arg === 'object' && 'uri' in arg && 'range' in arg) return one(noteOfThread(arg as vscode.CommentThread))
  // The palette or a key: the note at the cursor (the one just opened, if it is there).
  const editor = vscode.window.activeTextEditor
  if (!editor) return []
  const here = notesAtCursor(editor)
  const revealed = selection().revealed
  if (revealed) { const r = here.find((n) => n.data.id === revealed); if (r) return [r] }
  return here.slice(0, 1)
}

/** Notes covering the cursor line, innermost (smallest) first. */
function notesAtCursor(editor: vscode.TextEditor): Note[] {
  const line = editor.selection.active.line + 1
  const span = (n: Note) => n.data.range.end - n.data.range.start
  return notesAtLine(editor.document.uri, line).sort((a, b) => span(a) - span(b) || order(a, b))
}

/** notesFrom; but from the palette, with several notes at the cursor, it asks which. */
export async function pickNotes(arg: CommandArg | any, many?: any[]): Promise<Note[]> {
  if (arg !== undefined || many) return notesFrom(arg, many)
  const editor = vscode.window.activeTextEditor
  const here = editor ? notesAtCursor(editor) : []
  if (!here.length) { vscode.window.setStatusBarMessage('$(info) No note at the cursor', 2500); return [] }
  if (here.length === 1) return here
  const items = here.map((n) => ({ label: noteTitle(n, 70), description: rangeLabel(n), note: n }))
  const pick = await vscode.window.showQuickPick(items, { title: 'Which note?' })
  return pick ? [pick.note] : []
}
