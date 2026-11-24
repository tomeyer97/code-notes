// What is known about where a step is besides the journey file, kept in one place: anchors taken from the code,
// the reader's own edits, the code as those edits left it, and renamed files. The journey file is never written.
// No vscode here: unit-tested through the step locator.
import type { JStep } from '../core/format/journeyModel'
import type { Loc } from '../core/anchors/anchor'
import { AnyAnchor, CompactAnchor, compactOf } from '../core/anchors/compact'
import { STATE, StateStore, StoredRecord } from '../platform/state'
import { captureStepAnchor, isEmptyAnchor, placeStep, StepAt } from './steps'
import { FileInFolderKey, StepKey } from './keys'

/**
 * Which place wins, when a step is found again in its file's lines (`resolve`):
 *
 *   1. the journey's own anchor (or one `captured` from the code) finds it fresh  -> there; `followed` is forgotten
 *   2. else the reader's version (`followed`, from an earlier edit) finds it fresh -> there
 *   3. else the reader edited its lines just now (`edited`)                        -> on those lines; they become `followed`
 *   4. else                                                                        -> what the anchor found (changed, removed)
 *
 * `edited` lasts until the next resolve of that step. `renamed` (files the steps followed through a rename) is not a
 * place but a file: the locator starts there. `followed` and `renamed` are stored across reloads.
 */
export class StepPlaceStore {
  /** Anchors taken from the code for steps written without one (in memory only). */
  private readonly captured = new Map<StepKey, AnyAnchor>()
  /** Where the reader's own edits (typing, an applied fix) took a step's lines (0-based), until it is resolved. */
  private readonly edited = new Map<StepKey, Loc>()
  /** A step's code as the reader's own edits left it. */
  private readonly followed: StoredRecord<CompactAnchor>
  /** Files steps followed through a rename: the new path. Per file, every journey with a step there alike. */
  private readonly renamed: StoredRecord<string>

  /** No `stored` (unit tests): nothing is kept across reloads. */
  constructor(stored: StateStore = new StateStore()) {
    this.followed = stored.record(STATE.journeyFollowed)
    this.renamed = stored.record(STATE.journeyRenames)
  }

  /** The step's anchor: from the journey file, or the one captured from the code. */
  anchorOf(k: StepKey, s: JStep): AnyAnchor | undefined {
    return s.anchor ?? this.captured.get(k)
  }

  /** The step's anchor to look for in `lines`: written without one, it is taken from the code there, once. */
  anchorIn(k: StepKey, s: JStep, lines: string[]): AnyAnchor {
    const a = this.anchorOf(k, s)
    if (a && !isEmptyAnchor(a)) return a
    const taken = captureStepAnchor(lines, s.range)
    this.captured.set(k, taken)
    return taken
  }

  // ---------- the reader's edits ----------

  /** Where the reader's edits took the step's lines (0-based), if they touched them. */
  editedAt(k: StepKey): Loc | undefined { return this.edited.get(k) }
  setEdited(k: StepKey, loc: Loc): void { this.edited.set(k, loc) }
  forgetEdit(k: StepKey): void { this.edited.delete(k) }

  /**
   * Where the step is in `lines`, given what its anchor found (`found`) and the reader's edits (the order is in the
   * class doc). The reader's edits keep the step on the code they edited, never "out of date" for it.
   */
  async resolve(k: StepKey, found: StepAt, lines: string[], was: StepAt, fileField: { file?: string }): Promise<StepAt> {
    const mine = this.followed.get(k)
    const ed = this.edited.get(k)
    this.edited.delete(k)
    if (!found.stale) {
      if (mine) await this.followed.set(k, undefined)
      return found
    }
    if (mine) {
      const onMine = placeStep(lines, mine, was, fileField)
      if (!onMine.stale) return onMine
    }
    const edited = ed && ed.end >= ed.start && ed.end < lines.length ? compactOf(lines, ed.start, ed.end) : undefined
    if (!ed || !edited) return found
    await this.followed.set(k, edited)
    return { start: ed.start + 1, end: ed.end + 1, stale: false, ...fileField }
  }

  // ---------- renamed files ----------

  renamedTo(k: FileInFolderKey): string | undefined { return this.renamed.all()[k] }
  setRenamed(k: FileInFolderKey, file: string | undefined): Promise<void> { return this.renamed.set(k, file) }
}
