// A note's lines found again in its file as it is now (anchor.ts finds them): followed, gone stale, or come back.
// Each step works out where the note is, then applies it; a change is announced once, at the end.

import * as vscode from 'vscode'
import { anchor, Loc } from '../core/anchors/anchor'
import { log, notes } from '../app'
import { linesOfUri } from '../platform/documents'
import { statOf } from '../platform/exists'
import { NoteData } from '../core/format/noteModel'
import { Note } from './store'
import { Anchor, anchorAt, docUri, neverAnchored, pathUri, placement, saveIfClean } from './location'
import { locOf, range1Of, sameRange, withinLines } from './model/lines'
import { notesChanged, notesModel } from './model'
import { suggestionUndone, swapToUndone } from './suggestion'

/** Where anchor `a` is in `lines` now, near `tracked` (0-based). */
export const findAnchor = (lines: string[], a: Anchor, tracked: Loc, hint?: number) => anchor(lines, a.text, a.before, a.after, tracked, hint)

/** Where a line note is now: its lines and whether stale; `missing`: its file is gone; `undone`: an applied
 *  suggestion was undone (or redone), and the anchor from before found it. */
export interface Found { loc: Loc; stale: boolean; missing: boolean; undone?: Anchor }

/** Where the note is in `lines` (undefined: its file is gone), near `tracked`. Changes nothing. */
export function locate(n: Note, lines: string[] | undefined, tracked = locOf(n.data.range), hint = tracked.start): Found {
  if (!lines) return { loc: tracked, stale: true, missing: true }
  const { loc, stale } = findAnchor(lines, n.data.anchor, tracked, hint)
  if (stale) {
    const back = suggestionUndone(n, (a) => findAnchor(lines, a, tracked, hint))
    if (back) return { loc: back.loc, stale: false, missing: false, undone: back.anchor }
  }
  return { loc, stale, missing: false }
}

/** Puts the note where `f` says; true if its lines or its stale flag changed. */
export function applyFound(n: Note, f: Found): boolean {
  if (f.missing) placement.setMissing(n.data.id); else placement.found(n.data.id, true)
  if (f.undone) swapToUndone(n, f.undone)
  const range = range1Of(f.loc)
  if (sameRange(range, n.data.range) && !!n.data.stale === f.stale) return false
  logMove(n, range, f.stale, !f.missing)
  n.data.range = range
  n.data.stale = f.stale
  return true
}

/** Re-anchors a note against its file's current lines (undefined: gone); true if its lines or stale flag changed. */
export const reanchor = (n: Note, lines: string[] | undefined, tracked?: Loc, hint?: number) => applyFound(n, locate(n, lines, tracked, hint))

/** The log line of a note that went stale, came back, or followed its code to `range`. */
function logMove(n: Note, range: NoteData['range'], stale: boolean, fileThere: boolean): void {
  const { id, file } = n.data
  if (stale !== !!n.data.stale) {
    const why = !stale ? 'no longer stale' : fileThere ? 'stale (the code changed)' : 'stale (file not found)'
    log.info(`note ${id}: ${why} · ${file}`)
  } else if (range.start !== n.data.range.start) {
    log.info(`note ${id}: followed its code ${file} L${n.data.range.start} → L${range.start}`)
  }
}

/** A file or folder note: only whether its file/folder is still there. True if that changed. */
export async function checkTarget(n: Note): Promise<boolean> {
  const st = await statOf(pathUri(n))
  const isFolder = !!st && !!(st.type & vscode.FileType.Directory)
  const there = !!st && (n.data.target === 'folder' ? isFolder : !isFolder)
  const was = placement.missing(n.data.id)
  if (there) placement.found(n.data.id); else placement.setMissing(n.data.id)
  n.data.stale = !there
  if (was !== !there) log.info(`note ${n.data.id}: ${there ? 'found' : 'not found'} · ${n.data.file}`)
  return was !== !there
}

/** Every note against its file as it is now: file and folder notes checked, line notes re-anchored. Announced once. */
export async function reanchorAll(): Promise<void> {
  const changed: string[] = []
  await notesModel().batch(async () => {
    const byFile = new Map<string, Note[]>()
    for (const n of notes()) {
      if (n.data.target) { if (await checkTarget(n)) changed.push(n.data.id); continue }
      const k = docUri(n).toString()
      byFile.set(k, [...(byFile.get(k) ?? []), n])
    }
    for (const [uri, list] of byFile) {
      const lines = await linesOfUri(vscode.Uri.parse(uri))
      for (const n of list) if (await reanchorInFile(n, lines ?? (await fixPrefix(n)))) changed.push(n.data.id)
    }
    if (changed.length) notesChanged({ kind: 'placed', ids: changed })
  })
}

/**
 * A note whose file isn't there: an agent may have written the path with the workspace folder's name in front
 * ("runner/src/x.ts"). Fixed when that file exists: its lines; else undefined.
 */
async function fixPrefix(n: Note): Promise<string[] | undefined> {
  const prefix = `${n.folder.name}/`
  if (!n.data.file.startsWith(prefix)) return undefined
  const fixed = n.data.file.slice(prefix.length)
  const lines = await linesOfUri(vscode.Uri.joinPath(n.folder.uri, fixed))
  if (!lines) return undefined
  log.appendLine(`note ${n.data.id}: path "${n.data.file}" fixed to "${fixed}"`)
  n.data.file = fixed
  placement.found(n.data.id, true)
  return lines
}

/** One line note against its file's `lines` (undefined: the file is gone); true if anything about it changed. */
async function reanchorInFile(n: Note, lines: string[] | undefined): Promise<boolean> {
  if (lines && n.data.range.start > lines.length) return markPastEnd(n, lines.length)
  if (placement.pastEnd(n.data.id) !== undefined) placement.found(n.data.id)
  if (lines && neverAnchored(n.data.anchor)) {
    await adoptAnchor(n, lines)
    return true
  }
  if (!reanchor(n, lines)) return false
  await saveIfClean(n)
  return true
}

/** The note's lines start past the end of its file (`lineCount` lines): stale, said once. */
async function markPastEnd(n: Note, lineCount: number): Promise<boolean> {
  const was = placement.pastEnd(n.data.id)
  placement.setPastEnd(n.data.id, lineCount)
  if (n.data.stale) return was !== lineCount
  n.data.stale = true
  log.warn(`note ${n.data.id}: line ${n.data.range.start} is past the end of ${n.data.file} (${lineCount} lines)`)
  await saveIfClean(n)
  return true
}

/** A note an agent created without an anchor: take it from the code at its range, once. */
async function adoptAnchor(n: Note, lines: string[]): Promise<void> {
  const { start, end } = withinLines(locOf(n.data.range), lines.length)
  n.data.anchor = await anchorAt(lines, start, end, n.folder)
  await saveIfClean(n)
}
