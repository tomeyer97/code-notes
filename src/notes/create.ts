// New notes: on lines (the editor's comment box, or a one-line box), on a whole file or folder.

import * as vscode from 'vscode'
import { Loc } from '../anchor'
import { KEY, log, now, showError, store } from '../app'
import { askClaude } from '../ask/run'
import { askAlways, askOnQuestion } from '../ask/settings'
import { me } from '../identity'
import { refreshAll } from '../refresh'
import { setSeen } from '../seen'
import { captureAnchor, NoteData } from '../noteModel'
import { folderName, Note } from '../store'
import { anchorAt, inNotesFolder, otherAnchor, rangeLines, relPath, selectedLines } from './location'
import { card } from '../tour/tour'
import { diskLines, docLines, wfs } from '../wfs'
import { shape, shapeOf } from './changedOnDisk'
import { allowComments } from './commentRanges'
import { reveal } from './reveal'

/** The note box's words. */
export const NOTE_OPTIONS: vscode.CommentOptions = { prompt: 'Reply', placeHolder: 'Note or reply…' }

export function newId(): string {
  return now().replace(/[-:]/g, '').replace('T', '-').slice(0, 15) + '-' + Math.random().toString(36).slice(2, 6)
}

/** The selected text, when the selection is only part of its lines (a token, an expression). */
export function partialSelection(doc: vscode.TextDocument, r: vscode.Range): NoteData['selection'] {
  if (r.isEmpty) return undefined
  const lead = (line: number, col: number) => !doc.lineAt(line).text.slice(0, col).trim()
  const whole = lead(r.start.line, r.start.character) && (lead(r.end.line, r.end.character) || r.end.character >= doc.lineAt(r.end.line).text.length)
  if (whole) return undefined
  const text = doc.getText(r)
  return text.trim() ? { text, startCol: r.start.character, endCol: r.end.character } : undefined
}

/** Where a new note is: its file and lines with their anchor, and the exact text or whole file/folder it is about. */
type Place = Pick<NoteData, 'file' | 'range' | 'anchor'> & Partial<Pick<NoteData, 'selection' | 'target'>>

/**
 * A new open note in `folder`, your `body` its first message. `place()` says where (it may ask git: its id and time
 * are taken first); `extra`: what the caller keeps with it. The fields are in the order they are written to the file.
 */
async function newNote(folder: vscode.WorkspaceFolder, body: string, place: () => Place | Promise<Place>, extra?: Record<string, unknown>): Promise<Note> {
  const at = now()
  const id = newId()
  return {
    folder, uri: store.uriFor(folder, id),
    data: {
      id, ...(await place()), status: 'open', stale: false, createdAt: at,
      messages: [{ author: me(), role: 'human', body, at }],
      ...(extra ? { extra } : {}),
    },
  }
}

/** How long a "no note here" message stays in the status bar. */
const SAY_MS = 3000

/** A short "no" in the status bar. */
const say = (text: string) => vscode.window.setStatusBarMessage(`$(info) ${text}`, SAY_MS)

const SAVE_INSIDE = 'Code Notes: save the file inside the open folder to add notes to it.'

/** Code Notes' own files (the notes, their README) take no notes: says so. True when `refused`. */
function ownFiles(refused: boolean): boolean {
  if (refused) say("No notes on Code Notes' own files")
  return refused
}

export async function createNote(doc: vscode.TextDocument, loc: Loc, body: string, selection?: NoteData['selection'], extra?: Record<string, unknown>): Promise<Note | undefined> {
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri)
  if (!folder) { void showError(SAVE_INSIDE); return undefined }
  if (ownFiles(inNotesFolder(doc.uri))) return undefined
  const n = await newNote(folder, body, async () => ({
    file: relPath(folder, doc.uri), range: { start: loc.start + 1, end: loc.end + 1 },
    anchor: await anchorAt(docLines(doc), loc.start, loc.end, folder),
    ...(selection ? { selection } : {}),
  }), extra)
  // Written on unsaved text (a typo being fixed): the saved lines count too, so undoing the typo isn't "stale".
  if (doc.isDirty && doc.uri.scheme === 'file') {
    const disk = await diskLines(doc.uri)
    if (disk && disk.length === doc.lineCount && loc.end < disk.length) {
      const a = captureAnchor(disk, loc.start, loc.end)
      if (a.text !== n.data.anchor.text) otherAnchor.set(n.data.id, { ...n.data.anchor, ...a })
    }
  }
  if (!(await save(n))) return undefined
  // No "Note saved": the note is there, in its thread and the list.
  return n
}

/** A new note saved, and read (its first message is yours): stored in the background (a round trip to the window),
 *  read back from memory at once. */
async function save(n: Note): Promise<boolean> {
  if (!(await store.save(n))) return false
  void setSeen([[n.data.id, 1]]).then(undefined, (e) => log.error(`seen: ${e}`))
  shape.set(n.data.id, shapeOf(n))
  refreshAll()
  return true
}

/** Ctrl+< C: VS Code's inline comment box at the selection (multi-line, markdown, Ctrl+Enter saves). */
export async function addNote(): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor) return noEditor()
  if (ownFiles(inNotesFolder(editor.document.uri))) return
  if (!vscode.workspace.getWorkspaceFolder(editor.document.uri) || editor.document.isUntitled) {
    void showError(SAVE_INSIDE)
    return
  }
  await allowComments()
  try { await vscode.commands.executeCommand('workbench.action.addComment') } catch { await addQuickNote(); return }
  // VS Code scrolls to the top of the selection, but the note box opens under its LAST line: on a big block that is
  // off screen. Bring the last line (and the box below it) into view, unless it already is with room to spare.
  const end = selectedLines(editor).end
  const showBox = () => {
    const vis = editor.visibleRanges[0]
    const roomBelow = vis ? vis.end.line - end : 0
    if (!vis || end < vis.start.line || roomBelow < 12) {
      editor.revealRange(new vscode.Range(end, 0, end, 0), vscode.TextEditorRevealType.InCenter)
    }
  }
  showBox()
  setTimeout(showBox, 150) // again once the widget has been laid out
}

/** No text editor (the first click on "Add a Note"): say what to do instead of doing nothing. */
async function noEditor(): Promise<void> {
  const pick = await vscode.window.showInformationMessage(`Open a file and select code, then press ${KEY} C.`, 'Open File…')
  if (pick) await vscode.commands.executeCommand('workbench.action.quickOpen')
}

/** A note on a whole file or folder: from the explorer, the editor tab, or the palette (the active file). */
export async function addPathNote(uri?: vscode.Uri, text?: string): Promise<Note | undefined> {
  uri = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri
  const folder = uri && vscode.workspace.getWorkspaceFolder(uri)
  if (!uri || !folder) { say('Pick a file or folder in the Explorer first'); return undefined }
  if (ownFiles(inNotesFolder(uri) || uri.path.endsWith(`/${folderName()}`))) return undefined
  const file = relPath(folder, uri)
  if (!file || file === '.') { say('Notes go on a file or a folder inside the workspace'); return undefined }
  let isDir = false
  try { isDir = !!((await wfs.stat(uri)).type & vscode.FileType.Directory) } catch { return undefined }
  const title = `Note on ${isDir ? 'folder' : 'file'} ${file}${isDir ? '/' : ''}`
  const body = text ?? (await vscode.window.showInputBox({ title, placeHolder: 'Your note or question', ignoreFocusOut: true }))?.trim()
  if (!body) return undefined
  // No lines: range 1-1, no anchor (neither is written to the file).
  const n = await newNote(folder, body, () => ({ file, range: { start: 1, end: 1 }, anchor: { text: '', before: '', after: '' }, target: isDir ? 'folder' : 'file' }))
  if (!(await save(n))) return undefined
  await reveal(n)
  if (askAlways()) await askClaude(n)
  return n
}

/** A one-line note in the command bar (Enter saves). */
export async function addQuickNote(): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor) return noEditor()
  const loc = selectedLines(editor)
  const doc = editor.document
  const box = vscode.window.createInputBox()
  box.title = `Note on ${vscode.workspace.asRelativePath(doc.uri)} ${loc.start === loc.end ? `line ${loc.start + 1}` : `lines ${loc.start + 1}–${loc.end + 1}`}`
  box.placeholder = 'Your note or question'
  box.prompt = doc.lineAt(loc.start).text.trim().slice(0, 80) // the code it is about; VS Code adds the Enter/Esc hint
  box.ignoreFocusOut = true
  box.onDidChangeValue(() => { box.validationMessage = undefined })
  box.onDidAccept(async () => {
    const body = box.value.trim()
    if (!body) { box.validationMessage = 'Type a note first (Esc cancels)'; return }
    box.hide()
    await createNote(doc, loc, body, partialSelection(doc, editor.selection))
  })
  box.onDidHide(() => box.dispose())
  box.show()
}

/** New-note boxes being saved: a second Ctrl+Enter meanwhile (the box keeps its text until the save returns) makes no second note. */
const creating = new WeakSet<vscode.CommentThread>()

export const noteFromNewThread = async (reply: vscode.CommentReply): Promise<Note | undefined> => {
  const t = reply.thread
  if (creating.has(t)) return undefined
  creating.add(t)
  const body = reply.text.trim()
  if (!body) { t.dispose(); say('Empty note: not saved'); return undefined } // no empty shell
  const doc = await vscode.workspace.openTextDocument(t.uri)
  const r = t.range ?? new vscode.Range(0, 0, 0, 0)
  // From "Ask about this step": the note says which step it is about.
  const ask = card.asks.get(t)
  card.asks.delete(t)
  t.dispose()
  if (ask) return createNote(doc, rangeLines(doc, r), `${body}\n\n${ask.about}`, undefined, { journey: ask.link })
  return createNote(doc, rangeLines(doc, r), body, partialSelection(doc, r))
}

/** A question from a step: one button, "Ask"; Claude answers when it can (not only when set to always: see askOnQuestion). */
export const askFromThread = async (reply: vscode.CommentReply) => {
  const n = await noteFromNewThread(reply)
  if (n && askOnQuestion()) await askClaude(n)
}

/** A note from the editor's comment box (Ctrl+Enter): Claude answers it when set to always. */
export const createFromThread = async (reply: vscode.CommentReply) => {
  const n = await noteFromNewThread(reply)
  if (n && askAlways()) await askClaude(n)
}
