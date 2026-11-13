// Pure helpers of the animation's editor side (beats.ts): no imports, unit-tested.

/** How far from the written line the same text is still taken for it (the code moved). */
const NEAR = 400

/** Where `text` is now: the written line if it still says so, else the nearest line that does; -1: gone. 0-based. */
export function findLine(lines: string[], line: number, text: string): number {
  const want = text.trim()
  if (!want) return -1
  const at = line - 1
  if (lines[at]?.trim() === want) return at
  for (let d = 1; d <= NEAR; d++) {
    if (lines[at - d]?.trim() === want) return at - d
    if (lines[at + d]?.trim() === want) return at + d
  }
  return -1
}

/** One edit, as VS Code reports it: the 0-based lines it replaced and the text it put there. */
export interface LineEdit { start: number; end: number; text: string }

/**
 * Where 0-based `line` is after `edits`: lines above it inserted or removed move it; an edit on the line itself
 * leaves it where it is (its text is checked again by findLine).
 */
export function shiftLine(line: number, edits: LineEdit[]): number {
  let d = 0
  for (const e of edits) if (e.end < line) d += e.text.split('\n').length - 1 - (e.end - e.start)
  return Math.max(0, line + d)
}

/** Where a remembered line is after edits: found again by its text near where it moved to, else -1; no text: shifted. 0-based. */
export function followLine(lines: string[], line: number, text: string, edits: LineEdit[]): number {
  const moved = shiftLine(line, edits)
  if (!text.trim()) return Math.min(moved, Math.max(0, lines.length - 1))
  return findLine(lines, moved + 1, text)
}

/** A value hint's value, cut to about `max` characters so the note after it stays on screen. */
export function capValue(v: string, max = 40): string {
  return v.length <= max ? v : `${v.slice(0, max - 1).trimEnd()}…`
}
