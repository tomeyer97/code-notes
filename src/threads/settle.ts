// When comment threads may be made and changed: too soon, and VS Code loops (see SettleGate).

import * as vscode from 'vscode'
import { Debouncer } from '../platform/debounce'
import { THREAD_SETTLE_MS } from '../platform/timings'

type ThreadProp = 'canReply' | 'contextValue' | 'label' | 'collapsibleState'

/**
 * A new comment thread's first state reaches the workbench ~100 ms after it was made (the extension host debounces
 * thread updates, and every change restarts that wait). Until then the thread has no collapsed state there, and a
 * second comment widget for it (another editor on the file, the editor showing it again) makes VS Code loop between
 * the thread's collapsibleState and initialCollapsibleState ("Maximum call stack size exceeded"; the widget ends up
 * collapsed). So a thread gets all its properties in the tick it is made, then nothing for THREAD_SETTLE_MS; and a
 * property is only ever set when its value changes (setting an equal one still counts as a change and restarts the
 * wait). The same holds for a thread made on a file whose editor is just opening: it is made once the editor has
 * settled. Everything here can go once VS Code applies a thread's first state before a second widget asks for it.
 *
 * One gate per extension: it knows when each thread was made and each editor shown, and holds the calls waiting for
 * them (cleared when the extension stops).
 */
export class SettleGate implements vscode.Disposable {
  private readonly bornAt = new WeakMap<vscode.CommentThread, number>()
  /** When each file's editor last came on screen. */
  private readonly shownAt = new Map<string, number>()
  private visibleBefore = new Set<string>()
  /** Calls waiting for a thread or an editor to settle, by key: the last call per key wins. */
  private readonly waiting = new Debouncer('threads: after settling')

  constructor(private readonly ms = THREAD_SETTLE_MS) {}

  /** A thread made with its comments (an empty thread's first state shows a reply box, which the window may give
   *  the keyboard). */
  newThread(c: vscode.CommentController, uri: vscode.Uri, range: vscode.Range, comments: vscode.Comment[] = []): vscode.CommentThread {
    const t = c.createCommentThread(uri, range, comments)
    this.bornAt.set(t, Date.now())
    return t
  }

  /** The same, as a thread whose changes go through this gate; `key` names it among the calls waiting. */
  settlingThread(c: vscode.CommentController, uri: vscode.Uri, range: vscode.Range, key: string): SettlingThread {
    return new SettlingThread(this, this.newThread(c, uri, range), key)
  }

  /** The editors on screen now: the ones that just came get their time. */
  noteVisibleEditors(): void {
    const now = new Set(vscode.window.visibleTextEditors.map((e) => e.document.uri.toString()))
    for (const u of now) if (!this.visibleBefore.has(u)) this.shownAt.set(u, Date.now())
    this.visibleBefore = now
  }

  /** When the file's editor last came on screen (`uri` as a string). */
  editorShownAt(uri: string): number | undefined {
    return this.shownAt.get(uri)
  }

  /** Milliseconds until a thread may be made on this file (0: now). */
  editorSettling(uri: vscode.Uri): number {
    this.noteVisibleEditors()
    const t = this.shownAt.get(uri.toString())
    return t === undefined ? 0 : Math.max(0, t + this.ms - Date.now())
  }

  /** Milliseconds until a thread made just now may change again (0: it may). */
  settling(t: vscode.CommentThread): number {
    const b = this.bornAt.get(t)
    return b === undefined ? 0 : Math.max(0, b + this.ms - Date.now())
  }

  /** While the file's editor is settling, `fn` runs once it has: true. Settled: false, nothing runs. */
  afterEditorSettles(uri: vscode.Uri, key: string, fn: () => void): boolean {
    const wait = this.editorSettling(uri)
    if (wait) this.waiting.later(key, wait, fn)
    return wait > 0
  }

  /** Runs `fn` now, or once the thread has settled (the last call per key wins). */
  whenSettled(t: vscode.CommentThread, key: string, fn: () => void): void {
    const wait = this.settling(t)
    this.waiting.cancel(key)
    if (wait) this.waiting.later(key, wait, fn)
    else fn()
  }

  /** The call waiting under `key`, if any, is dropped. */
  cancel(key: string): void {
    this.waiting.cancel(key)
  }

  /** Sets a thread property only when it differs (each set restarts the extension host's update wait). */
  set<K extends ThreadProp>(t: vscode.CommentThread, k: K, v: vscode.CommentThread[K]): void {
    if (t[k] !== v) t[k] = v
  }

  /** The thread collapsed or expanded once it has settled; `key` names it among the calls waiting. */
  setCollapse(t: vscode.CommentThread, v: vscode.CommentThreadCollapsibleState, key: string): void {
    this.whenSettled(t, `collapse:${key}`, () => this.set(t, 'collapsibleState', v))
  }

  /** Every waiting call is dropped. */
  dispose(): void {
    this.waiting.dispose()
  }
}

/** A comment thread whose every change goes through the gate: set only when different, collapsed once settled. */
export class SettlingThread {
  constructor(private readonly gate: SettleGate, readonly thread: vscode.CommentThread, private readonly key: string) {}

  get uri(): vscode.Uri { return this.thread.uri }

  /** Made just now: its first state is still on the way to the workbench. */
  get settling(): boolean { return this.gate.settling(this.thread) > 0 }

  /** `fn` once the thread has settled (now when it has); the last call wins. */
  whenSettled(fn: () => void): void {
    this.gate.whenSettled(this.thread, `sync:${this.key}`, fn)
  }

  set<K extends ThreadProp>(k: K, v: vscode.CommentThread[K]): void {
    this.gate.set(this.thread, k, v)
  }

  setRange(r: vscode.Range): void {
    if (!this.thread.range || !this.thread.range.isEqual(r)) this.thread.range = r
  }

  setState(s: vscode.CommentThreadState): void {
    if (this.thread.state !== s) this.thread.state = s
  }

  setComments(c: vscode.Comment[]): void {
    this.thread.comments = c
  }

  collapse(v: vscode.CommentThreadCollapsibleState): void {
    this.gate.setCollapse(this.thread, v, this.key)
  }

  /** Gone: nothing waits to change it. */
  dispose(): void {
    this.gate.cancel(`sync:${this.key}`)
    this.gate.cancel(`collapse:${this.key}`)
    this.thread.dispose()
  }
}

let current: SettleGate | undefined

/** The extension's gate (made on first use: the step card may use it before the threads started). */
export const settleGate = (): SettleGate => (current ??= new SettleGate())

/** The gate is dropped with what waits on it (the extension stops). */
export function disposeSettleGate(): void {
  current?.dispose()
  current = undefined
}

// The gate's calls as functions, for the step card and the notes' reveal (they make and change threads of their own).

export const newThread = (c: vscode.CommentController, uri: vscode.Uri, range: vscode.Range, comments: vscode.Comment[] = []) =>
  settleGate().newThread(c, uri, range, comments)

/** When each file's editor last came on screen (by its uri as a string). */
export const editorShownAt = { get: (uri: string): number | undefined => settleGate().editorShownAt(uri) }

export const noteVisibleEditors = (): void => settleGate().noteVisibleEditors()

export const editorSettling = (uri: vscode.Uri): number => settleGate().editorSettling(uri)

export const settling = (t: vscode.CommentThread): number => settleGate().settling(t)

export const afterEditorSettles = (uri: vscode.Uri, key: string, fn: () => void): boolean => settleGate().afterEditorSettles(uri, key, fn)

export const whenSettled = (t: vscode.CommentThread, key: string, fn: () => void): void => settleGate().whenSettled(t, key, fn)

export function setThread<K extends ThreadProp>(t: vscode.CommentThread, k: K, v: vscode.CommentThread[K]): void {
  settleGate().set(t, k, v)
}

export const setCollapse = (t: vscode.CommentThread, v: vscode.CommentThreadCollapsibleState, key: string): void =>
  settleGate().setCollapse(t, v, key)
