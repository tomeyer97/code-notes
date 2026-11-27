// Unread replies: stepping through them (D / A outside a tour and a check), marking a note unread again, marking all read.
// What the person has read (the counts, unread()) is seen.ts; these are the commands on it.

import * as vscode from 'vscode'
import { notesPorts } from './ports'
import { firstFolder } from '../platform/host'
import { byFileThenLine, visibleNotes } from './visible'
import { mine } from './identity'
import { markRead, restoreSeen, seenSnapshot, setSeen, unread } from './seen'
import { forgetRevealed } from './revealed'
import { hint } from './hint'
import { hiddenSessions, sessionOf } from './model'
import { Note } from './store'
import { plural } from '../core/text'
import { notesFor } from './location'
import { relPath } from '../platform/documents'
import { reveal } from './reveal'
import { offerUndo } from './undo'
import { CommandArg, notesFrom } from './which'

/** Where the cursor is, as the notes say where they are: the file (relative) and the 1-based line. */
function cursorPlace(e: vscode.TextEditor): { file: string; line: number } {
  const uri = e.document.uri
  const file = notesFor(uri)[0]?.data.file ?? relPath(vscode.workspace.getWorkspaceFolder(uri) ?? firstFolder(), uri)
  return { file, line: e.selection.active.line + 1 }
}

/** A note after (> 0) or before (< 0) a place: by file name, then by line. */
const comparePlace = (n: Note, at: { file: string; line: number }) =>
  n.data.file !== at.file ? (n.data.file > at.file ? 1 : -1) : Math.sign(n.data.range.start - at.line)

/** How long "No unread replies" stays. */
const NONE_LEFT_MS = 4000

/** Next/previous note with unread replies after the cursor, by file then line. Hidden sessions are skipped. */
export async function stepUnread(dir: 1 | -1): Promise<void> {
  const shown = (n: Note) => !hiddenSessions().has(sessionOf(n))
  const pending = visibleNotes().filter((n) => unread(n) > 0 && shown(n)).sort(byFileThenLine)
  if (!pending.length) {
    // With a map open, say what D does outside a tour, and how to walk the steps instead.
    const walk = notesPorts().map.journey ? ' · to walk the steps, press ▶ on the map' : ''
    hint(`No unread replies${walk}`, 'check', NONE_LEFT_MS)
    return
  }
  const e = vscode.window.activeTextEditor
  const here = e ? cursorPlace(e) : undefined
  const ahead = (n: Note) => !here || (dir === 1 ? comparePlace(n, here) > 0 : comparePlace(n, here) < 0)
  const ordered = dir === 1 ? pending : [...pending].reverse()
  await reveal(ordered.find(ahead) ?? ordered[0])
}

/** codeNotes.markUnread: the note's replies from the last one not yours are new again. */
export const markUnread = async (arg?: CommandArg) => {
  const [n] = notesFrom(arg)
  if (!n) return
  let i = n.data.messages.length - 1
  while (i >= 0 && mine(n.data.messages[i])) i--
  if (i < 0) { hint('Nothing to mark unread: every message is yours'); return }
  forgetRevealed(n.data.id, true)
  await setSeen([[n.data.id, i]])
}

/** codeNotes.markAllRead, with Undo. */
export const markAllRead = async () => {
  const list = visibleNotes().filter((n) => unread(n) > 0)
  if (!list.length) return
  const before = seenSnapshot()
  await markRead(list)
  offerUndo(`Marked ${plural(list.length, 'note')} read`, () => restoreSeen(before))
}
