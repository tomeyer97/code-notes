import * as vscode from 'vscode'
import { wfs } from './workspaceFs'

// Folders of JSON files the extension reads one file per item from (notes, journeys): watched for changes, and read
// once at load.

/** Watches `<folder>/<rel>/*.json`: a file created or changed goes to `onFile`, a deleted one to `onDelete`. */
export function watchJsonFiles(folder: vscode.WorkspaceFolder, rel: string, onFile: (u: vscode.Uri) => unknown, onDelete: (u: vscode.Uri) => unknown): vscode.FileSystemWatcher {
  const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, `${rel}/*.json`))
  w.onDidCreate(onFile)
  w.onDidChange(onFile)
  w.onDidDelete(onDelete)
  return w
}

/** The `.json` files in `dir`, by name, and how many entries it has in all; undefined: it can't be read (not there yet). */
export async function jsonFilesIn(dir: vscode.Uri): Promise<{ files: vscode.Uri[]; entries: number } | undefined> {
  let entries: [string, vscode.FileType][]
  try { entries = await wfs.readDirectory(dir) } catch { return undefined }
  const names = entries.filter(([n, t]) => t === vscode.FileType.File && n.endsWith('.json')).map(([n]) => n)
  return { files: names.sort((a, b) => a.localeCompare(b)).map((n) => vscode.Uri.joinPath(dir, n)), entries: entries.length }
}
