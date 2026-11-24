// New notes: on lines (the editor's comment box, or a one-line box), on a whole file or folder.

import * as vscode from 'vscode'
import { store } from './ports'
import { Loc } from '../core/anchors/anchor'
import { chordKey } from '../platform/chordKey'
import { log, now } from '../platform/host'
import { showError } from '../platform/run'
import { askClaude } from '../ask/run'
import { askAlways, askOnQuestion } from '../ask/settings'
import { me } from './identity'
import { captureAnchor, NoteData } from '../core/format/noteModel'
import { Note } from './store'
import { folderName, inNotesFolder } from './notesFolder'
import { rangeLines, selectedLines } from './location'
import { alternateAnchor } from './alternateAnchor'
import { relPath } from '../platform/documents'
import { diskLines } from '../platform/documents'
import { wfs } from '../platform/workspaceFs'
import { allowComments } from './commentRanges'
import { reveal } from './reveal'
import { fireAndForget } from '../platform/run'
import { linesAt } from './place'
import { hint } from './hint'
import { OncePerSubmit } from './submit'

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
    folder, uri: store().uriFor(folder, id),
    data: {
      id, ...(await place()), status: 'open', stale: false, createdAt: at,
      messages: [{ author: me(), role: 'human', body, at }],
      ...(extra ? { extra } : {}),
    },
  }
}

const OWN_FILES = "No notes on Code Notes' own files"
const SAVE_INSIDE = 'save the file inside the open folder to add notes to it.'

/** Why no note can go on `uri` (undefined: one can): it is one of Code Notes' own files (the notes, their README),
 *  or not saved inside the open folder. */
function canAnnotate(uri: vscode.Uri, untitled = false): string | undefined {
  if (inNotesFolder(uri)) return OWN_FILES
  if (untitled || !vscode.workspace.getWorkspaceFolder(uri)) return SAVE_INSIDE
  return undefined
}

/** Says why no note was made (canAnnotate): an error for a file outside the folder, else a short hint. */
function refuse(why: string): undefined {
  if (why === SAVE_INSIDE) fireAndForget(showError(why), 'create: showError')
  else hint(why)
  return undefined
}

const created = new vscode.EventEmitter<Note>()
/** A note was made and saved by the person (its first message is theirs). */
export const onDidCreateNote = created.event

export async function createNote(doc: vscode.TextDocument, loc: Loc, body: string, selection?: NoteData['selection'], extra?: Record<string, unknown>): Promise<Note | undefined> {
  const why = canAnnotate(doc.uri)
  if (why) return refuse(why)
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri)!
  const n = await newNote(folder, body, async () => ({ ...(await linesAt(doc, loc, folder)), ...(selection ? { selection } : {}) }), extra)
  await rememberSavedText(n, doc, loc)
  if (!(await save(n))) return undefined
  // No "Note saved": the note is there, in its thread and the list.
  return n
}

/** Written on unsaved text (a typo being fixed): the saved lines are its alternate anchor, so undoing the typo isn't
 *  "stale". */
async function rememberSavedText(n: Note, doc: vscode.TextDocument, loc: Loc): Promise<void> {
  if (!doc.isDirty || doc.uri.scheme !== 'file') return
  const disk = await diskLines(doc.uri)
  if (!disk || disk.length !== doc.lineCount || loc.end >= disk.length) return
  const a = captureAnchor(disk, loc.start, loc.end)
  if (a.text !== n.data.anchor.text) alternateAnchor.set(n.data.id, { ...n.data.anchor, ...a })
}

/** A new note saved; who follows new notes hears of it (the person has read it: seen.ts). */
async function save(n: Note): Promise<boolean> {
  if (!(await store().save(n))) return false
  created.fire(n)
  return true
}

/** Where a new note came from: what follows its making (Claude asked or not, the note opened). */
type Origin =
  /** The editor's comment box (Ctrl+Enter): Claude answers when set to always. */
  | 'box'
  /** A question from a step's box ("Ask"): Claude answers when it can (askOnQuestion), not only when set to always. */
  | 'question'
  /** A note on a whole file or folder: it is opened, then Claude answers when set to always. */
  | 'path'

/** What follows the making of a note, by where it came from (one place for these rules). */
async function afterCreate(n: Note, origin: Origin): Promise<void> {
  if (origin === 'path') await reveal(n)
  if (origin === 'question' ? askOnQuestion() : askAlways()) await askClaude(n)
}

/** VS Code scrolls to the top of the selection but opens the box under its LAST line: the box's line is brought into
 *  view unless at least this many lines are on screen below it (about the box's height with a few lines typed). */
const BOX_ROOM_LINES = 12
/** The box's widget is laid out this long after the command returns (it may push the code down): looked at again
 *  then. */
const BOX_LAYOUT_MS = 150

/** Ctrl+< C: VS Code's inline comment box at the selection (multi-line, markdown, Ctrl+Enter saves). */
export async function addNote(): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor) return noEditor()
  const why = canAnnotate(editor.document.uri, editor.document.isUntitled)
  if (why) return refuse(why)
  await allowComments()
  try {
    await vscode.commands.executeCommand('workbench.action.addComment')
  } catch (e) {
    log().warn(`the comment box did not open (${e}): the one-line box instead`)
    await addQuickNote()
    return
  }
  // On a big block the box is off screen: bring the last line (and the box below it) into view.
  const end = selectedLines(editor).end
  const showBox = () => {
    const vis = editor.visibleRanges[0]
    const roomBelow = vis ? vis.end.line - end : 0
    if (!vis || end < vis.start.line || roomBelow < BOX_ROOM_LINES) {
      editor.revealRange(new vscode.Range(end, 0, end, 0), vscode.TextEditorRevealType.InCenter)
    }
  }
  showBox()
  setTimeout(showBox, BOX_LAYOUT_MS)
}

/** No text editor (the first click on "Add a Note"): say what to do instead of doing nothing. */
async function noEditor(): Promise<void> {
  const pick = await vscode.window.showInformationMessage(`Open a file and select code, then press ${chordKey()} C.`, 'Open File…')
  if (pick) await vscode.commands.executeCommand('workbench.action.quickOpen')
}

/** A note on a whole file or folder: from the explorer, the editor tab, or the palette (the active file). */
export async function addPathNote(uri?: vscode.Uri, text?: string): Promise<Note | undefined> {
  uri = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri
  const folder = uri && vscode.workspace.getWorkspaceFolder(uri)
  if (!uri || !folder) { hint('Pick a file or folder in the Explorer first'); return undefined }
  // The notes folder itself is Code Notes' own too.
  const why = canAnnotate(uri) ?? (uri.path.endsWith(`/${folderName()}`) ? OWN_FILES : undefined)
  if (why) return refuse(why)
  const file = relPath(folder, uri)
  if (!file || file === '.') { hint('Notes go on a file or a folder inside the workspace'); return undefined }
  let isDir = false
  try {
    isDir = !!((await wfs.stat(uri)).type & vscode.FileType.Directory)
  } catch (e) {
    log().info(`no note on ${file}: ${e}`)
    return undefined
  }
  const title = `Note on ${isDir ? 'folder' : 'file'} ${file}${isDir ? '/' : ''}`
  const body = text ?? (await vscode.window.showInputBox({ title, placeHolder: 'Your note or question', ignoreFocusOut: true }))?.trim()
  if (!body) return undefined
  // No lines: range 1-1, no anchor (neither is written to the file).
  const noLines = { range: { start: 1, end: 1 }, anchor: { text: '', before: '', after: '' } }
  const n = await newNote(folder, body, () => ({ file, ...noLines, target: isDir ? 'folder' : 'file' }))
  if (!(await save(n))) return undefined
  await afterCreate(n, 'path')
  return n
}

/** "Note on src/a.ts line 3" / "lines 3–5": the one-line box's title. */
const quickTitle = (doc: vscode.TextDocument, loc: Loc) =>
  `Note on ${vscode.workspace.asRelativePath(doc.uri)} ${loc.start === loc.end ? `line ${loc.start + 1}` : `lines ${loc.start + 1}–${loc.end + 1}`}`

/** A one-line note in the command bar (Enter saves). */
export async function addQuickNote(): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor) return noEditor()
  const loc = selectedLines(editor)
  const doc = editor.document
  const box = vscode.window.createInputBox()
  box.title = quickTitle(doc, loc)
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

/** New-note boxes being saved: a second Ctrl+Enter meanwhile makes no second note. */
const creating = new OncePerSubmit<vscode.CommentThread>()

export const noteFromNewThread = async (reply: vscode.CommentReply): Promise<Note | undefined> => {
  const t = reply.thread
  return creating.run(t, async () => {
    const body = reply.text.trim()
    if (!body) { t.dispose(); hint('Empty note: not saved'); return undefined } // no empty shell
    const doc = await vscode.workspace.openTextDocument(t.uri)
    const r = t.range ?? new vscode.Range(0, 0, 0, 0)
    t.dispose()
    return createNote(doc, rangeLines(doc, r), body, partialSelection(doc, r))
  })
}

/** A question from a step: one button, "Ask". */
export const askFromThread = async (reply: vscode.CommentReply) => {
  const n = await noteFromNewThread(reply)
  if (n) await afterCreate(n, 'question')
}

/** A note from the editor's comment box (Ctrl+Enter). */
export const createFromThread = async (reply: vscode.CommentReply) => {
  const n = await noteFromNewThread(reply)
  if (n) await afterCreate(n, 'box')
}
