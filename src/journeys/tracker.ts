import * as vscode from 'vscode'
import { fileLines, docLines } from '../platform/documents'
import { JStep } from '../core/format/journeyModel'
import { Loc } from '../core/anchors/anchor'
import { LineEdit, shift, swallows } from '../core/anchors/lineFollow'
import { lineEdits } from '../platform/followEdits'
import { AnyAnchor, CompactAnchor, Found, compactOf, findCompact, toCompact } from '../core/anchors/compact'
import { GitRenameCache } from '../platform/gitRenames'
import { dirPath, pathIn } from '../core/paths'
import { Kept } from '../platform/memento'
import {
  LoadedJourney, StepAt, atOf, captureStepAnchor, fileOf, isEmptyAnchor, placeStep, sameStepAt, stepOf,
} from './steps'

// Where the steps of the loaded journeys are as the code changes: found again in memory (anchor.ts, compact.ts) after
// edits in an editor, changes on disk and renames; the journey file is never written. Loading the journeys is
// journeys.ts (Journeys extends this).

const RENAMED_KEY = 'codeNotes.journeyRenames'
const FOLLOWED_KEY = 'codeNotes.journeyFollowed'
/**
 * How long after the last keystroke an edited document's steps are found again. Not followEdits.ts REFIND_MS (150 ms,
 * for an EditFollower's few remembered lines): this runs the anchor search for every step in the file, with a timer
 * per journey and file (`onDocument`); the two delays are set separately.
 */
const EDIT_SETTLE_MS = 250

export class StepTracker implements vscode.Disposable {
  /** By journey file URI. */
  readonly list = new Map<string, LoadedJourney>()
  /** Steps moved or went stale (no journey file changed). */
  private readonly moved = new vscode.EventEmitter<LoadedJourney>()
  readonly onDidMoveSteps = this.moved.event
  /** Anchors taken from the code for steps written without one (in memory only). */
  private captured = new Map<string, AnyAnchor>()
  /** Where the reader's own edits (typing, an applied fix) took a step's lines, until the step is found again there. */
  private edited = new Map<string, Loc>()
  /** A step's code as the reader's own edits left it (by `stepKey`); the journey file is never written. Dropped once
   *  the journey's own anchor matches again (undo, a refreshed journey). */
  private followed: Kept<CompactAnchor>
  /** Files steps followed through a rename (`renameKey` -> new path); the journey file is never written. */
  private renamed: Kept<string>
  private git = new GitRenameCache()
  /** Edited documents waiting for the typing to stop, by journey and file. */
  private pending = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(protected log: vscode.LogOutputChannel, state?: vscode.Memento) {
    this.followed = new Kept(state, FOLLOWED_KEY)
    this.renamed = new Kept(state, RENAMED_KEY)
  }

  private stepKey(lj: LoadedJourney, n: number): string {
    const s = stepOf(lj, n)
    return `${lj.key}|${s.id}|${s.file}:${s.range.start}`
  }

  /** Per file, not per journey or step: every journey with a step in that file follows the same rename. */
  private renameKey(lj: LoadedJourney, n: number): string { return `${lj.folder.uri.toString()}|${stepOf(lj, n).file}` }

  gitRenames(folder: vscode.WorkspaceFolder, since?: string): Promise<Map<string, string>> { return this.git.get(folder, since) }

  /** Steps that followed a renamed file before a reload: still there. */
  protected restoreRenames(lj: LoadedJourney): void {
    const ren = this.renamed.all()
    lj.j.steps.forEach((s, i) => {
      const f = ren[this.renameKey(lj, i + 1)]
      if (f && !lj.at[i].file && f !== s.file) lj.at[i] = { ...lj.at[i], file: f }
    })
  }

  /** Finds the steps' code again (all of them, or some). True if any moved or changed staleness. */
  async locate(lj: LoadedJourney, only?: (n: number) => boolean, given?: { file: string; lines: string[] }): Promise<boolean> {
    let changed = false
    const cache = new Map<string, string[] | undefined>()
    for (const s of lj.j.steps) {
      if (only && !only(s.n)) continue
      const was = atOf(lj, s.n)
      const file = was.file ?? s.file
      const { lines, gitFile } = await this.linesFor(lj, s.n, file, cache, given)
      const now = lines ? await this.placeIn(lj, s, was, lines, gitFile) : { ...was, stale: true }
      if (sameStepAt(now, was)) continue
      if (now.stale !== was.stale) this.log.info(`journey ${lj.j.id} step ${s.n}: ${now.stale ? 'stale (its code changed or is gone)' : 'found again'} · ${file}`)
      lj.at[s.n - 1] = now
      changed = true
    }
    return changed
  }

  /**
   * The lines of the file step `n` is in (read once per locate; `given`: a document's, as typed). The file is gone:
   * git may know where it went (`git mv`), for every journey alike; `gitFile` says where.
   */
  private async linesFor(lj: LoadedJourney, n: number, file: string, cache: Map<string, string[] | undefined>, given?: { file: string; lines: string[] }): Promise<{ lines?: string[]; gitFile?: string }> {
    let lines = given && given.file === file ? given.lines : cache.get(file)
    if (!lines && !cache.has(file)) { lines = await fileLines(vscode.Uri.joinPath(lj.folder.uri, file)); cache.set(file, lines) }
    if (lines) return { lines }
    const gitFile = await this.git.follow(lj.folder, lj.j.commit, file)
    const moved = gitFile && await fileLines(vscode.Uri.joinPath(lj.folder.uri, gitFile))
    if (!gitFile || !moved) return {}
    cache.set(gitFile, moved)
    this.log.info(`journey ${lj.j.id} step ${n}: ${file} was renamed to ${gitFile} (git)`)
    return { lines: moved, gitFile }
  }

  /** Where step `s` is in its file's `lines`: by its anchor, or where the reader's own edits took it. */
  private async placeIn(lj: LoadedJourney, s: JStep, was: StepAt, lines: string[], gitFile: string | undefined): Promise<StepAt> {
    const ck = this.stepKey(lj, s.n)
    let a = s.anchor ?? this.captured.get(ck)
    // Written without an anchor: taken from the code at its range, once, in memory.
    if (isEmptyAnchor(a)) { a = captureStepAnchor(lines, s.range); this.captured.set(ck, a) }
    const nf = gitFile ?? was.file
    const fileField = nf && nf !== s.file ? { file: nf } : {}
    return this.keepReaderEdits(ck, placeStep(lines, a!, was, fileField), lines, was, fileField)
  }

  /**
   * The reader's own edits: the step stays on the code they edited, never "out of date" for it (their change is what
   * they are reading). Their version is the anchor from then on, until the journey's own matches again.
   */
  private async keepReaderEdits(ck: string, now: StepAt, lines: string[], was: StepAt, fileField: { file?: string }): Promise<StepAt> {
    const mine = this.followed.get(ck)
    const ed = this.edited.get(ck)
    this.edited.delete(ck)
    // The journey's own anchor matches: the reader's version is not needed any more.
    if (!now.stale) {
      if (mine) await this.followed.set(ck, undefined)
      return now
    }
    // The reader's version (from an earlier edit) still matches: the step is on it.
    if (mine) {
      const onMine = placeStep(lines, mine, was, fileField)
      if (!onMine.stale) return onMine
    }
    // The reader's edit just now covers it: the edited lines are its code from now on.
    const editedHere = ed && ed.end >= ed.start && ed.end < lines.length
    const edited = editedHere ? compactOf(lines, ed.start, ed.end) : undefined
    if (!edited) return now
    await this.followed.set(ck, edited)
    return { start: ed!.start + 1, end: ed!.end + 1, stale: false, ...fileField }
  }

  /**
   * An edit in an editor (typing, an applied fix): steps in that document keep up with it. A step whose lines the edit
   * touched (without replacing them all) stays on them: `locate` takes them as its code. A reload from disk looks the
   * same here; it leaves the document clean, so `onDocument` forgets those edits before locating.
   */
  onEdit(e: vscode.TextDocumentChangeEvent): void {
    if (e.document.uri.scheme !== 'file' || !e.contentChanges.length) return
    const lastFirst = [...e.contentChanges].sort((a, b) => b.range.start.compareTo(a.range.start))
    const changes = lineEdits(lastFirst)
    for (const lj of this.list.values()) {
      const rel = pathIn(lj.folder.uri, e.document.uri)
      if (rel === undefined) continue
      for (const st of lj.j.steps) if (fileOf(lj, st.n) === rel) this.followEdits(lj, st.n, changes)
    }
  }

  /** Step `n`'s lines through `changes` (last first); remembered when the edits touched them. */
  private followEdits(lj: LoadedJourney, n: number, changes: LineEdit[]): void {
    const at = atOf(lj, n)
    const k = this.stepKey(lj, n)
    if (!at || (at.stale && !this.edited.has(k))) return
    let loc: Loc = this.edited.get(k) ?? { start: at.start - 1, end: at.end - 1 }
    let touched = this.edited.has(k), gone = false
    for (const edit of changes) {
      if (swallows(loc, edit)) gone = true
      if (edit.startLine <= loc.end && edit.endLine >= loc.start) touched = true
      loc = shift(loc, edit)
    }
    // Its code replaced as a whole (deleted, a big paste): found again, or stale, as usual.
    if (gone) this.edited.delete(k)
    else if (touched) this.edited.set(k, loc)
  }

  /** What the step's code looked like: from the journey file, or taken from the code when the file had none. */
  anchorOf(lj: LoadedJourney, n: number): AnyAnchor | undefined {
    return stepOf(lj, n).anchor ?? this.captured.get(this.stepKey(lj, n))
  }

  /** Where step `n`'s code is in `lines` (another file's, e.g. one just created): fresh, changed or gone. */
  findIn(lj: LoadedJourney, n: number, lines: string[]): Found {
    const a = this.anchorOf(lj, n)
    const c = a && toCompact(a)
    return c ? findCompact(lines, c, atOf(lj, n).start - 1) : { state: 'gone' }
  }

  /** The step's code is in another file now (renamed): follow it, in memory. */
  async moveStep(lj: LoadedJourney, n: number, file: string): Promise<void> {
    const back = file === stepOf(lj, n).file
    const at: StepAt = { ...atOf(lj, n), file: back ? undefined : file }
    if (at.file === undefined) delete at.file
    lj.at[n - 1] = at
    this.log.info(`journey ${lj.j.id} step ${n}: its file moved to ${file}`)
    await this.renamed.set(this.renameKey(lj, n), at.file ? file : undefined)
    await this.locate(lj, (k) => k === n)
    this.moved.fire(lj)
  }

  /** Renamed files (old -> new path) the journey's steps followed: refs to the old path say where it went. */
  renames(lj: LoadedJourney): Map<string, string> {
    const out = new Map<string, string>()
    lj.j.steps.forEach((s, i) => {
      const f = lj.at[i].file
      if (f) out.set(s.file, f)
    })
    return out
  }

  /**
   * Files changed on disk (git checkout, pull, an agent; not typed in an editor): re-find the steps in them. Without
   * this a step stayed as it was found when the window opened: stale after a branch switch back, fresh after one away.
   * No `paths`: every step (the branch changed).
   */
  async relocateOnDisk(paths?: Set<string>): Promise<void> {
    for (const lj of [...this.list.values()]) {
      const base = dirPath(lj.folder.uri)
      const hit = (n: number) => !paths || paths.has(base + fileOf(lj, n))
      if (!lj.j.steps.some((s) => hit(s.n))) continue
      if (await this.locate(lj, hit)) this.moved.fire(lj)
    }
  }

  /** An edited document: re-find the steps in it, a moment after typing stops. */
  onDocument(doc: vscode.TextDocument): void {
    if (doc.uri.scheme !== 'file') return
    for (const lj of this.list.values()) {
      const rel = pathIn(lj.folder.uri, doc.uri)
      const inFile = (n: number) => fileOf(lj, n) === rel
      if (rel === undefined || !lj.j.steps.some((s) => inFile(s.n))) continue
      const k = `${lj.key}|${rel}`
      clearTimeout(this.pending.get(k))
      this.pending.set(k, setTimeout(() => {
        this.pending.delete(k)
        if (this.list.get(lj.key) !== lj) return
        // Clean after the change: the file was reloaded from disk (a checkout, an agent), not edited here.
        if (!doc.isDirty) for (const st of lj.j.steps) if (inFile(st.n)) this.edited.delete(this.stepKey(lj, st.n))
        void this.locate(lj, inFile, { file: rel, lines: docLines(doc) }).then((c) => { if (c) this.moved.fire(lj) })
      }, EDIT_SETTLE_MS))
    }
  }

  dispose(): void {
    for (const t of this.pending.values()) clearTimeout(t)
    this.moved.dispose()
  }
}
