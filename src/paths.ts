// Note paths, without the vscode API (unit-tested in test/).
import * as path from 'path'

/**
 * The note's "file" relative to the workspace folder `root`, or why it can't be used. An absolute path inside the
 * folder becomes relative; anything outside the folder is refused, so a note file can never make the extension read
 * (and copy into the note) a file like../../.ssh/id_rsa.
 */
export function placeFile(root: string, file: string): string | { error: string } {
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '')
  let f = file.replace(/\\/g, '/')
  if (r && f.startsWith(r + '/')) f = f.slice(r.length + 1)
  else if (f.startsWith('/') || /^[a-zA-Z]:/.test(f)) return { error: `"file" is outside this workspace: ${file}` }
  const n = path.posix.normalize(f).replace(/^(\.\/)+/, '')
  if (n === '..' || n.startsWith('../')) return { error: `"file" is outside this workspace: ${file}` }
  if (n === '.' || !n) return { error: '"file" must be a file, not the workspace folder' }
  return n
}
