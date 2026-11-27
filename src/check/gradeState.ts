// What each question is doing in grading.ts, in one record per question: its answer being taken, being graded (and
// the run once Claude works), the last failure to grade. No vscode API here (unit-tested in test/gradeState.test.ts).
import type { AskErrorKind } from '../platform/agent/claude'
import type { Attempt } from './types'

/** Why a grade failed: the error's words, and its kind when the extension knows it. */
export interface GradeError { message: string; kind?: AskErrorKind }

/** A question in grading: `phase` while its answer is taken or graded; `error` until the next grade starts. */
export interface QuestionGrade<R> {
  phase?: 'answering' | 'grading'
  /** The grader's run, once Claude works (grading). */
  run?: R
  /** The last failure to grade, and the thread it is shown in (its note id). */
  error?: GradeError
  note?: string
}

/** The questions' grading records by question id. `R`: the grader's run. */
export class GradeStates<R> {
  private readonly byId = new Map<string, QuestionGrade<R>>()

  /** What question `id` is doing (an empty record when nothing). */
  stateOf(id: string): Readonly<QuestionGrade<R>> { return this.byId.get(id) ?? {} }

  /** Its answer being taken or it being graded: "Checking…". */
  busy(id: string): boolean { return !!this.stateOf(id).phase }
  /** Being graded (Claude runs, or is about to). */
  grading(id: string): boolean { return this.stateOf(id).phase === 'grading' }
  /** Its answer being taken. */
  answering(id: string): boolean { return this.stateOf(id).phase === 'answering' }

  /**
   * An answer is taken: false while one is taken or graded (a second Ctrl+Enter meanwhile is not a second answer; a
   * grade in progress would not take it either).
   */
  startAnswering(id: string): boolean { return !this.busy(id) && this.set(id, { phase: 'answering' }) }
  /** Taking the answer is over (a grade it started goes on). */
  endAnswering(id: string): void { if (this.answering(id)) this.set(id, { phase: undefined }) }

  /** Grading starts (before Claude runs: a second click meanwhile starts nothing); the last failure goes. */
  startGrading(id: string): void { this.set(id, { phase: 'grading', run: undefined, error: undefined, note: undefined }) }
  /** Claude grades with `run`. */
  running(id: string, run: R): void { this.set(id, { run }) }
  /** Grading is over. */
  endGrading(id: string): void { if (this.grading(id)) this.set(id, { phase: undefined, run: undefined }) }

  /** The last failure to grade question `id`, shown in thread `note`. */
  fail(id: string, note: string, error: GradeError): void { this.set(id, { error, note }) }
  /** The failure shown in thread `note` goes (a new grade starts there). */
  clearError(id: string): void { this.set(id, { error: undefined, note: undefined }) }

  /** The questions being graded or whose answer is being taken. */
  busyIds(): string[] { return this.ids((s) => !!s.phase) }
  /** The questions being graded. */
  gradingIds(): string[] { return this.ids((s) => s.phase === 'grading') }
  /** The runs of the questions being graded (undefined: Claude is about to run). */
  runs(): Map<string, R | undefined> { return new Map(this.gradingIds().map((id) => [id, this.stateOf(id).run])) }
  /** The failures, by the note id of the thread each is shown in. */
  errorsByNote(): Map<string, GradeError> {
    const out = new Map<string, GradeError>()
    for (const s of this.byId.values()) if (s.error && s.note) out.set(s.note, s.error)
    return out
  }

  private ids(pick: (s: QuestionGrade<R>) => boolean): string[] {
    return [...this.byId].filter(([, s]) => pick(s)).map(([id]) => id)
  }
  /** `patch` merged into question `id`'s record (dropped once it holds nothing); true. */
  private set(id: string, patch: Partial<QuestionGrade<R>>): true {
    const next = { ...this.byId.get(id), ...patch }
    for (const k of Object.keys(next) as (keyof QuestionGrade<R>)[]) if (next[k] === undefined) delete next[k]
    if (Object.keys(next).length) this.byId.set(id, next)
    else this.byId.delete(id)
    return true
  }
}

/**
 * The attempt a verdict on `graded` may be written on: `latest`, when it is still the same answer and still ungraded
 * (the file may have changed while Claude worked: another answer, or a grade from elsewhere).
 */
export function stillUngraded(latest: Attempt | undefined, graded: Attempt): Attempt | undefined {
  return latest && latest.answer === graded.answer && !latest.verdict ? latest : undefined
}
