// A short word in the status bar after a notes command: "no note here", "Reopened …", "Undone: …". Gone by itself.

import * as vscode from 'vscode'

/** How long a hint stays. */
export const HINT_MS = 3000

/** `text` in the status bar with a codicon (`info`: nothing was done, and why). */
export function hint(text: string, icon = 'info', ms = HINT_MS): vscode.Disposable {
  return vscode.window.setStatusBarMessage(`$(${icon}) ${text}`, ms)
}
