// The two kinds of anchor a file may hold, told apart by the anchor's own `v` (core/format/VERSIONS.md):
//   full text (no `v`): the whole block and the lines around it; notes write it, journeys still read it (anchor.ts).
//   compact (`v: 3`): the first and last lines, the length and a hash; journeys and the check write it (compact.ts).

/** 0-based, inclusive line range. */
export interface Loc { start: number; end: number }

/** A full-text anchor: the block's text and up to two lines before and after it. */
export interface FullAnchor { text: string; before: string; after: string }

/** A compact anchor (docs/journey-format.md "In the repo"; compact.ts says how it is found again). */
export interface CompactAnchor { v: 3; head: string; tail: string; lines: number; hash: string; before: string; after: string }

/** Either kind, as a journey step, a box or a check question stores it. */
export type Anchor = FullAnchor | CompactAnchor

export const isCompact = (a: Anchor | undefined): a is CompactAnchor => !!a && (a as CompactAnchor).v === 3

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** An anchor as written in a file (full text, or compact); undefined when it is neither. */
export function readAnchor(v: any): Anchor | undefined {
  if (!v || typeof v !== 'object') return undefined
  if (v.v === 3) return readCompact(v)
  return typeof v.text === 'string' ? { text: v.text, before: str(v.before), after: str(v.after) } : undefined
}

/** A compact anchor as written: a head is needed; a missing tail, length or hash is made up from what is there. */
function readCompact(v: any): CompactAnchor | undefined {
  if (typeof v.head !== 'string' || !v.head.trim()) return undefined
  const lines = Number.isInteger(v.lines) && v.lines > 0 ? v.lines : v.head.split('\n').length
  return {
    v: 3,
    head: v.head,
    tail: str(v.tail) || v.head.split('\n').pop(),
    lines,
    hash: str(v.hash),
    before: str(v.before),
    after: str(v.after),
  }
}
