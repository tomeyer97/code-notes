// What Claude writing the check is at, as two small state machines (writer.ts runs them): the questions
// (idle → writing → failed | ready | idle) and the tour, per branch (idle → writing → idle | paused | failed).
// No vscode API here (unit-tested in test/writerState.test.ts).
import type { ClaudeRun } from '../core/agentRun'

/** A run of Claude writing the questions or the tour of `branch`. */
export interface CheckRun extends ClaudeRun { readonly branch: string }

/** Why writing the questions of `branch` failed (a top-up or a start: Retry does the same), as the view says it. */
export interface QuestionsFailure { branch: string; topUp: boolean; text: string; setting?: boolean; path?: boolean }

/** Where the questions stand, between two runs. */
export type QuestionsRest =
  | { kind: 'idle' }
  /** Said in the Check view with Retry until a retry works. */
  | { kind: 'failed'; failure: QuestionsFailure }
  /** Written in the background and not opened yet: the status bar says how many. */
  | { kind: 'ready'; count: number }

/** Where the questions stand: at rest, or being written (`before`: the state the run ends in unless it says otherwise). */
export type QuestionsPhase = QuestionsRest | { kind: 'writing'; run: CheckRun; before: QuestionsRest }

const IDLE: QuestionsRest = { kind: 'idle' }

/** The questions' state machine: one run at a time, for the branch it started on. */
export class QuestionsState {
  private phase: QuestionsPhase = IDLE

  get now(): Readonly<QuestionsPhase> { return this.phase }
  /** The run writing the questions, if any. */
  get run(): CheckRun | undefined { return this.phase.kind === 'writing' ? this.phase.run : undefined }
  /** The failure shown (a background run keeps the one before it shown until it succeeds). */
  get failure(): QuestionsFailure | undefined {
    const rest = this.rest()
    return rest.kind === 'failed' ? rest.failure : undefined
  }
  /** How many questions written in the background are not opened yet. */
  get ready(): number {
    const rest = this.rest()
    return rest.kind === 'ready' ? rest.count : 0
  }

  /** A run starts (a foreground one has cleared the failure first: clearFailure). False while one runs. */
  start(run: CheckRun): boolean {
    if (this.phase.kind === 'writing') return false
    this.phase = { kind: 'writing', run, before: this.phase }
    return true
  }
  // What a run ended with is said after ended(): a run started meanwhile ends in it (setRest), it is not overwritten.

  /** The run wrote `count` questions: ready to open when it ran in the background; else they are open already. */
  wrote(count: number, background: boolean): void {
    const before = this.rest()
    this.setRest(background ? { kind: 'ready', count } : before.kind === 'ready' ? before : IDLE)
  }
  /** The run failed: said (foreground); in the background nothing is said and what was there stays. */
  failed(failure: QuestionsFailure, background: boolean): void {
    if (!background) this.setRest({ kind: 'failed', failure })
  }
  /** The run ended with nothing to say (cancelled, the branch switched): back to what was there. */
  ended(): void { this.phase = this.rest() }
  /** Writing failed before a run could start (Claude Code wasn't found). */
  cantStart(failure: QuestionsFailure): void { this.setRest({ kind: 'failed', failure }) }

  /** The failure goes (a new start, Retry). */
  clearFailure(): void { if (this.rest().kind === 'failed') this.setRest(IDLE) }
  /** The questions written in the background are being opened: no longer "ready". */
  clearReady(): void { if (this.rest().kind === 'ready') this.setRest(IDLE) }

  /** The state outside a run (during one: the state it ends in unless it says otherwise). */
  private rest(): QuestionsRest { return this.phase.kind === 'writing' ? this.phase.before : this.phase }
  private setRest(rest: QuestionsRest): void {
    this.phase = this.phase.kind === 'writing' ? { ...this.phase, before: rest } : rest
  }
}

/** A run writing the tour: in the session that wrote the questions (`session`), for their new part (`topUp`). */
export interface TourRun extends CheckRun { session?: string; topUp: boolean }

/** Where a branch's tour stands. */
export type TourPhase =
  | { kind: 'idle' }
  | { kind: 'writing'; run: TourRun }
  /**
   * Stopped when its branch was switched away; written again (same session) once the branch is back and the stopped
   * run has ended (`stopping`: until then).
   */
  | { kind: 'paused'; session?: string; topUp: boolean; stopping?: TourRun }
  /** The last try failed: offered again in the view. */
  | { kind: 'failed' }

/** The tour's state machine, per branch: one tour written at a time. */
export class TourStates {
  private readonly byBranch = new Map<string, TourPhase>()

  of(branch: string | undefined): Readonly<TourPhase> { return (branch && this.byBranch.get(branch)) || { kind: 'idle' } }
  /** The tour being written now (of any branch). */
  get run(): TourRun | undefined {
    for (const p of this.byBranch.values()) if (p.kind === 'writing') return p.run
    return undefined
  }

  /** A run starts for its branch (a failure there goes). False while a tour is written. */
  start(run: TourRun): boolean {
    if (this.run) return false
    this.byBranch.set(run.branch, { kind: 'writing', run })
    return true
  }
  /** The run is still the one writing its branch's tour (not paused meanwhile). */
  current(run: TourRun): boolean {
    const p = this.byBranch.get(run.branch)
    return p?.kind === 'writing' && p.run === run
  }
  /** The run's branch was switched away: paused (its run is cancelled by the caller). */
  pause(run: TourRun): void {
    if (this.current(run)) this.byBranch.set(run.branch, { kind: 'paused', session: run.session, topUp: run.topUp, stopping: run })
  }
  /** The run ended: false when it was paused meanwhile (its branch stays paused). */
  ended(run: TourRun): boolean {
    const p = this.byBranch.get(run.branch)
    if (p?.kind === 'paused' && p.stopping === run) this.byBranch.set(run.branch, { kind: 'paused', session: p.session, topUp: p.topUp })
    if (!this.current(run)) return false
    this.byBranch.delete(run.branch)
    return true
  }
  /** Writing `branch`'s tour failed (it wrote none). */
  failed(branch: string): void { if (!this.run || this.run.branch !== branch) this.byBranch.set(branch, { kind: 'failed' }) }
  /** `branch`'s paused tour, taken to be written again (undefined: none). */
  resume(branch: string): { session?: string; topUp: boolean } | undefined {
    const p = this.byBranch.get(branch)
    if (p?.kind !== 'paused' || p.stopping || this.run) return undefined
    this.byBranch.delete(branch)
    return { session: p.session, topUp: p.topUp }
  }
}
