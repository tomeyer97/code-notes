// A stale note's banner: the file is gone, it is shorter than the note's lines, or the code changed; with what the
// lines were and the buttons (Keep here, Move). No vscode here: unit-tested in test/threadText.test.ts.
import { Cmd } from '../platform/commands'
import { THREAD_LIMITS } from './limits'
import { codeBlock } from './text'
import type { Links } from './links'

/** The first lines, then "… n more". */
function shortLines(lines: readonly string[]): string[] {
  const max = THREAD_LIMITS.bannerLines
  return lines.length > max ? [...lines.slice(0, max), `… ${lines.length - max} more`] : [...lines]
}

/** The note's old code, shortened. */
export const oldCodeBlock = (lines: readonly string[]) => codeBlock(shortLines(lines))

/** Only the lines that changed, as a diff (a one-word change is visible, a 15-line note is not repeated). */
export function diffBlock(del: readonly string[], ins: readonly string[]): string {
  return codeBlock([...shortLines(del).map((l) => `- ${l.trim()}`), ...shortLines(ins).map((l) => `+ ${l.trim()}`)], 'diff')
}

export interface StaleFacts {
  id: string
  file: string
  /** A file or folder note (no lines). */
  wholeFile: boolean
  /** The file is gone. */
  missing: boolean
  /** The file is shorter than the note's lines: its length now. */
  pastEnd?: number
  /** What the lines were (a code or diff block), or '' when there is nothing to show. */
  was: string
  /** The branch the note was written on, when it is not this one. */
  branch?: string
}

const gone = (f: StaleFacts) => `**\`${f.file}\` no longer exists.**`
/** A code block starts on its own line. */
const wasPart = (f: StaleFacts) => (f.was ? `\n\n${f.was}` : '')
const move = (f: StaleFacts, links: Links) => links.to('Move', Cmd.moveToSelection, f.id)

/** The file is gone: a file note just says so; a note on lines shows them and offers Move. */
export function goneBanner(f: StaleFacts, links: Links): string {
  return f.wholeFile ? gone(f) : `${gone(f)}${wasPart(f)}\n\n${move(f, links)}`
}

/** The file is shorter than the note's lines. */
export function shorterBanner(f: StaleFacts & { pastEnd: number }, links: Links): string {
  return `**The code changed since this note** (the file has ${f.pastEnd} lines now).\n\n${move(f, links)}`
}

/** The code changed: one wording, the branch only as a fact; Keep here · Move. */
export function changedBanner(f: StaleFacts, links: Links): string {
  const branch = f.branch ? ` (written on \`${f.branch}\`)` : ''
  return `**The code changed since this note**${branch}.${wasPart(f)}\n\n${links.to('Keep here', Cmd.acceptCode, f.id)} · ${move(f, links)}`
}

export function staleText(f: StaleFacts, links: Links): string {
  if (f.missing) return goneBanner(f, links)
  if (f.pastEnd !== undefined) return shorterBanner({ ...f, pastEnd: f.pastEnd }, links)
  return changedBanner(f, links)
}
