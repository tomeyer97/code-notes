// The notes' comment threads in the editor: one per note shown, kept in step with the note, and the lines marked.

import * as vscode from 'vscode'
import { byId, cfg, controller, log, notes, store, understanding } from '../app'
import { askErrors, asking } from '../ask'
import { setDecorations } from '../decorations'
import { isAgent, mine, otherBranch } from '../identity'
import { addEvent } from '../notes/status'
import { refreshAll } from '../refresh'
import { seenCount, unread, visitFrom } from '../seen'
import { stepLinkOf } from '../sidebar/journeyRows'
import { lastMessage } from '../sidebar/nodes'
import { hiddenInEditor } from '../sidebar/notesFilter'
import { Note } from '../store'
import { shortQ } from '../text'
import { card, tourState, walk } from '../tour/instances'
import { docUri, lineNotesFor, missing, openDoc, pastEnd, reanchorAll } from './anchoring'
import { commentsOf, expanded, threadRange } from './comments'
import { editorSettling, newThread, setThread, settleLater, settling, whenSettled } from './settle'

/** note id -> its thread */
export const threads = new Map<string, vscode.CommentThread>()

/** Message count and status per note as last seen from disk, to notice replies on resolved notes. */
export const shape = new Map<string, { count: number; status: string; events: number }>()

export const shapeOf = (n: Note) => ({ count: n.data.messages.length, status: n.data.status, events: n.data.events?.length ?? 0 })

/** The note the person just opened (`id`): its thread shows even when resolved. */
export const revealed: { id?: string } = {}

/** Notes opened (a row clicked) before their thread was made (its editor was still opening): made expanded. */
export const expandWhenMade = new Set<string>()

/** What each thread last rendered (see syncThread). */
const shown = new Map<string, string>()

export function syncThread(n: Note): void {
  const showResolvedInEditor = cfg().get<boolean>('showResolvedInEditor', false)
  let t = threads.get(n.data.id)
  const wanted = ((n.data.status === 'open' || showResolvedInEditor || unread(n) > 0 || revealed.id === n.data.id || !!understanding?.pinned(n)) && !hiddenInEditor(n)) || asking.has(n.data.id) || askErrors.has(n.data.id) || !!understanding?.threadStatus(n)?.checking || !!understanding?.threadStatus(n)?.error
  if (!wanted) {
    if (t) { t.dispose(); threads.delete(n.data.id); shown.delete(n.data.id) }
    return
  }
  if (!t || t.uri.toString() !== docUri(n).toString()) {
    const wait = editorSettling(docUri(n))
    if (wait) { const id = n.data.id; clearTimeout(settleLater.get(`new:${id}`)); settleLater.set(`new:${id}`, setTimeout(() => { settleLater.delete(`new:${id}`); const x = byId(id); if (x) syncThread(x) }, wait)); return }
    t?.dispose()
    shown.delete(n.data.id)
    t = newThread(controller, docUri(n), threadRange(n))
    // The note just opened (a row clicked while its editor was still opening: the thread is made only now) opens
    // expanded; any other starts collapsed.
    t.collapsibleState = expandWhenMade.delete(n.data.id) ? vscode.CommentThreadCollapsibleState.Expanded : vscode.CommentThreadCollapsibleState.Collapsed
    threads.set(n.data.id, t)
  } else if (settling(t)) {
    // Made just now: its first state is still on the way to the workbench; this update follows once it is there.
    const id = n.data.id
    whenSettled(t, `sync:${id}`, () => { const x = byId(id); if (x) syncThread(x) })
    return
  }
  const r = threadRange(n)
  if (!t.range || !t.range.isEqual(r)) t.range = r
  // Rebuilding comments re-renders the widget: only when something shown changed (an agent reply elsewhere must be cheap).
  const sig = JSON.stringify([stepLinkOf(n) ? `${tourState.key}|${walk.touring()}|${tourState.stepId}` : '', n.data.messages.length, n.data.messages[n.data.messages.length - 1]?.body.length, n.data.status, n.data.stale, n.data.events?.length, n.data.target,
    missing.has(n.data.id), pastEnd.get(n.data.id), n.data.stale && openDoc(docUri(n))?.version, seenCount(n), visitFrom.get(n.data.id), expanded.has(n.data.id), otherBranch(n) ?? '', n.data.anchor.text.length,
    asking.get(n.data.id)?.text.length, asking.get(n.data.id)?.activity, JSON.stringify(understanding?.threadStatus(n) ?? null), asking.has(n.data.id) && Math.floor((Date.now() - asking.get(n.data.id)!.started) / 5000), askErrors.get(n.data.id)])
  if (shown.get(n.data.id) !== sig) { t.comments = commentsOf(n, t); shown.set(n.data.id, sig) }
  setThread(t, 'canReply', true)
  // A check thread is never "resolved" in the editor: VS Code collapses a thread when it is, and the grade must stay in
  // view; and resolving a thread that has the keyboard selects its lines in the code, where typing would replace them.
  const st = n.data.status === 'resolved' && !understanding?.isCheck(n) ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved
  if (t.state !== st) t.state = st
  setThread(t, 'contextValue', ['note', n.data.status, n.data.stale ? 'stale' : '', asking.has(n.data.id) ? 'asking' : '', understanding?.isCheck(n) ? 'check' : ''].filter(Boolean).join(';'))
  // Question, replies, Reply: the header says only what the gutter can't — a file or folder note,
  // or that its file is missing. Severity, session, "n new" and "resolved" are in the list and VS Code's own state.
  setThread(t, 'label', [
    n.data.target === 'folder' ? `Folder ${n.data.file}/` : n.data.target ? 'File note' : '',
    missing.has(n.data.id) ? `⚠ ${n.data.target === 'folder' ? 'folder' : 'file'} not found` : '',
    // The note's first line: never VS Code's "Start discussion".
    shortQ(((n.data.messages[0]?.body ?? '').split('\n').find((l) => l.trim()) ?? '').replace(/\*\*|`/g, ''), 80),
    // VS Code shows a label HTML-escaped ("&lt;"): <, > and & as look-alikes (as on the step card).
  ].filter(Boolean).join(' · ').replace(/</g, '‹').replace(/>/g, '›').replace(/&/g, '＆'))
}

export function noteOfThread(t: vscode.CommentThread): Note | undefined {
  for (const [id, th] of threads) if (th === t) return byId(id)
  return undefined
}

export let deco: Record<'open' | 'openBar' | 'stale' | 'staleBar' | 'unread' | 'exact', vscode.TextEditorDecorationType>

export function refreshDecorations(): void {
  const on = cfg().get<boolean>('highlight', true)
  for (const editor of vscode.window.visibleTextEditors) {
    const list = on ? lineNotesFor(editor.document.uri).filter((n) => (n.data.status === 'open' || unread(n) > 0) && !hiddenInEditor(n)) : []
    const range = (n: Note) => new vscode.Range(n.data.range.start - 1, 0, n.data.range.end - 1, 0)
    // Big notes (a function, a whole file) get the left bar only, so they don't flood the code or hide notes inside them.
    // One marker per note (–): the left bar and the scrollbar mark, never a tint over its lines.
    const big = (_n: Note) => true
    setDecorations(editor, deco.open, list.filter((n) => !n.data.stale && !big(n)).map(range))
    setDecorations(editor, deco.openBar, list.filter((n) => !n.data.stale && big(n)).map(range))
    setDecorations(editor, deco.stale, list.filter((n) => n.data.stale && !big(n)).map(range))
    setDecorations(editor, deco.staleBar, list.filter((n) => n.data.stale && big(n)).map(range))
    setDecorations(editor, deco.unread, list.filter((n) => unread(n) > 0).map(range))
    // The exact text a note is about, where it still is on the note's lines.
    const exact: vscode.Range[] = []
    for (const n of list) {
      const sel = n.data.selection
      if (!sel || n.data.stale) continue
      const text = editor.document.getText(range(n).with({ end: new vscode.Position(n.data.range.end - 1, Number.MAX_SAFE_INTEGER) }))
      const at = text.indexOf(sel.text)
      if (at >= 0) exact.push(new vscode.Range(editor.document.positionAt(editor.document.offsetAt(range(n).start) + at), editor.document.positionAt(editor.document.offsetAt(range(n).start) + at + sel.text.length)))
    }
    setDecorations(editor, deco.exact, exact)
  }
  card.refreshDecorations()
}

/** How notes mark their lines: open or stale, a bar or a tint, the exact text, unread in the scrollbar. */
export function createDecorations(): void {
  deco = {
    open: vscode.window.createTextEditorDecorationType({
      isWholeLine: true, backgroundColor: new vscode.ThemeColor('codeNotes.noteBackground'),
      borderWidth: '0 0 0 2px', borderStyle: 'solid', borderColor: new vscode.ThemeColor('codeNotes.noteBorder'),
      overviewRulerColor: new vscode.ThemeColor('codeNotes.noteRuler'), overviewRulerLane: vscode.OverviewRulerLane.Right,
    }),
    stale: vscode.window.createTextEditorDecorationType({
      isWholeLine: true, backgroundColor: new vscode.ThemeColor('codeNotes.staleBackground'),
      borderWidth: '0 0 0 2px', borderStyle: 'dashed', borderColor: new vscode.ThemeColor('editorWarning.foreground'),
      overviewRulerColor: new vscode.ThemeColor('editorWarning.foreground'), overviewRulerLane: vscode.OverviewRulerLane.Right,
    }),
    openBar: vscode.window.createTextEditorDecorationType({
      isWholeLine: true, borderWidth: '0 0 0 2px', borderStyle: 'solid', borderColor: new vscode.ThemeColor('codeNotes.noteBorder'),
      overviewRulerColor: new vscode.ThemeColor('codeNotes.noteRuler'), overviewRulerLane: vscode.OverviewRulerLane.Right,
    }),
    staleBar: vscode.window.createTextEditorDecorationType({
      isWholeLine: true, borderWidth: '0 0 0 2px', borderStyle: 'dashed', borderColor: new vscode.ThemeColor('editorWarning.foreground'),
      overviewRulerColor: new vscode.ThemeColor('editorWarning.foreground'), overviewRulerLane: vscode.OverviewRulerLane.Right,
    }),
    // Quieter than the note's tint: a light wash and a dotted line, never yellow (amber means stale).
    exact: vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('codeNotes.selectionBackground'),
      borderWidth: '0 0 1px 0', borderStyle: 'dotted', borderColor: new vscode.ThemeColor('codeNotes.noteBorder'),
    }),
    unread: vscode.window.createTextEditorDecorationType({
      overviewRulerColor: new vscode.ThemeColor('codeNotes.unreadForeground'), overviewRulerLane: vscode.OverviewRulerLane.Left,
    }),
  }
}

/** Whether the notes were read once: changes on disk are told apart from then on. */
let loaded = false
/** The notes were read: what they are now is what later changes on disk are compared with. */
export function followNotesOnDisk(): void {
  for (const n of notes()) shape.set(n.data.id, shapeOf(n))
  loaded = true
}
let reanchorTimer: NodeJS.Timeout | undefined

/** Notes changed on disk (an agent replied, resolved, or added a note): each note's rule, then everything refreshed. */
export async function notesChangedOnDisk(): Promise<void> {
  for (const n of notes()) await noteChangedOnDisk(n)
  refreshAll()
  // A question on the current step was asked or answered: the card says so.
  const tj = walk.touring() ? walk.tourJourney() : undefined
  if (tj && !card.inMap(tj, tourState.step)) card.show(tj, tourState.step)
  clearTimeout(reanchorTimer)
  reanchorTimer = setTimeout(() => reanchorAll().then(refreshAll), 200)
}

/**
 * Someone else's reply reopens a resolved note. A status changed on disk without saying so in "events" is recorded, as
 * theirs, so it shows as new; not when the file lost events (an older version restored: git checkout, undo), nor twice
 * in a row for the same change.
 */
async function noteChangedOnDisk(n: Note): Promise<void> {
  const prev = shape.get(n.data.id)
  if (loaded && prev) await statusChangedOnDisk(n, prev)
  shape.set(n.data.id, shapeOf(n))
}

async function statusChangedOnDisk(n: Note, prev: { count: number; status: string; events: number }): Promise<void> {
  const count = n.data.messages.length
  if (prev.status === 'resolved' && n.data.status === 'resolved' && count > prev.count && n.data.messages.slice(prev.count).some((m) => !mine(m))) {
    n.data.status = 'open'
    addEvent(n, 'reopened', lastMessage(n)?.author ?? 'someone', isAgent(lastMessage(n)!) ? 'agent' : undefined)
    log.appendLine(`note ${n.data.id}: reopened by a reply from ${lastMessage(n)?.author}`)
    await store.save(n)
  } else if (prev.status !== n.data.status) {
    log.info(`note ${n.data.id}: ${n.data.status} on disk (by someone else)`)
    const evs = n.data.events ?? []
    const type = n.data.status === 'resolved' ? 'resolved' : 'reopened'
    if (evs.length === prev.events && evs[evs.length - 1]?.type !== type) {
      const by = [...n.data.messages].reverse().find((m) => !mine(m))
      addEvent(n, type, by?.author ?? 'someone', by && isAgent(by) ? 'agent' : undefined)
      await store.save(n)
    }
  }
}
