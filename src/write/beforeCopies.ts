// A refreshed journey's text before the refresh, as a read-only document for "Show changes" (the left side of the
// diff). Kept in memory, the last few only: no file is written for it.
import * as vscode from 'vscode'

const SCHEME = 'code-notes-before'
/** Before-copies kept: an older one's diff shows an empty left side. */
const KEPT = 10

class BeforeCopies implements vscode.TextDocumentContentProvider {
  private readonly texts = new Map<string, string>()

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.texts.get(uri.query) ?? ''
  }

  /** `text` kept under `id`: the document's URI (named `name`). */
  keep(id: string, name: string, text: string): vscode.Uri {
    this.texts.set(id, text)
    for (const old of [...this.texts.keys()].slice(0, -KEPT)) this.texts.delete(old)
    return vscode.Uri.from({ scheme: SCHEME, path: `/${name}`, query: id })
  }
}

export const beforeCopies = new BeforeCopies()

/** write/index.ts only. */
export const registerBeforeCopies = () => vscode.workspace.registerTextDocumentContentProvider(SCHEME, beforeCopies)
