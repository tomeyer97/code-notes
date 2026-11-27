// The line part of a path in step text: `:12`, `:12-14` (or an en dash), `#L12`. One grammar, so every regex that
// reads a reference composes it instead of spelling it again. No vscode here: unit-tested.

/** `:12`, `:12-14`, `:12–14` or `#L12`, with named groups `line` and `end` (colon form) or `hashLine` (`#L` form). */
export const LINE_SUFFIX = String.raw`(?::(?<line>\d+)(?:(?<dash>[-–])(?<end>\d+))?|#L(?<hashLine>\d+))`

/** The same grammar without groups: to embed in a regex that has its own (named groups can't repeat in one regex). */
export const LINE_SUFFIX_PLAIN = String.raw`(?::\d+(?:[-–]\d+)?|#L\d+)`

/** The line part at the end of `text`, if any. */
const AT_END = new RegExp(`${LINE_SUFFIX}$`)

/** Where the line part at the end of `text` starts and what it says (undefined: none). */
export interface LineSuffix { index: number; line: number; end?: number; dash?: string; hash: boolean }

export function lineSuffixOf(text: string): LineSuffix | undefined {
  const m = AT_END.exec(text)
  const g = m?.groups
  if (!m || !g) return undefined
  const hash = g.hashLine !== undefined
  return {
    index: m.index,
    line: Number(hash ? g.hashLine : g.line),
    ...(g.end !== undefined ? { end: Number(g.end), dash: g.dash } : {}),
    hash,
  }
}

/** A line part as written: `:12`, `:12-14` (its own dash kept) or `#L12`. */
export function formatLineSuffix(s: Omit<LineSuffix, 'index'>): string {
  if (s.hash) return `#L${s.line}`
  return s.end === undefined ? `:${s.line}` : `:${s.line}${s.dash ?? '-'}${s.end}`
}
