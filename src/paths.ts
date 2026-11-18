// Paths of notes and of the files steps name, without the vscode API (unit-tested in test/paths.test.ts and
// test/journeySteps.test.ts).
import * as path from 'path'

/** Backslashes as slashes, no trailing slash: `C:\\w\\` → `C:/w`. */
export const slashPath = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

/** The last part of a slash path (`a/b/c.ts` → `c.ts`). */
export const baseName = (p: string) => p.split('/').pop()!

/** A path from the root (`/x`) or a drive (`C:`, `C:\x`): not relative to a workspace folder. */
export const isAbsolutePath = (p: string) => p.startsWith('/') || /^[a-zA-Z]:/.test(p)

/**
 * The note's "file" relative to the workspace folder `root`, or why it can't be used. An absolute path inside the
 * folder becomes relative; anything outside the folder is refused, so a note file can never make the extension read
 * (and copy into the note) a file like../../.ssh/id_rsa.
 */
export function placeFile(root: string, file: string): string | { error: string } {
  const r = slashPath(root)
  let f = file.replace(/\\/g, '/')
  if (r && f.startsWith(r + '/')) f = f.slice(r.length + 1)
  else if (isAbsolutePath(f)) return { error: `"file" is outside this workspace: ${file}` }
  const n = path.posix.normalize(f).replace(/^(\.\/)+/, '')
  if (n === '..' || n.startsWith('../')) return { error: `"file" is outside this workspace: ${file}` }
  if (n === '.' || !n) return { error: '"file" must be a file, not the workspace folder' }
  return n
}

/** A folder's path with one trailing slash: what the paths of the files in it start with. */
export const dirPath = (folder: { path: string }) => folder.path.replace(/\/?$/, '/')

/** `uri`'s path relative to `folder`, or undefined when it is not inside it. */
export function pathIn(folder: { path: string }, uri: { path: string }): string | undefined {
  const base = dirPath(folder)
  return uri.path.startsWith(base) ? uri.path.slice(base.length) : undefined
}
