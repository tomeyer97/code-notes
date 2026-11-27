// Short texts of the Code Notes rows that follow rules worth testing. No vscode here.
import type { Note } from '../notes/store'
import { baseName } from '../core/paths'
import { rangeLabel } from '../core/text'

/** Where a note's row says it is. Under a file row its lines (`L12`); alone, the row names the file: `app.ts:12`, a
 *  whole-file note `app.ts`, a folder note `src/`. */
export function whereLabel(n: Note, alone: boolean): string {
  if (!alone) return rangeLabel(n)
  const base = baseName(n.data.file)
  if (n.data.target === 'folder') return `${base}/`
  if (n.data.target) return base
  return `${base}:${n.data.range.start}`
}

/** Folders shown in a file row's description, the last ones ("…/api/v2"). */
const DIRS_SHOWN = 2

/** A file's folder as its row shows it: `src/api`, or its last folders (`…/api/v2`); '' at the top. */
export function shortDir(file: string): string {
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : ''
  const segs = dir.split('/').filter(Boolean)
  return segs.length > DIRS_SHOWN ? `…/${segs.slice(-DIRS_SHOWN).join('/')}` : dir
}
