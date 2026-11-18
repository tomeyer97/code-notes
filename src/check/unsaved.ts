// Which open document holds a file's unsaved edits. No vscode API here (types only; unit-tested in
// test/unsaved.test.ts).
import type { TextDocument } from 'vscode'
import * as path from 'path'

/**
 * The open document of `repo`'s file `f` with unsaved edits (an applied fix edited again), if any. Every open document
 * is looked at, and only the file itself (scheme `file`) counts: a git diff view or another view of the same path has
 * the same fsPath but is never the file Commit & push saves.
 */
export function unsavedIn(docs: readonly TextDocument[], repo: string, f: string): TextDocument | undefined {
  const file = path.join(repo, f)
  return docs.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === file && d.isDirty)
}
