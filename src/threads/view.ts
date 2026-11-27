// The notes' comment threads in the editor: one per note shown, kept in step with the note. One ThreadView, made by
// the threads' activate, owns every thread and what they show; each change to a thread goes through the settle gate.

import * as vscode from 'vscode'
import { byId, visibleNotes } from '../notes/visible'
import { cfg } from '../platform/settings'
import { docUri } from '../notes/location'
import { unread } from '../notes/seen'
import { hiddenInEditor, type NotesApi, onlyThese, selection } from '../notes/model'
import type { Note } from '../notes/store'
import type { WorkspaceEvents } from '../platform/events'
import { commentsOf, threadLabel, threadRange } from './comments'
import { type ShownBecause, shownBecause, threadContextValue } from './context'
import type { ThreadContributions } from './rows'
import type { SettleGate, SettlingThread } from './settle'

export class ThreadView implements vscode.Disposable {
  /** note id -> its thread */
  private readonly threads = new Map<string, SettlingThread>()
  /** What each thread last showed (commentsOf's key). */
  private readonly shown = new Map<string, string>()
  /** Notes whose whole thread the person asked to see; others hide older read replies. */
  private readonly expanded = new Set<string>()
  /** Notes opened (a row clicked) before their thread was made (its editor was still opening): made expanded. */
  private readonly openWhenMade = new Set<string>()

  constructor(
    private readonly controller: vscode.CommentController,
    private readonly gate: SettleGate,
    private readonly contributions: ThreadContributions,
  ) {}

  /** The note's thread, when it is drawn. */
  get(id: string): vscode.CommentThread | undefined {
    return this.threads.get(id)?.thread
  }

  has(id: string): boolean {
    return this.threads.has(id)
  }

  noteOf(t: vscode.CommentThread): Note | undefined {
    for (const [id, th] of this.threads) if (th.thread === t) return byId(id)
    return undefined
  }

  /** The whole thread shown ("Show N earlier replies"). */
  expand(id: string): void {
    this.expanded.add(id)
    this.resync(id)
  }

  /** Older read replies hidden again ("Show fewer"). */
  collapse(id: string): void {
    this.expanded.delete(id)
    this.resync(id)
  }

  /** The note's thread opens expanded when it is made (a row clicked while its editor was still opening). */
  expandOnCreate(id: string): void {
    this.openWhenMade.add(id)
  }

  /** It was made already: no longer waiting. */
  cancelExpandOnCreate(id: string): boolean {
    return this.openWhenMade.delete(id)
  }

  /** Why the note has a thread (undefined: it has none). */
  shownBecause(n: Note): ShownBecause | undefined {
    const f = this.contributions.facts(n)
    return shownBecause({
      open: n.data.status === 'open',
      showResolved: cfg().get<boolean>('showResolvedInEditor', false),
      unread: unread(n) > 0,
      revealed: selection().revealed === n.data.id,
      pinned: f.pinned,
      hidden: hiddenInEditor(n),
      working: f.working,
      failed: f.failed,
    })
  }

  /** The note's thread made, changed or removed to match the note. */
  sync(n: Note): void {
    const id = n.data.id
    if (!this.shownBecause(n)) { this.drop(id); return }
    const made = this.ensureThread(n)
    if (!made) return
    // Made before and still settling: its first state is on the way to the workbench; this update follows once there.
    if (!made.fresh && made.t.settling) { made.t.whenSettled(() => this.resync(id)); return }
    this.updateThread(made.t, n)
  }

  /** Every note shown has its thread, and no thread is left of a note gone. Returns the ids of the notes shown. */
  syncAll(): Set<string> {
    const notes = visibleNotes()
    for (const n of notes) this.sync(n)
    const ids = new Set(notes.map((n) => n.data.id))
    for (const id of [...this.threads.keys()]) if (!ids.has(id)) this.drop(id)
    for (const id of [...this.expanded]) if (!byId(id)) this.expanded.delete(id)
    return ids
  }

  /** The threads follow the notes (only the notes that changed, when that is all a change is about), and the
   *  editors that come on screen (a thread on a file just shown waits for its editor to settle). */
  follow(model: NotesApi, events: WorkspaceEvents): vscode.Disposable {
    return vscode.Disposable.from(
      model.onDidChange((c) => {
        const ids = onlyThese(c)
        if (!ids) { this.syncAll(); return }
        for (const id of ids) this.resync(id)
      }),
      events.onDidChangeVisibleEditors(() => this.gate.noteVisibleEditors()),
    )
  }

  dispose(): void {
    for (const t of this.threads.values()) t.dispose()
    this.threads.clear()
    this.shown.clear()
  }

  private resync(id: string): void {
    const n = byId(id)
    if (n) this.sync(n)
  }

  private drop(id: string): void {
    this.threads.get(id)?.dispose()
    this.threads.delete(id)
    this.shown.delete(id)
  }

  /** The note's thread, made (or made again: its file changed) when needed; undefined while its editor settles (it is
   *  made then). `fresh`: made in this tick, so it takes all its properties now. */
  private ensureThread(n: Note): { t: SettlingThread; fresh: boolean } | undefined {
    const id = n.data.id
    const uri = docUri(n)
    const t = this.threads.get(id)
    if (t && t.uri.toString() === uri.toString()) return { t, fresh: false }
    if (this.gate.afterEditorSettles(uri, `new:${id}`, () => this.resync(id))) return undefined
    this.drop(id)
    const made = this.gate.settlingThread(this.controller, uri, threadRange(n), id)
    // Set in the tick it is made: the note just opened opens expanded; any other starts collapsed.
    made.thread.collapsibleState = this.openWhenMade.delete(id)
      ? vscode.CommentThreadCollapsibleState.Expanded
      : vscode.CommentThreadCollapsibleState.Collapsed
    this.threads.set(id, made)
    return { t: made, fresh: true }
  }

  /** The thread's range, comments, state, menus and header set to the note's (each only when it differs). */
  private updateThread(t: SettlingThread, n: Note): void {
    const id = n.data.id
    t.setRange(threadRange(n))
    // Setting comments redraws the widget: only when something shown changed (an agent reply elsewhere must be cheap).
    const { comments, key } = commentsOf(n, { thread: t.thread, expanded: this.expanded.has(id), contributions: this.contributions })
    if (this.shown.get(id) !== key) { t.setComments(comments); this.shown.set(id, key) }
    t.set('canReply', true)
    const f = this.contributions.facts(n)
    // A check thread is never "resolved" in the editor: VS Code collapses a thread when it is, and the grade must stay in
    // view; and resolving a thread that has the keyboard selects its lines in the code, where typing would replace them.
    const resolved = n.data.status === 'resolved' && !f.neverResolved
    t.setState(resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved)
    t.set('contextValue', threadContextValue(n.data.status, !!n.data.stale, f.words))
    t.set('label', threadLabel(n))
  }
}
