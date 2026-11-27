// What a note points at, as its file says and as the disk has it: the folder-note shorthand agents write, and a
// file or folder note fitted to what is really there. Pure.

import type { NoteData } from '../../core/format/noteModel'

/** `{ "file": "src/api", … }` with no range and no target: a folder note when that is a folder (agents leave "target"
 *  out). */
export const isRangelessFileNote = (v: unknown): v is { file: string } => {
  const o = v as Record<string, unknown> | null
  return !!o && typeof o === 'object' && o.range === undefined && o.target === undefined && typeof o.file === 'string'
}

/** The note as what its path is now: a note whose "file" is a folder is a folder note (no lines, no anchor); a
 *  "folder" note on a file is a file note. The same object when it already fits; else a changed copy. */
export function fitTarget(d: NoteData, isDir: boolean): NoteData {
  if (isDir && d.target !== 'folder') {
    const out: NoteData = { ...d, target: 'folder', range: { start: 1, end: 1 }, anchor: { text: '', before: '', after: '' }, stale: false }
    delete out.selection
    return out
  }
  if (!isDir && d.target === 'folder') return { ...d, target: 'file' }
  return d
}
