// Find a note: every word must match somewhere in it (messages as written, file, session, authors).

import * as vscode from 'vscode'
import { byFileThenLine, visibleNotes } from './visible'
import { unread } from './seen'
import { lastMessage } from './model'
import { Note } from './store'
import { noteTitle, plain } from '../core/text'
import { reveal } from './reveal'
import { pickOne } from '../platform/quickPick'
import { baseName } from '../core/paths'
import { fireAndForget } from '../platform/run'

/** What a note's words are searched in: its file, session, and every message's author and text. */
const haystack = (n: Note) =>
  [n.data.file, n.data.session ?? '', ...n.data.messages.flatMap((m) => [m.author, m.body])].join('\n').toLowerCase()

/** The row's icon: unread, stale or resolved (the first that applies), else none (a picker row has no colours). */
function findIcon(n: Note): string {
  if (unread(n)) return '$(circle-filled) '
  if (n.data.stale) return '$(warning) '
  return n.data.status === 'resolved' ? '$(pass) ' : ''
}

/** Every word must match somewhere in the note: messages as written, file, session, authors. */
export const findNote = async () => {
  const all = visibleNotes().sort(byFileThenLine)
  const hay = new Map(all.map((n) => [n.data.id, haystack(n)]))
  const item = (n: Note, words: string[]) => {
    // The newest message with a word in it; else, in a thread with replies, the last one.
    const hit = words.length ? [...n.data.messages].reverse().find((m) => words.some((w) => m.body.toLowerCase().includes(w))) : undefined
    const shown = hit && hit !== n.data.messages[0] ? hit : n.data.messages.length > 1 ? lastMessage(n) : undefined
    return {
      label: `${findIcon(n)}${noteTitle(n, 70)}`,
      description: [`${baseName(n.data.file)}:${n.data.range.start}`, n.data.session ? plain(n.data.session, 30) : ''].filter(Boolean).join(' · '),
      detail: shown ? `${shown.author}: ${plain(shown.body, 100)}` : undefined,
      alwaysShow: true, // filtered here, not by VS Code
      note: n,
    }
  }
  const qp = vscode.window.createQuickPick<ReturnType<typeof item>>()
  qp.title = 'Find a note'
  qp.placeholder = 'Words in notes, replies, files or sessions'
  const update = () => {
    const words = qp.value.toLowerCase().split(/\s+/).filter(Boolean)
    qp.items = all.filter((n) => words.every((w) => hay.get(n.data.id)!.includes(w))).map((n) => item(n, words))
  }
  qp.onDidChangeValue(update)
  update()
  // Not awaited: the command returns while the pick is open.
  fireAndForget(pickOne(qp).then((pick) => { if (pick) fireAndForget(reveal(pick.note), 'find: reveal') }), 'find: pickOne')
}
