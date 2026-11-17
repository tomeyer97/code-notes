import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'

// vscode.workspace.fs, but `file:` URIs go to Node's fs directly. The extension host runs where the files are (over
// Remote-SSH: on the remote machine), while workspace.fs goes through the window and back: one network round trip per
// call, and a folder of notes read one file after the other took a round trip per note. Other schemes (a virtual
// workspace) still go through workspace.fs.

const local = (u: vscode.Uri) => u.scheme === 'file'

/** VS Code's error for a missing file (callers that look at `code` see the same thing either way). */
function wrap(e: unknown, u: vscode.Uri): Error {
  const code = (e as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT') return vscode.FileSystemError.FileNotFound(u)
  if (code === 'EEXIST') return vscode.FileSystemError.FileExists(u)
  if (code === 'EISDIR') return vscode.FileSystemError.FileIsADirectory(u)
  if (code === 'ENOTDIR') return vscode.FileSystemError.FileNotADirectory(u)
  if (code === 'EACCES' || code === 'EPERM') return vscode.FileSystemError.NoPermissions(u)
  return e instanceof Error ? e : new Error(String(e))
}

function typeOf(st: fs.Stats, link = false): vscode.FileType {
  const t = st.isFile() ? vscode.FileType.File : st.isDirectory() ? vscode.FileType.Directory : vscode.FileType.Unknown
  return link ? t | vscode.FileType.SymbolicLink : t
}

async function stat(u: vscode.Uri): Promise<vscode.FileStat> {
  if (!local(u)) return vscode.workspace.fs.stat(u)
  try {
    const l = await fs.promises.lstat(u.fsPath)
    const st = l.isSymbolicLink() ? await fs.promises.stat(u.fsPath) : l
    return { type: typeOf(st, l.isSymbolicLink()), ctime: st.birthtimeMs, mtime: st.mtimeMs, size: st.size }
  } catch (e) { throw wrap(e, u) }
}

async function readFile(u: vscode.Uri): Promise<Uint8Array> {
  if (!local(u)) return vscode.workspace.fs.readFile(u)
  try { return await fs.promises.readFile(u.fsPath) } catch (e) { throw wrap(e, u) }
}

async function writeFile(u: vscode.Uri, content: Uint8Array): Promise<void> {
  if (!local(u)) return vscode.workspace.fs.writeFile(u, content)
  try {
    await fs.promises.mkdir(path.dirname(u.fsPath), { recursive: true })
    await fs.promises.writeFile(u.fsPath, content)
  } catch (e) { throw wrap(e, u) }
}

async function readDirectory(u: vscode.Uri): Promise<[string, vscode.FileType][]> {
  if (!local(u)) return vscode.workspace.fs.readDirectory(u)
  try {
    const ents = await fs.promises.readdir(u.fsPath, { withFileTypes: true })
    return Promise.all(ents.map(async (d): Promise<[string, vscode.FileType]> => {
      if (!d.isSymbolicLink()) return [d.name, d.isFile() ? vscode.FileType.File : d.isDirectory() ? vscode.FileType.Directory : vscode.FileType.Unknown]
      try { return [d.name, typeOf(await fs.promises.stat(path.join(u.fsPath, d.name)), true)] } catch { return [d.name, vscode.FileType.Unknown | vscode.FileType.SymbolicLink] }
    }))
  } catch (e) { throw wrap(e, u) }
}

async function rename(from: vscode.Uri, to: vscode.Uri, o: { overwrite?: boolean } = {}): Promise<void> {
  if (!local(from) || !local(to)) return vscode.workspace.fs.rename(from, to, o)
  try {
    if (!o.overwrite && fs.existsSync(to.fsPath)) throw vscode.FileSystemError.FileExists(to)
    await fs.promises.mkdir(path.dirname(to.fsPath), { recursive: true })
    await fs.promises.rename(from.fsPath, to.fsPath)
  } catch (e) { throw e instanceof vscode.FileSystemError ? e : wrap(e, from) }
}

async function del(u: vscode.Uri, o: { recursive?: boolean } = {}): Promise<void> {
  if (!local(u)) return vscode.workspace.fs.delete(u, o)
  try {
    const st = await fs.promises.lstat(u.fsPath)
    if (st.isDirectory()) await (o.recursive ? fs.promises.rm(u.fsPath, { recursive: true }) : fs.promises.rmdir(u.fsPath))
    else await fs.promises.unlink(u.fsPath)
  } catch (e) { throw wrap(e, u) }
}

async function createDirectory(u: vscode.Uri): Promise<void> {
  if (!local(u)) return vscode.workspace.fs.createDirectory(u)
  try { await fs.promises.mkdir(u.fsPath, { recursive: true }) } catch (e) { throw wrap(e, u) }
}

export const wfs = { stat, readFile, writeFile, readDirectory, rename, delete: del, createDirectory }

/** A document's lines, unsaved edits included. */
export function docLines(doc: vscode.TextDocument): string[] {
  return Array.from({ length: doc.lineCount }, (_, i) => doc.lineAt(i).text)
}

/** A file's lines: its open document's (unsaved edits count), else the disk's. Opens no document (a round trip). */
export async function fileLines(uri: vscode.Uri): Promise<string[] | undefined> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString() && !d.isClosed)
  if (open) return docLines(open)
  try { return new TextDecoder().decode(await readFile(uri)).split(/\r?\n/) } catch { return undefined }
}
