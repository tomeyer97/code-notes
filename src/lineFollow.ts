// Remembered lines following edits, without the vscode API (unit-tested in test/lineFollow.test.ts and
// test/anchor.test.ts). One edit type for all of them: a note's or a step's range is moved and stretched by `shift`;
// a single line (a beat's, a code link's, a value hint's) is moved by `shiftLine` and then found again by its text
// (`findLine`, `followLine`). VS Code's change events become LineEdits in followEdits.ts.
import type { Loc } from './anchor'

/** One text edit, in line terms: lines [startLine, endLine] replaced by text with `newLines` line breaks. */
export interface LineEdit { startLine: number; startChar: number; endLine: number; endChar: number; newLines: number }

/** Follows an edit made in the editor: lines above shift the note, edits inside it grow or shrink it. */
export function shift(loc: Loc, e: LineEdit): Loc {
  const delta = e.newLines - (e.endLine - e.startLine)
  // Entirely above the note, or an insertion at the very start of its first line (pushes it down).
  if (e.endLine < loc.start || (e.endLine === loc.start && e.endChar === 0 && e.startLine < loc.start) ||
      (e.startLine === loc.start && e.endLine === loc.start && e.startChar === 0 && e.endChar === 0 && e.newLines > 0)) {
    return { start: loc.start + delta, end: loc.end + delta }
  }
  if (e.startLine > loc.end) return loc
  // Overlaps the note.
  const start = Math.min(loc.start, e.startLine)
  return { start, end: Math.max(start, loc.end + delta) }
}

/** An edit that replaces the whole note and more (a file reloaded from disk, a big paste): tracking it is meaningless. */
export function swallows(loc: Loc, e: LineEdit): boolean {
  return e.startLine <= loc.start && e.endLine >= loc.end && e.endLine - e.startLine > loc.end - loc.start
}

/**
 * Where 0-based `line` is after `edits`: lines above it inserted or removed move it; an edit on the line itself
 * leaves it where it is (its text is checked again by findLine). Unlike `shift`, an edit on the line never moves it.
 */
export function shiftLine(line: number, edits: LineEdit[]): number {
  let d = 0
  for (const e of edits) if (e.endLine < line) d += e.newLines - (e.endLine - e.startLine)
  return Math.max(0, line + d)
}

/** How far from the written line the same text is still taken for it (the code moved). */
const SAME_TEXT_RADIUS = 400

/** Where `text` is now: the written line if it still says so, else the nearest line that does; -1: gone. 0-based. */
export function findLine(lines: string[], line: number, text: string): number {
  const want = text.trim()
  if (!want) return -1
  const at = line - 1
  if (lines[at]?.trim() === want) return at
  for (let d = 1; d <= SAME_TEXT_RADIUS; d++) {
    if (lines[at - d]?.trim() === want) return at - d
    if (lines[at + d]?.trim() === want) return at + d
  }
  return -1
}

/** Where a remembered line is after edits: found again by its text near where it moved to, else -1; no text: shifted. 0-based. */
export function followLine(lines: string[], line: number, text: string, edits: LineEdit[]): number {
  const moved = shiftLine(line, edits)
  if (!text.trim()) return Math.min(moved, Math.max(0, lines.length - 1))
  return findLine(lines, moved + 1, text)
}
