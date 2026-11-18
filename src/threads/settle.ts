// When comment threads may be made and changed: too soon, and VS Code loops (see SETTLE_MS).

import * as vscode from 'vscode'

/**
 * A new comment thread's first state reaches the workbench ~100 ms after it was made (the extension host debounces
 * thread updates, and every change restarts that wait). Until then the thread has no collapsed state there, and a
 * second comment widget for it (another editor on the file, the editor showing it again) makes VS Code loop between
 * the thread's collapsibleState and initialCollapsibleState ("Maximum call stack size exceeded"; the widget ends up
 * collapsed). So a thread gets all its properties in the tick it is made, then nothing for SETTLE_MS; and a property is
 * only ever set when its value changes (setting an equal one still counts as a change and restarts the wait).
 */
const SETTLE_MS = 160

const bornAt = new WeakMap<vscode.CommentThread, number>()

export function newThread(c: vscode.CommentController, uri: vscode.Uri, range: vscode.Range, comments: vscode.Comment[] = []): vscode.CommentThread {
  // Made with its comments: an empty thread's first state shows a reply box, which the window may give the keyboard.
  const t = c.createCommentThread(uri, range, comments)
  bornAt.set(t, Date.now())
  return t
}

/**
 * When each file's editor last came on screen. A thread made for a file whose editor is just opening gets a second
 * widget from that editor before its first state arrives (the same loop): it is made once the editor has settled.
 */
export const editorShownAt = new Map<string, number>()

let visibleBefore = new Set<string>()

export function noteVisibleEditors(): void {
  const now = new Set(vscode.window.visibleTextEditors.map((e) => e.document.uri.toString()))
  for (const u of now) if (!visibleBefore.has(u)) editorShownAt.set(u, Date.now())
  visibleBefore = now
}

/** Milliseconds until a thread may be made on this file (0: now). */
export function editorSettling(uri: vscode.Uri): number {
  noteVisibleEditors()
  const t = editorShownAt.get(uri.toString())
  return t === undefined ? 0 : Math.max(0, t + SETTLE_MS - Date.now())
}

/** Milliseconds until a thread made just now may change again (0: it may). */
export function settling(t: vscode.CommentThread): number {
  const b = bornAt.get(t)
  return b === undefined ? 0 : Math.max(0, b + SETTLE_MS - Date.now())
}

/** Calls waiting for a thread or an editor to settle, by key: the last call per key wins. */
const settleLater = new Map<string, NodeJS.Timeout>()

/** `fn` runs in `ms` (this key's earlier call, if still waiting, is dropped). */
function later(key: string, ms: number, fn: () => void): void {
  clearTimeout(settleLater.get(key))
  settleLater.set(key, setTimeout(() => { settleLater.delete(key); fn() }, ms))
}

/** While the file's editor is settling (editorSettling), `fn` runs once it has: true. Settled: false, nothing runs. */
export function afterEditorSettles(uri: vscode.Uri, key: string, fn: () => void): boolean {
  const wait = editorSettling(uri)
  if (wait) later(key, wait, fn)
  return wait > 0
}

/** Runs `fn` now, or once the thread has settled (the last call per key wins). */
export function whenSettled(t: vscode.CommentThread, key: string, fn: () => void): void {
  const wait = settling(t)
  clearTimeout(settleLater.get(key))
  settleLater.delete(key)
  if (wait) later(key, wait, fn)
  else fn()
}

/** Sets a thread property only when it differs (each set restarts the extension host's update wait). */
export function setThread<K extends 'canReply' | 'contextValue' | 'label' | 'collapsibleState'>(t: vscode.CommentThread, k: K, v: vscode.CommentThread[K]): void {
  if (t[k] !== v) t[k] = v
}

export function setCollapse(t: vscode.CommentThread, v: vscode.CommentThreadCollapsibleState, key: string): void {
  whenSettled(t, `collapse:${key}`, () => setThread(t, 'collapsibleState', v))
}
