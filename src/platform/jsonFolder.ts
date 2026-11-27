import * as vscode from 'vscode'
import { wfs } from './workspaceFs'
import { baseName, parentDirsGlob } from '../core/paths'
import { fireAndForget } from './run'

// Folders of JSON files the extension reads one file per item from (notes, journeys): watched for changes, read once
// at load, and what a file's name says.

const decoder = new TextDecoder()

/** The last part of `uri`'s path: `20261111-153012-ab12.json`. */
export const fileName = (uri: vscode.Uri) => baseName(uri.path)
/** The file's name without `.json`: a note's id, a journey's fallback name. */
export const jsonName = (uri: vscode.Uri) => fileName(uri).replace(/\.json$/, '')

/** A file's text; undefined when it can't be read (gone, or not a file). */
export async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try { return decoder.decode(await wfs.readFile(uri)) } catch { return undefined }
}

/** What a watched folder's file events go to (a promise's failure is logged). */
export type OnJsonFile = (u: vscode.Uri) => void | PromiseLike<unknown>

/**
 * Watches `<folder>/<rel>/*.json`: a file created or changed goes to `onFile`, a deleted one to `onDelete`. When `rel`
 * (or a folder above it) is created, the files already in it go to `onFile` too: the file watcher starts watching a new
 * folder only after it sees it, so files written right after the folder (`mkdir -p` then a write, a checkout) can come
 * with no event of their own. Hence two watchers: the files, and the folders on the way to them.
 */
export function watchJsonFiles(folder: vscode.WorkspaceFolder, rel: string, onFile: OnJsonFile, onDelete: OnJsonFile): vscode.Disposable {
  const file = (u: vscode.Uri) => fireAndForget(() => onFile(u), `${rel}: read ${fileName(u)}`)
  const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, `${rel}/*.json`))
  w.onDidCreate(file)
  w.onDidChange(file)
  w.onDidDelete((u) => fireAndForget(() => onDelete(u), `${rel}: ${fileName(u)} deleted`))
  const dirs = parentDirsGlob(rel)
  if (!dirs) return w
  const made = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, dirs), false, true, true)
  made.onDidCreate(() => fireAndForget(async () => {
    for (const u of (await jsonFilesIn(vscode.Uri.joinPath(folder.uri, rel)))?.files ?? []) await onFile(u)
  }, `${rel}: read a new folder`))
  return vscode.Disposable.from(w, made)
}

/** The `.json` files in `dir`, by name, and how many entries it has in all; undefined: it can't be read (not there yet). */
export async function jsonFilesIn(dir: vscode.Uri): Promise<{ files: vscode.Uri[]; entries: number } | undefined> {
  let entries: [string, vscode.FileType][]
  try { entries = await wfs.readDirectory(dir) } catch { return undefined }
  const names = entries.filter(([n, t]) => t === vscode.FileType.File && n.endsWith('.json')).map(([n]) => n)
  return { files: names.sort((a, b) => a.localeCompare(b)).map((n) => vscode.Uri.joinPath(dir, n)), entries: entries.length }
}
