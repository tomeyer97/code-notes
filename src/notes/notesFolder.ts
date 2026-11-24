// The notes folder: which one (the codeNotes.folder setting), where it is in each workspace folder, and what the
// extension keeps in it besides notes (README.md for agents, .gitignore, .trash/).

import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { settingFolder } from '../core/paths'
import { fillReadme, folderProblem } from '../core/format/noteModel'
import { fileName, readText } from '../platform/jsonFolder'
import { cfg } from '../platform/settings'
import { exists } from '../platform/exists'
import { wfs } from '../platform/workspaceFs'

/** A folder setting as read: the folder used, and when the one set can't be used, what was set and why. */
export interface FolderSetting { folder: string; refused?: { set: string; problem: string } }

/** A folder setting (`codeNotes.<key>`), trimmed; `fallback` when it is empty or can't be used (folderProblem). */
export function readFolderSetting(key: string, fallback: string): FolderSetting {
  const v = cfg().get<string>(key) || fallback
  const problem = folderProblem(v)
  return problem ? { folder: fallback, refused: { set: v, problem } } : { folder: v.trim() }
}

/** A folder setting's folder (readFolderSetting). */
export const folderSetting = (key: string, fallback: string): string => readFolderSetting(key, fallback).folder

/** The notes folder when the setting names none (or one that can't be used). */
export const DEFAULT_FOLDER = '.code-notes'

/** The notes folder (codeNotes.folder, default DEFAULT_FOLDER), relative to the workspace folder. */
export const folderName = (): string => settingFolder(folderSetting('folder', DEFAULT_FOLDER))

export const notesDir = (folder: vscode.WorkspaceFolder): vscode.Uri => vscode.Uri.joinPath(folder.uri, folderName())

/** Code Notes' own folder (notes, README): no notes on those. */
export const inNotesFolder = (uri: vscode.Uri) => uri.path.includes(`/${folderName()}/`)

/** Where a note file of `folder` goes when it is deleted (restore brings it back). */
export const trashUri = (folder: vscode.WorkspaceFolder, uri: vscode.Uri) => vscode.Uri.joinPath(notesDir(folder), '.trash', fileName(uri))

/** The README template (media/notes-README.template.md), read once: from out/src/notes/ to the extension's root. */
const README_TEMPLATE = path.join(__dirname, '..', '..', '..', 'media', 'notes-README.template.md')
let readmeTemplate: string | undefined

/** The README the extension writes into the notes folder (named `folder`): the note format, for agents, naming `person`. */
export function agentReadme(person: string, folder: string): string {
  readmeTemplate ??= fs.readFileSync(README_TEMPLATE, 'utf8')
  return fillReadme(readmeTemplate, person, folder)
}

const encoder = new TextEncoder()

/** The README (the format, for agents, naming `person`), written when it says something else. */
export async function writeReadme(folder: vscode.WorkspaceFolder, person: string): Promise<void> {
  const u = vscode.Uri.joinPath(notesDir(folder), 'README.md')
  const want = agentReadme(person, folderName())
  const have = (await readText(u)) ?? '' // none yet: ''
  if (have !== want) await wfs.writeFile(u, encoder.encode(want))
}

/** Out of git: everything. Shared through git: still not the trash (deleted notes). */
export async function writeGitignore(folder: vscode.WorkspaceFolder): Promise<void> {
  const on = cfg().get<boolean>('ignoreInGit', true)
  await wfs.writeFile(vscode.Uri.joinPath(notesDir(folder), '.gitignore'), encoder.encode(on ? '*\n' : '.trash/\n'))
}

/** Before a note is written: the README, and the .gitignore of a folder Code Notes made (or already uses), never
 *  someone else's folder. */
export async function setUpFolder(folder: vscode.WorkspaceFolder, person: string): Promise<void> {
  const dir = notesDir(folder)
  let entries: [string, vscode.FileType][] | undefined
  try { entries = await wfs.readDirectory(dir) } catch { entries = undefined /* a new folder */ }
  const ours = !entries || entries.some(([n]) => n === 'README.md') || entries.every(([n]) => n.endsWith('.json'))
  if (!(await exists(vscode.Uri.joinPath(dir, 'README.md')))) await writeReadme(folder, person)
  if (ours && !(await exists(vscode.Uri.joinPath(dir, '.gitignore')))) await writeGitignore(folder)
}
