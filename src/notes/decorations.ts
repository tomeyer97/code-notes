// How notes mark their lines in the editor: a bar for open and stale notes, the exact text a note is about, unread
// in the scrollbar. (src/platform/decorations.ts sends each editor's decorations; the step card draws its own: tour/card.ts.)

import * as vscode from 'vscode'
import { cfg } from '../platform/settings'
import { setDecorations } from '../platform/editorDecorations'
import { unread } from './seen'
import { hiddenInEditor, NotesApi } from './model'
import { WorkspaceEvents } from '../platform/events'
import { Note } from './store'
import { notesPorts } from './ports'
import { lineNotesFor } from './location'

type Kind = 'openBar' | 'staleBar' | 'unread' | 'exact'

/** The notes' decoration types, made when the notes start (createDecorations). */
let deco: Record<Kind, vscode.TextEditorDecorationType> | undefined

const theme = (id: string) => new vscode.ThemeColor(id)

/** The left bar and the scrollbar mark of a note (one marker per note: never a tint over its lines). */
const BARS = {
  openBar: { style: 'solid', color: 'codeNotes.noteBorder', ruler: 'codeNotes.noteRuler' },
  staleBar: { style: 'dashed', color: 'editorWarning.foreground', ruler: 'editorWarning.foreground' },
}

function bar(b: (typeof BARS)[keyof typeof BARS]): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({
    isWholeLine: true, borderWidth: '0 0 0 2px', borderStyle: b.style, borderColor: theme(b.color),
    overviewRulerColor: theme(b.ruler), overviewRulerLane: vscode.OverviewRulerLane.Right,
  })
}

/** The notes' decoration types; disposed with the notes. */
export function createDecorations(): vscode.Disposable {
  const made: Record<Kind, vscode.TextEditorDecorationType> = {
    openBar: bar(BARS.openBar),
    staleBar: bar(BARS.staleBar),
    // Quieter than a note's mark: a light wash and a dotted line, never yellow (amber means stale).
    exact: vscode.window.createTextEditorDecorationType({
      backgroundColor: theme('codeNotes.selectionBackground'),
      borderWidth: '0 0 1px 0', borderStyle: 'dotted', borderColor: theme('codeNotes.noteBorder'),
    }),
    unread: vscode.window.createTextEditorDecorationType({
      overviewRulerColor: theme('codeNotes.unreadForeground'), overviewRulerLane: vscode.OverviewRulerLane.Left,
    }),
  }
  deco = made
  return vscode.Disposable.from(...Object.values(made), new vscode.Disposable(() => { if (deco === made) deco = undefined }))
}

/** The note's lines, as whole lines. */
const linesOf = (n: Note) => new vscode.Range(n.data.range.start - 1, 0, n.data.range.end - 1, 0)

/** The exact text the note is about, where it still is on the note's lines. */
function exactRange(doc: vscode.TextDocument, n: Note): vscode.Range | undefined {
  const sel = n.data.selection
  if (!sel || n.data.stale) return undefined
  const lines = linesOf(n)
  const text = doc.getText(lines.with({ end: new vscode.Position(n.data.range.end - 1, Number.MAX_SAFE_INTEGER) }))
  const at = text.indexOf(sel.text)
  if (at < 0) return undefined
  const from = doc.offsetAt(lines.start) + at
  return new vscode.Range(doc.positionAt(from), doc.positionAt(from + sel.text.length))
}

/** The notes marked in an editor: open or unread, not in a hidden session. */
const marked = (n: Note) => (n.data.status === 'open' || unread(n) > 0) && !hiddenInEditor(n)

/** Every visible editor's note marks (and the step card's), as the notes are now. None on the code a podcast is
 *  telling while it plays (they come back on pause). */
export function refreshDecorations(): void {
  if (!deco) return
  const on = cfg().get<boolean>('highlight', true)
  for (const editor of vscode.window.visibleTextEditors) {
    const shown = on && !notesPorts().layout.narrates(editor)
    const list = shown ? lineNotesFor(editor.document.uri).filter(marked) : []
    setDecorations(editor, deco.openBar, list.filter((n) => !n.data.stale).map(linesOf))
    setDecorations(editor, deco.staleBar, list.filter((n) => n.data.stale).map(linesOf))
    setDecorations(editor, deco.unread, list.filter((n) => unread(n) > 0).map(linesOf))
    setDecorations(editor, deco.exact, list.map((n) => exactRange(editor.document, n)).filter((r): r is vscode.Range => !!r))
  }
  notesPorts().layout.refreshCard()
}

/** The marks follow the notes (an edit being typed too) and the editors on screen. */
export function followNotes(model: NotesApi, events: WorkspaceEvents): vscode.Disposable {
  return vscode.Disposable.from(
    model.onDidChange(() => refreshDecorations()),
    events.onDidChangeVisibleEditors(() => refreshDecorations()),
  )
}
