// The notes' comment threads in the editor: one per note shown, kept in step with the note.

import * as vscode from 'vscode'
import { byId, cfg, controller, understanding } from '../app'
import { askErrors, asking } from '../ask'
import { otherBranch } from '../identity'
import { docUri, missing, openDoc, pastEnd } from '../notes/location'
import { seenCount, unread, visitFrom } from '../seen'
import { stepLinkOf } from '../sidebar/journeyRows'
import { hiddenInEditor } from '../sidebar/nodes'
import { Note } from '../store'
import { shortQ } from '../text'
import { tour, walk } from '../tour/tour'
import { commentsOf, expanded, threadRange } from './comments'
import { afterEditorSettles, newThread, setThread, settling, whenSettled } from './settle'

/** note id -> its thread */
export const threads = new Map<string, vscode.CommentThread>()

/** The note the person just opened (`id`): its thread shows even when resolved. */
export const revealed: { id?: string } = {}

/** Notes opened (a row clicked) before their thread was made (its editor was still opening): made expanded. */
export const expandWhenMade = new Set<string>()

/** What each thread last rendered (renderKey). */
const shown = new Map<string, string>()

/** The note's thread made, changed or removed to match the note. */
export function syncThread(n: Note): void {
  const id = n.data.id
  let t = threads.get(id)
  if (!isWanted(n)) {
    if (t) { t.dispose(); threads.delete(id); shown.delete(id) }
    return
  }
  const resync = () => { const x = byId(id); if (x) syncThread(x) }
  if (!t || t.uri.toString() !== docUri(n).toString()) {
    if (afterEditorSettles(docUri(n), `new:${id}`, resync)) return
    t?.dispose()
    shown.delete(id)
    t = newThread(controller, docUri(n), threadRange(n))
    // The note just opened (a row clicked while its editor was still opening: the thread is made only now) opens
    // expanded; any other starts collapsed.
    t.collapsibleState = expandWhenMade.delete(id) ? vscode.CommentThreadCollapsibleState.Expanded : vscode.CommentThreadCollapsibleState.Collapsed
    threads.set(id, t)
  } else if (settling(t)) {
    // Made just now: its first state is still on the way to the workbench; this update follows once it is there.
    whenSettled(t, `sync:${id}`, resync)
    return
  }
  const r = threadRange(n)
  if (!t.range || !t.range.isEqual(r)) t.range = r
  // Rebuilding comments re-renders the widget: only when something shown changed (an agent reply elsewhere must be cheap).
  const key = renderKey(n)
  if (shown.get(id) !== key) { t.comments = commentsOf(n, t); shown.set(id, key) }
  setThread(t, 'canReply', true)
  // A check thread is never "resolved" in the editor: VS Code collapses a thread when it is, and the grade must stay in
  // view; and resolving a thread that has the keyboard selects its lines in the code, where typing would replace them.
  const resolved = n.data.status === 'resolved' && !understanding?.isCheck(n)
  const state = resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved
  if (t.state !== state) t.state = state
  setThread(t, 'contextValue', threadContext(n))
  setThread(t, 'label', threadLabel(n))
}

/**
 * Whether the note has a thread in the editor: open, resolved ones when the setting says so, unread, just opened or
 * pinned by the check (unless its session is hidden); and always while Claude or the check is at work on it, or failed.
 */
function isWanted(n: Note): boolean {
  const id = n.data.id
  const showResolved = cfg().get<boolean>('showResolvedInEditor', false)
  const listed = n.data.status === 'open' || showResolved || unread(n) > 0 || revealed.id === id || !!understanding?.pinned(n)
  if (listed && !hiddenInEditor(n)) return true
  if (asking.has(id) || askErrors.has(id)) return true
  const check = understanding?.threadStatus(n)
  return !!check?.checking || !!check?.error
}

/** Everything the thread's comments show, as one string: the comments are rebuilt only when it changes. */
function renderKey(n: Note): string {
  const d = n.data
  const run = asking.get(d.id)
  return JSON.stringify([
    stepLinkOf(n) ? `${tour.key}|${walk.touring()}|${tour.stepId}` : '',
    d.messages.length, d.messages[d.messages.length - 1]?.body.length, d.status, d.stale, d.events?.length, d.target,
    missing.has(d.id), pastEnd.get(d.id), d.stale && openDoc(docUri(n))?.version,
    seenCount(n), visitFrom.get(d.id), expanded.has(d.id), otherBranch(n) ?? '', d.anchor.text.length,
    run?.text.length, run?.activity, JSON.stringify(understanding?.threadStatus(n) ?? null),
    // Claude's elapsed seconds are shown in 5 s steps.
    asking.has(d.id) && Math.floor((Date.now() - run!.started) / 5000),
    askErrors.get(d.id),
  ])
}

/** The thread's context value, for its menus: "note;open;stale;asking;check" (the parts that apply). */
function threadContext(n: Note): string {
  const parts = ['note', n.data.status, n.data.stale ? 'stale' : '', asking.has(n.data.id) ? 'asking' : '', understanding?.isCheck(n) ? 'check' : '']
  return parts.filter(Boolean).join(';')
}

/**
 * The thread's header says only what the gutter can't — a file or folder note, or that its file is missing — then the
 * note's first line (never VS Code's "Start discussion"). Severity, session, "n new" and "resolved" are in the list
 * and VS Code's own state.
 */
function threadLabel(n: Note): string {
  const { target, file } = n.data
  const firstLine = (n.data.messages[0]?.body ?? '').split('\n').find((l) => l.trim()) ?? ''
  const label = [
    target === 'folder' ? `Folder ${file}/` : target ? 'File note' : '',
    missing.has(n.data.id) ? `⚠ ${target === 'folder' ? 'folder' : 'file'} not found` : '',
    shortQ(firstLine.replace(/\*\*|`/g, ''), 80),
  ].filter(Boolean).join(' · ')
  // VS Code shows a label HTML-escaped ("&lt;"): <, > and & as look-alikes (as on the step card).
  return label.replace(/</g, '‹').replace(/>/g, '›').replace(/&/g, '＆')
}

export function noteOfThread(t: vscode.CommentThread): Note | undefined {
  for (const [id, th] of threads) if (th === t) return byId(id)
  return undefined
}
