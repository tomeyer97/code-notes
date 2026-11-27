// A step's anchor as one thing that finds the step's code in a file's lines, whichever kind the journey file holds:
// a compact anchor (or a full-text one with code in it, read as compact) is found by compact.ts; a full-text anchor
// on blank lines has only the lines around it to go by (anchor.ts). Lines are 0-based here; placeStep (steps.ts) makes
// a StepAt's 1-based lines. No vscode here: unit-tested.
import { anchor, Loc } from '../core/anchors/anchor'
import { staleKind } from '../core/anchors/staleDiff'
import { AnyAnchor, CompactAnchor, FullAnchor, findCompact, isCompact, toCompact } from '../core/anchors/compact'

/** What a step's anchor found near where the step was. */
export type Placed =
  | { kind: 'fresh'; loc: Loc }
  /** Edited: `was` the anchor's text (empty for a compact anchor, which keeps none), `now` the lines there. */
  | { kind: 'changed'; loc: Loc; was: string; now: string }
  /** Its code is gone; `loc`: where the search ended, none: where the step was. */
  | { kind: 'removed'; loc?: Loc }
  /** Found only somewhere else: a step on blank lines stays where it is, never moves to look-alike lines. */
  | { kind: 'elsewhere' }

export interface StepFinder {
  find(lines: string[], near: Loc): Placed
}

export function stepFinder(a: AnyAnchor): StepFinder {
  if (isCompact(a)) return compactFinder(a, '')
  const c = toCompact(a)
  return c ? compactFinder(c, a.text) : contextFinder(a)
}

function compactFinder(c: CompactAnchor, text: string): StepFinder {
  return {
    find(lines, near) {
      const f = findCompact(lines, c, near.start)
      if (f.state === 'gone') return { kind: 'removed' }
      if (f.state === 'fresh') return { kind: 'fresh', loc: f.loc }
      return { kind: 'changed', loc: f.loc, was: text, now: lines.slice(f.loc.start, f.loc.end + 1).join('\n') }
    },
  }
}

/** A full-text anchor with no code in it (a step on blank lines). */
function contextFinder(a: FullAnchor): StepFinder {
  return {
    find(lines, near) {
      const r = anchor(lines, a.text, a.before, a.after, near)
      if (!r.stale) return r.loc.start === near.start ? { kind: 'fresh', loc: r.loc } : { kind: 'elsewhere' }
      const k = staleKind(lines, a, r.loc)
      if (k.removed) return { kind: 'removed', loc: r.loc }
      return { kind: 'changed', loc: r.loc, was: k.was ?? '', now: k.now ?? '' }
    },
  }
}
