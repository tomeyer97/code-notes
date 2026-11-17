// Find a note: every word must match somewhere in it (messages as written, file, session, authors).

import * as vscode from 'vscode'
import { notes } from '../app'
import { unread } from '../seen'
import { lastMessage, order } from '../sidebar/nodes'
import { Note } from '../store'
import { plain } from '../text'
import { reveal } from './reveal'

/** Every word must match somewhere in the note: messages as written, file, session, authors. */
export const findNote = async () => {
  const all = notes().sort((a, b) => a.data.file.localeCompare(b.data.file) || order(a, b))
  const hay = new Map(all.map((n) => [n.data.id, [n.data.file, n.data.session ?? '', ...n.data.messages.flatMap((m) => [m.author, m.body])].join('\n').toLowerCase()]))
  const item = (n: Note, words: string[]) => {
    const hit = words.length ? [...n.data.messages].reverse().find((m) => words.some((w) => m.body.toLowerCase().includes(w))) : undefined
    const shown = hit && hit !== n.data.messages[0] ? hit : n.data.messages.length > 1 ? lastMessage(n) : undefined
    return {
      label: `${unread(n) ? '$(circle-filled) ' : n.data.stale ? '$(warning) ' : n.data.status === 'resolved' ? '$(pass) ' : ''}${plain(n.data.messages[0]?.body ?? '', 70)}`,
      description: [`${n.data.file.split('/').pop()}:${n.data.range.start}`, n.data.session ? plain(n.data.session, 30) : ''].filter(Boolean).join(' · '),
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
  qp.onDidAccept(() => { const pick = qp.selectedItems[0]; qp.hide(); if (pick) void reveal(pick.note) })
  qp.onDidHide(() => qp.dispose())
  qp.show()
}
