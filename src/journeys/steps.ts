import type * as vscode from 'vscode'
import type { Journey, JStep } from '../core/format/journeyModel'
import type { Loc } from '../core/anchors/anchor'
import { AnyAnchor, CompactAnchor, FullAnchor, compactOf, isCompact } from '../core/anchors/compact'
import { captureAnchor } from '../core/format/noteModel'
import { stepFinder } from './stepFinder'

// A loaded journey and where its steps' code is now. No vscode API at run time (unit-tested in test/journeySteps.test.ts):
// the step locator (stepLocator.ts) reads the files and keeps state; these say where a step is in the lines it got.

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
 * A journey file (or a check's tour) as the extension holds it: `folder` and `uri` are where it came from, `at` where
 * each step's code is now. `readError`: the file on disk can't be read now; this is the last good version. `check`:
 * the tour of an understanding check (embedded in the check file `uri`), walked like any journey; the checks' tours
 * are kept apart from the journey files (checkTours.ts) and never listed with them.
 */
export interface LoadedJourney {
  key: string
  folder: vscode.WorkspaceFolder
  uri: vscode.Uri
  j: Journey
  at: StepAt[]
  readError?: string
  check?: { branch: string }
}

/** What the step logic here needs of a loaded journey: its steps as written and where they are now. */
export type JourneySteps = Pick<LoadedJourney, 'j' | 'at'>

/** Step `n` (1-based) as written. */
export const stepOf = (lj: Pick<LoadedJourney, 'j'>, n: number) => lj.j.steps[n - 1]
/** Where step `n` (1-based) is now. */
export const atOf = (lj: Pick<LoadedJourney, 'at'>, n: number) => lj.at[n - 1]

/** The file a step's code is in now. */
export const fileOf = (lj: JourneySteps, n: number) => atOf(lj, n)?.file ?? stepOf(lj, n).file

/** A folder's URI, or anything that prints as one. */
type UriLike = { toString(): string } | string

/** A journey's identity across reloads and file renames within a folder: folder + id. */
export const journeyPosKey = (folder: UriLike, id: string) => `${folder}|${id}`
export const posKey = (lj: LoadedJourney) => journeyPosKey(lj.folder.uri, lj.j.id)

/** The journey `id` in workspace folder `folder` (its uri), else the first with that id: ids are unique only per folder. */
export function journeyById<T extends { j: Pick<Journey, 'id'>; folder: { uri: UriLike } }>(
  list: Iterable<T>, id: string, folder?: string,
): T | undefined {
  const withId = [...list].filter((x) => x.j.id === id)
  return withId.find((x) => `${x.folder.uri}` === folder) ?? withId[0]
}

/** Steps start where their lines were written, nothing found yet. */
export const writtenAt = (j: Journey): StepAt[] => j.steps.map((s) => ({ ...s.range, stale: false }))

/** What makes two anchors the same, per kind: every field (a field added to a kind must be listed). */
const COMPACT_FIELDS = { v: true, head: true, tail: true, lines: true, hash: true, before: true, after: true } satisfies Record<keyof CompactAnchor, true>
const FULL_FIELDS = { text: true, before: true, after: true } satisfies Record<keyof FullAnchor, true>

/** Two anchors say the same about the code (both absent counts). */
export function sameAnchor(a: AnyAnchor | undefined, b: AnyAnchor | undefined): boolean {
  if (!a || !b) return a === b
  if (isCompact(a) || isCompact(b)) {
    if (!isCompact(a) || !isCompact(b)) return false
    return (Object.keys(COMPACT_FIELDS) as (keyof CompactAnchor)[]).every((k) => a[k] === b[k])
  }
  return (Object.keys(FULL_FIELDS) as (keyof FullAnchor)[]).every((k) => a[k] === b[k])
}

/** A step written the same in two versions of a journey: same id, file, written start and anchor. */
function sameStep(p: JStep, s: JStep): boolean {
  return p.id === s.id
    && p.file === s.file
    && p.range.start === s.range.start
    && sameAnchor(p.anchor, s.anchor)
}

/**
 * The same steps as in `prev` (a reload after an unrelated edit to the file, the same check tour again): they keep
 * where they were found.
 */
export function carryPositions(prev: JourneySteps, lj: JourneySteps): void {
  lj.j.steps.forEach((s, i) => {
    const k = prev.j.steps.findIndex((p) => p.id === s.id)
    if (k >= 0 && sameStep(prev.j.steps[k], s)) lj.at[i] = prev.at[k]
  })
}

/**
 * The fields of StepAt the reader is shown (true) or not (`was` follows `now`): a field added to StepAt must be
 * listed here, so sameStepAt can't silently ignore it.
 */
const SHOWN: Record<keyof StepAt, boolean> = { start: true, end: true, stale: true, removed: true, now: true, file: true, was: false }

/** What the reader is shown about a step is the same in `a` and `b`. */
export function sameStepAt(a: StepAt, b: StepAt): boolean {
  return (Object.keys(SHOWN) as (keyof StepAt)[]).every((k) => !SHOWN[k] || a[k] === b[k])
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

/** A StepAt's 1-based lines from a 0-based Loc, and back: the one place lines change base. */
const fromLoc = (l: Loc) => ({ start: l.start + 1, end: l.end + 1 })
const toLoc = (at: StepAt): Loc => ({ start: at.start - 1, end: at.end - 1 })

/** Where a step whose code is gone stays: where it was, inside the file. */
function keptInFile(lines: string[], was: StepAt): { start: number; end: number } {
  const last = Math.max(1, lines.length)
  const start = Math.min(Math.max(1, was.start), last)
  return { start, end: Math.min(Math.max(start, was.end), last) }
}

/** Where anchor `a` finds a step's code in `lines`: fresh, changed (shown at its new place), or removed. */
export function placeStep(lines: string[], a: AnyAnchor, was: StepAt, fileField: { file?: string }): StepAt {
  const p = stepFinder(a).find(lines, toLoc(was))
  switch (p.kind) {
    case 'fresh': return { ...fromLoc(p.loc), stale: false, ...fileField }
    case 'changed': return { ...fromLoc(p.loc), stale: true, ...fileField, was: p.was, now: p.now }
    case 'removed': return { ...(p.loc ? fromLoc(p.loc) : keptInFile(lines, was)), stale: true, removed: true, ...fileField }
    case 'elsewhere': return { ...was, stale: true }
  }
}
