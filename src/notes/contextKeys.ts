// The notes' context keys (model/contextKeys.ts) sent as the notes change.
import * as vscode from 'vscode'
import { setCtx } from '../platform/context'
import { fireAndForget } from '../platform/run'
import { NOTES_CTX, NotesCtxKey, notesContext } from './model/contextKeys'
import { NotesApi, whileTyping } from './model'
import type { Note } from './store'

export interface ContextPorts { notes(): Note[]; brokenCount(): number; isCheck(n: Note): boolean }

export function followContextKeys(model: NotesApi, ports: ContextPorts): vscode.Disposable {
  return model.onDidChange((c) => {
    if (whileTyping(c)) return
    const { query, selection } = model
    const values = notesContext({
      notes: ports.notes(), broken: ports.brokenCount(), checked: selection.checked.size,
      filter: query.filter, groupMode: query.groupMode, showResolved: query.showResolved,
      isCheck: ports.isCheck, isHidden: (n) => query.isHidden(n),
    })
    for (const k of Object.keys(values) as NotesCtxKey[]) fireAndForget(setCtx(NOTES_CTX[k], values[k]), `setCtx ${NOTES_CTX[k]}`)
  })
}
