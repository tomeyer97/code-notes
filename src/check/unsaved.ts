// Which open document holds a file's unsaved edits. No vscode here: typed by the fields it reads (unit-tested in
// test/unsaved.test.ts with plain objects).
import * as path from 'path'

/** What unsavedIn reads of an open document (a vscode.TextDocument has them). */
export interface OpenDocument {
  uri: { scheme: string; fsPath: string }
  isDirty: boolean
}

/**
 * The open document of `repo`'s file `f` with unsaved edits (an applied fix edited again), if any. Every open document
 * is looked at, and only the file itself (scheme `file`) counts: a git diff view or another view of the same path has
 * the same fsPath but is never the file Commit & push saves.
 */
export function unsavedIn<D extends OpenDocument>(docs: readonly D[], repo: string, f: string): D | undefined {
  const file = path.join(repo, f)
  return docs.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === file && d.isDirty)
}
