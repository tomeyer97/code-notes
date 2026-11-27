// The notes model: the notes (the store), which of them are listed and how (NotesQuery), which are picked
// (NotesSelection), and one event, onDidChange, that everything showing notes follows: threads, both trees,
// decorations, the badge, the context keys, the tour. A change is announced here, never pushed into the views.

import * as vscode from 'vscode'
import type { Note } from '../store'
import { mergeChanges, NotesChange } from './changes'
import { Filter, GroupMode, NoteFacts, NotesQuery } from './query'
import { NotesSelection } from './selection'

/** What the model is given when the extension starts. */
export interface NotesPorts extends Pick<NoteFacts, 'isCheck' | 'unread' | 'notes'> {
  /** A note by id (any branch's). */
  byId(id: string): Note | undefined
  /** The store's own changes (saves, trash, loads). */
  storeChanges: vscode.Event<NotesChange>
  /** The hidden sessions as stored in the workspace, and storing them. */
  readHidden(): readonly string[]
  writeHidden(names: string[]): Promise<void>
}

export class NotesApi implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<NotesChange>()
  /** Notes changed (or how they are listed): fired once per change, or once per batch. */
  readonly onDidChange = this.emitter.event
  private readonly revealEmitter = new vscode.EventEmitter<Note>()
  /** A note was opened: the views that list it select its row. */
  readonly onDidReveal = this.revealEmitter.event
  readonly selection = new NotesSelection()
  readonly query: NotesQuery
  /** The hidden sessions, read once (write-through). */
  private hidden: Set<string> | undefined
  private batched: NotesChange[] | undefined
  private readonly subscription: vscode.Disposable

  constructor(private readonly ports: NotesPorts) {
    this.query = new NotesQuery({
      isCheck: ports.isCheck, unread: ports.unread, notes: ports.notes,
      revealed: () => this.selection.revealed,
      hiddenSessions: () => this.hiddenSessions(),
    })
    this.subscription = ports.storeChanges((c) => this.changed(c))
  }

  /** Notes changed: everything that shows them follows, now (or at the end of the batch under way). */
  changed(c: NotesChange): void {
    if (this.batched) { this.batched.push(c); return }
    // No ticks on notes that are gone.
    const shown = new Set(this.ports.notes().map((n) => n.data.id))
    this.selection.prune((id) => shown.has(id))
    this.emitter.fire(c)
  }

  /** Runs `fn`; the changes it announces are announced once, when it is done. */
  async batch<T>(fn: () => Promise<T>): Promise<T> {
    if (this.batched) return fn()
    const list: NotesChange[] = (this.batched = [])
    try { return await fn() } finally {
      this.batched = undefined
      if (list.length) this.changed(mergeChanges(list))
    }
  }

  /** The person opened this note (selection.revealed is it now). */
  revealed(n: Note): void { this.revealEmitter.fire(n) }

  hiddenSessions(): ReadonlySet<string> { return (this.hidden ??= new Set(this.ports.readHidden())) }

  /** Stored, then (after `stored`, if given) shown. */
  async setHiddenSessions(names: Iterable<string>, stored?: () => void): Promise<void> {
    this.hidden = new Set(names)
    await this.ports.writeHidden([...this.hidden])
    stored?.()
    this.changed({ kind: 'view' })
  }

  setFilter(f: Filter): void {
    this.query.filter = f
    // No invisible ticks.
    this.selection.prune((id) => { const n = this.ports.byId(id); return !!n && this.query.matches(n) })
    this.changed({ kind: 'view' })
  }

  setShowResolved(on: boolean): void {
    this.query.showResolved = on
    this.changed({ kind: 'view' })
  }

  setGroupMode(m: GroupMode): void {
    this.query.groupMode = m
    this.changed({ kind: 'view' })
  }

  dispose(): void {
    this.subscription.dispose()
    this.emitter.dispose()
    this.revealEmitter.dispose()
  }
}
