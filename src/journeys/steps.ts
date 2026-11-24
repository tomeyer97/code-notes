import type * as vscode from 'vscode'
import type { Journey, JStep } from '../core/format/journeyModel'
import { anchor } from '../core/anchors/anchor'
import { staleKind } from '../core/anchors/staleDiff'
import { AnyAnchor, compactOf, findCompact, isCompact, toCompact } from '../core/anchors/compact'
import { captureAnchor } from '../core/format/noteModel'

// A loaded journey and where its steps' code is now. No vscode API at run time (unit-tested in test/journeySteps.test.ts):
// the tracker (tracker.ts) reads the files and keeps state; these say where a step is in the lines it got.

/**
 * Where a step's code is now: 1-based lines; `stale`: its code can't be found (changed, deleted, or the file is gone);
 * `file`: where the file went when it was renamed; unset: the step's own `file`.
 */
export interface StepAt {
  start: number; end: number; stale: boolean; file?: string
  /** Stale: its code is gone from here (`removed`, the card goes to the top of the file, nothing is lit), or it
   *  was edited (`was` → `now`, a diff on the card like a stale note's:). */
  removed?: boolean; was?: string; now?: string
}

/**
 * `readError`: the file on disk can't be read now; this is the last good version. `check`: the tour of an
 * understanding check (embedded in the check file `uri`): walked like any journey, never listed with them.
 */
export interface LoadedJourney { key: string; folder: vscode.WorkspaceFolder; uri: vscode.Uri; j: Journey; at: StepAt[]; readError?: string; check?: { branch: string } }

/** Step `n` (1-based) as written. */
export const stepOf = (lj: Pick<LoadedJourney, 'j'>, n: number) => lj.j.steps[n - 1]
/** Where step `n` (1-based) is now. */
export const atOf = (lj: Pick<LoadedJourney, 'at'>, n: number) => lj.at[n - 1]

/** The file a step's code is in now. */
export const fileOf = (lj: Pick<LoadedJourney, 'j' | 'at'>, n: number) => atOf(lj, n)?.file ?? stepOf(lj, n).file

/** A journey's identity across reloads and file renames within a folder: folder + id. */
export const posKey = (lj: LoadedJourney) => `${lj.folder.uri.toString()}|${lj.j.id}`

/** The journey `id` in workspace folder `folder` (its uri), else the first with that id: ids are unique only per folder. */
export function journeyById<T extends { j: Pick<Journey, 'id'>; folder: { uri: { toString(): string } } }>(
  list: Iterable<T>, id: string, folder?: string,
): T | undefined {
  const withId = [...list].filter((x) => x.j.id === id)
  return withId.find((x) => x.folder.uri.toString() === folder) ?? withId[0]
}

/** Steps start where their lines were written, nothing found yet. */
export const writtenAt = (j: Journey): StepAt[] => j.steps.map((s) => ({ ...s.range, stale: false }))

/**
 * The same steps as in `prev` (a reload after an unrelated edit to the file, the same check tour again): they keep
 * where they were found. Same step: same id, file, written start and anchor.
 */
export function carryPositions(prev: LoadedJourney, lj: LoadedJourney): void {
  lj.j.steps.forEach((s, i) => {
    const k = prev.j.steps.findIndex((p) => p.id === s.id)
    const p = prev.j.steps[k]
    if (p && p.file === s.file && p.range.start === s.range.start && JSON.stringify(p.anchor) === JSON.stringify(s.anchor)) lj.at[i] = prev.at[k]
  })
}

/** What the reader is shown about a step is the same in `a` and `b` (`was` follows `now`). */
export function sameStepAt(a: StepAt, b: StepAt): boolean {
  return a.start === b.start && a.end === b.end && a.stale === b.stale && a.removed === b.removed && a.now === b.now && a.file === b.file
}

/** No anchor, or one with nothing in it: the step was written without one. */
export const isEmptyAnchor = (a: AnyAnchor | undefined) => !a || (!isCompact(a) && !a.text && !a.before && !a.after)

/**
 * An anchor taken from the code at the step's written range (for a step written without one): compact; a step on
 * blank lines keeps its text and the lines around it, as a note's anchor does (noteModel.ts captureAnchor).
 */
export function captureStepAnchor(lines: string[], range: JStep['range']): AnyAnchor {
  const st = Math.max(0, Math.min(range.start, lines.length) - 1)
  const en = Math.max(st, Math.min(range.end, lines.length) - 1)
  return compactOf(lines, st, en) ?? captureAnchor(lines, st, en)
}

/** Where anchor `a` finds a step's code in `lines`: fresh, changed (shown at its new place), or removed. */
export function placeStep(lines: string[], a: AnyAnchor, was: StepAt, fileField: { file?: string }): StepAt {
  const c = toCompact(a)
  if (c) {
    // v3 (or v2 read as v3): fresh, changed (shown at its new place), or gone (nothing lit, card in the map).
    const f = findCompact(lines, c, was.start - 1)
    if (f.state === 'gone') {
      const last = Math.max(1, lines.length)
      const start = Math.min(Math.max(1, was.start), last)
      return { start, end: Math.min(Math.max(start, was.end), last), stale: true, removed: true, ...fileField }
    }
    const now: StepAt = { start: f.loc.start + 1, end: f.loc.end + 1, stale: f.state === 'changed', ...fileField }
    if (f.state === 'changed') Object.assign(now, { was: isCompact(a) ? '' : a.text, now: lines.slice(f.loc.start, f.loc.end + 1).join('\n') })
    return now
  }
  // A v2 step on blank lines: only its context to go by (anchor.ts).
  const v2 = a as { text: string; before: string; after: string }
  const r = anchor(lines, v2.text, v2.before, v2.after, { start: was.start - 1, end: was.end - 1 })
  const now: StepAt = { start: r.loc.start + 1, end: r.loc.end + 1, stale: r.stale, ...fileField }
  if (r.stale) Object.assign(now, staleKind(lines, v2, r.loc))
  // It may stay where it is, never move to look-alike code.
  if (!r.stale && r.loc.start !== was.start - 1) return { ...was, stale: true }
  return now
}
