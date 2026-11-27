// The notes as the views list them: every note but those a feature hides (the check hides its questions of another
// branch: their lines belong to that branch). `byId` finds any note, hidden or not.
import * as vscode from 'vscode'
import { hiddenBy, store } from './ports'
import type { Note } from './store'
import { order } from './model'

/** The notes every view and list shows. */
export const visibleNotes = (): Note[] => {
  const hidden = hiddenBy()
  return store().all().filter((n) => !hidden.some((h) => h(n)))
}

/** Any note by id, listed or not. */
export const byId = (id: string) => store().get(id)

/** From now on the lists leave out the notes `hides` says (until disposed). */
export function hideNotes(hides: (n: Note) => boolean): vscode.Disposable {
  const list = hiddenBy()
  list.push(hides)
  return new vscode.Disposable(() => {
    const i = list.indexOf(hides)
    if (i >= 0) list.splice(i, 1)
  })
}

/** The notes in list order: by file, then by line (find and D/A step through them so). */
export const byFileThenLine = (a: Note, b: Note) => a.data.file.localeCompare(b.data.file) || order(a, b)
