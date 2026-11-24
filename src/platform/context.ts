// Context keys (`when` clauses of menus, keys and views): set through here, each value sent once.
import * as vscode from 'vscode'

/** Context keys as last sent: the same value again is not sent (each is a message to the window; some follow the caret). */
const ctxSent = new Map<string, unknown>()

export const setCtx = (k: string, v: unknown): Thenable<unknown> => {
  if (ctxSent.has(k) && ctxSent.get(k) === v) return Promise.resolve(undefined)
  ctxSent.set(k, v)
  return vscode.commands.executeCommand('setContext', k, v)
}
