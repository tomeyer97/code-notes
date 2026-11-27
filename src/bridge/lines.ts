// The two requests about lines of a file: reveal (lit, with the controller's text beside them) and note.add.
import * as vscode from 'vscode'
import type { NoteAddParams, RevealParams } from '../protocol/bridge'
import { addNote, claudeLinks } from './ports'
import { resolveFile } from './files'
import { HandlerContext, RequestError } from './failure'

/** The editor showing `uri` now, if any (for the lines' real count after they were lit). */
const editorOf = (uri: vscode.Uri) => vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString())

async function fileOf(file: string) {
  const uri = await resolveFile(file)
  if (!uri) throw new RequestError(`file not found: ${file}`)
  return uri
}

/** Opens the file, lights the lines (Back above them) and shows the text under them until dismissed. */
export async function reveal(p: RevealParams, c: HandlerContext): Promise<{ start: number; end: number }> {
  const uri = await fileOf(p.file)
  await claudeLinks().light(uri, p.start - 1, p.end - 1)
  const lines = editorOf(uri)?.document.lineCount ?? p.end
  const end = Math.max(p.start, Math.min(p.end, lines))
  if (p.text) c.callout.show(uri, p.start - 1, end - 1, p.text, c.controller.name)
  else c.callout.dismiss()
  return { start: p.start, end }
}

/** A note on the lines, the controller its author; its id (the body is not sent back). */
export async function addNoteAt(p: NoteAddParams, c: HandlerContext): Promise<{ id: string; file: string }> {
  const uri = await fileOf(p.file)
  const made = await addNote({ uri, start: p.start, end: p.end, body: p.body, session: p.session, author: c.controller.name })
  if ('error' in made) throw new RequestError(made.error)
  return made
}
