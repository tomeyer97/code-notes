// New notes: on lines (the editor's comment box, or a one-line box), on a whole file or folder.

import * as vscode from 'vscode'
import { Loc } from '../anchor'
import { cfg, controller, KEY, log, now, showError, store } from '../app'
import { askClaude, claudeMode } from '../ask'
import { findCli } from '../claude'
import { commitInfo, me } from '../identity'
import { refreshAll } from '../refresh'
import { setSeen } from '../seen'
import { folderName, Note, NoteData } from '../store'
import { captureAnchor, inNotesFolder, otherAnchor, rangeLines, relPath, selectedLines } from '../threads/anchoring'
import { shape, shapeOf } from '../threads/threads'
import { card } from '../tour/tour'
import { diskLines, docLines, wfs } from '../wfs'
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

export async function createNote(doc: vscode.TextDocument, loc: Loc, body: string, selection?: NoteData['selection'], extra?: Record<string, unknown>): Promise<Note | undefined> {
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri)
  if (!folder) { void showError('Code Notes: save the file inside the open folder to add notes to it.'); return undefined }
  if (inNotesFolder(doc.uri)) { vscode.window.setStatusBarMessage('$(info) No notes on Code Notes\' own files', 3000); return undefined }
  const at = now()
  const id = newId()
  const n: Note = {
    folder, uri: store.uriFor(folder, id),
    data: {
      id, file: relPath(folder, doc.uri), range: { start: loc.start + 1, end: loc.end + 1 },
      anchor: { ...captureAnchor(docLines(doc), loc.start, loc.end), ...(await commitInfo(folder)) },
      ...(selection ? { selection } : {}), status: 'open', stale: false, createdAt: at,
      messages: [{ author: me(), role: 'human', body, at }],
      ...(extra ? { extra } : {}),
    },
  }
  // Written on unsaved text (a typo being fixed): the saved lines count too, so undoing the typo isn't "stale".
  if (doc.isDirty && doc.uri.scheme === 'file') {
    const disk = await diskLines(doc.uri)
    if (disk && disk.length === doc.lineCount && loc.end < disk.length) {
      const a = captureAnchor(disk, loc.start, loc.end)
      if (a.text !== n.data.anchor.text) otherAnchor.set(id, { ...n.data.anchor, ...a })
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

/** Commenting ranges: none, except while a note box is being opened (`addingUntil`). */
let addingUntil = 0

/** When VS Code last asked for a file's commenting ranges: an editor that has just opened asks before it draws its threads. */
export const rangesAskedAt = new Map<string, number>()

export const rangeProvider: vscode.CommentingRangeProvider = {
  provideCommentingRanges: (doc) => {
    rangesAskedAt.set(doc.uri.toString(), Date.now())
    const adding = Date.now() < addingUntil && vscode.workspace.getWorkspaceFolder(doc.uri) && doc.lineCount && !inNotesFolder(doc.uri)
    return adding ? [new vscode.Range(0, 0, doc.lineCount - 1, 0)] : []
  },
}

let rangesOff: NodeJS.Timeout | undefined

async function allowComments(ms = 1500): Promise<void> {
  addingUntil = Date.now() + ms
  controller.commentingRangeProvider = rangeProvider
  const t0 = Date.now()
  clearTimeout(rangesOff)
  rangesOff = setTimeout(() => { controller.commentingRangeProvider = rangeProvider }, ms + 50)
  // At least 120 ms (the comment widgets settle), and until the window has asked for the file's ranges again: over a
  // slow link that round trip takes longer, and the box would not open.
  const u = vscode.window.activeTextEditor?.document.uri.toString()
  for (let k = 0; k < 100 && u && (rangesAskedAt.get(u) ?? 0) < t0; k++) await new Promise((r) => setTimeout(r, 10))
  const left = 120 - (Date.now() - t0)
  if (left > 0) await new Promise((r) => setTimeout(r, left))
}

/** Ctrl+< C: VS Code's inline comment box at the selection (multi-line, markdown, Ctrl+Enter saves). */
export async function addNote(): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor) return noEditor()
  if (inNotesFolder(editor.document.uri)) { vscode.window.setStatusBarMessage('$(info) No notes on Code Notes\' own files', 3000); return }
  if (!vscode.workspace.getWorkspaceFolder(editor.document.uri) || editor.document.isUntitled) {
    void showError('Code Notes: save the file inside the open folder to add notes to it.')
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
  if (!uri || !folder) { vscode.window.setStatusBarMessage('$(info) Pick a file or folder in the Explorer first', 3000); return undefined }
  if (inNotesFolder(uri) || uri.path.endsWith(`/${folderName()}`)) { vscode.window.setStatusBarMessage('$(info) No notes on Code Notes\' own files', 3000); return undefined }
  const file = relPath(folder, uri)
  if (!file || file === '.') { vscode.window.setStatusBarMessage('$(info) Notes go on a file or a folder inside the workspace', 3000); return undefined }
  let isDir = false
  try { isDir = !!((await wfs.stat(uri)).type & vscode.FileType.Directory) } catch { return undefined }
  const body = text ?? (await vscode.window.showInputBox({ title: `Note on ${isDir ? 'folder' : 'file'} ${file}${isDir ? '/' : ''}`, placeHolder: 'Your note or question', ignoreFocusOut: true }))?.trim()
  if (!body) return undefined
  const at = now()
  const id = newId()
  const n: Note = {
    folder, uri: store.uriFor(folder, id),
    data: {
      id, file, range: { start: 1, end: 1 }, anchor: { text: '', before: '', after: '' }, target: isDir ? 'folder' : 'file',
      status: 'open', stale: false, createdAt: at, messages: [{ author: me(), role: 'human', body, at }],
    },
  }
  if (!(await save(n))) return undefined
  await reveal(n)
  if (claudeMode() === 'always') await askClaude(n)
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
  if (!body) { t.dispose(); vscode.window.setStatusBarMessage('$(info) Empty note: not saved', 3000); return undefined } // no empty shell
  const doc = await vscode.workspace.openTextDocument(t.uri)
  const r = t.range ?? new vscode.Range(0, 0, 0, 0)
  // From "Ask about this step": the note says which step it is about.
  const ask = card.asks.get(t)
  card.asks.delete(t)
  t.dispose()
  return createNote(doc, rangeLines(doc, r), ask ? `${body}\n\n${ask.about}` : body, ask ? undefined : partialSelection(doc, r), ask ? { journey: ask.link } : undefined)
}

/** A question from a step: one button, "Ask"; Claude answers when it is set up, else the agent reads the note. */
export const askFromThread = async (reply: vscode.CommentReply) => {
  const n = await noteFromNewThread(reply)
  if (n && claudeMode() !== 'off' && findCli(cfg().get<string>('claude.path') || undefined)) await askClaude(n)
}

export const createFromThread = async (reply: vscode.CommentReply) => {
  const n = await noteFromNewThread(reply)
  if (n && claudeMode() === 'always') await askClaude(n)
}
