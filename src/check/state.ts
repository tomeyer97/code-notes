// What the understanding check knows now (CheckState) and what every part of it gets (CheckCore). The controller
// writes the state (a refresh, a selection); the parts read it, and say what they just did. No part gets the
// controller. No vscode at run time: unit-tested (test/checkState.test.ts).
import * as path from 'path'
import type * as vscode from 'vscode'
import type { Note } from '../notes/store'
import type { ScopedRecord } from '../platform/state'
import type { HostCli } from './cliApi'
import type { CheckLog } from './log'
import { checkExtra, linkOf } from './threadLink'
import type { BranchStatus, Check, Question, Who, Words } from './types'

export { checkExtra, type CheckNoteExtra } from './threadLink'

/** What is kept per workspace, per question: unsent answers (per check file), applied fixes and added TODOs (per branch). */
export interface CheckRecords {
  drafts: ScopedRecord<string>
  fixes: ScopedRecord<string>
  todos: ScopedRecord<{ file: string; line: number }>
}

export class CheckState {
  private status: BranchStatus | undefined
  private stateWords: Words | undefined
  private ident: Who | undefined
  private nothingCommitted = false
  private selectedId: string | undefined
  private saidLine: string | undefined

  /** `folder`: the workspace folder (its repository) the check is about: the first one. */
  constructor(readonly folder: vscode.WorkspaceFolder | undefined, readonly records: CheckRecords) {}

  /** Where the branch stands, as the last refresh read it. */
  get st(): BranchStatus | undefined { return this.status }
  /** The CLI's words for it (the status bar, the view). */
  get words(): Words | undefined { return this.stateWords }
  /** Who answers (git's user.name and user.email), as the last refresh read it. */
  get who(): Who | undefined { return this.ident }
  /** No check yet and nothing of the change committed: the questions would have nothing to ask about. */
  get uncommittedOnly(): boolean { return this.nothingCommitted }
  /** The question selected in the Check view (its answer box is shown). */
  get selected(): string | undefined { return this.selectedId }
  /** One line about what was just done (a merge kept both answers): until the next push or branch. */
  get said(): string | undefined { return this.saidLine }

  get drafts(): ScopedRecord<string> { return this.records.drafts }
  get fixes(): ScopedRecord<string> { return this.records.fixes }
  get todos(): ScopedRecord<{ file: string; line: number }> { return this.records.todos }

  get repo(): string | undefined { return this.folder?.uri.fsPath }
  /** The check file's absolute path (when there is a status). */
  get abs(): string | undefined { return this.st && this.repo ? path.join(this.repo, this.st.file) : undefined }

  // ---------- written by the controller's refresh ----------

  /** A refresh read the branch (`st` undefined: no status) and who answers. */
  read(st: BranchStatus | undefined, who: Who | undefined): void {
    this.status = st
    this.ident = who
  }
  setWords(w: Words | undefined): void { this.stateWords = w }
  setUncommittedOnly(on: boolean): void { this.nothingCommitted = on }
  /** Another branch is checked out: nothing is selected, nothing said. */
  branchLeft(): void {
    this.selectedId = undefined
    this.saidLine = undefined
  }

  // ---------- written by the controller and the parts ----------

  select(id: string | undefined): void { this.selectedId = id }
  say(line: string | undefined): void { this.saidLine = line }

  // ---------- read ----------

  /** A suggested fix for question `qid`'s concern was applied on this branch (and not committed since). */
  fixApplied(qid: string): boolean { return Object.hasOwn(this.fixes.get(this.st?.branch), qid) }

  /** The files a TODO was added to from this branch's check. */
  todoFiles(): string[] { return [...new Set(Object.values(this.todos.get(this.st?.branch)).map((t) => t.file))] }

  /** A question of the check by its id. */
  question(id: string): Question | undefined { return this.st?.check?.questions.find((x) => x.id === id) }
  /** The question behind a check thread. */
  questionOf(n: Note): Question | undefined {
    const l = linkOf(n)
    return l ? this.question(l.q) : undefined
  }
  /** For a note made from a check thread: the check it belongs to (hidden with it on other branches). */
  branchOf(n: Note): { checkFile?: string } {
    const f = linkOf(n)?.file
    return f ? { checkFile: f } : {}
  }
  /**
   * A check thread of another branch's check, or a note made from one (Suggest a fix, Ask Claude): not shown (its file
   * and lines belong to that branch). Also this branch's while its file is gone (stashed, deleted).
   */
  offBranch(n: Note): boolean {
    const f = linkOf(n)?.file ?? checkExtra(n).checkFile
    return !!f && !!this.st && (f !== this.st.file || !this.st.exists)
  }
}

/** What every part of the check gets: the state, the understanding CLI, the log, and the ways to show a change. */
export interface CheckCore {
  readonly state: CheckState
  /** The understanding CLI (cli/understanding.mjs's functions). Not Claude Code (the host's `cli()`). */
  readonly cli: HostCli
  readonly log: CheckLog
  /** Where the branch stands read again; the status bar, the threads and the view follow (`force` false: gated). */
  refresh(force?: boolean): Promise<void>
  /** The Check view drawn again from the state. */
  post(): void
  /** Writes the check file with today's line numbers and its result. */
  save(abs: string, check: Check): void
}

/**
 * The one way a part changes the check file: read, `change`d (false: nothing to write), written with today's line
 * numbers (CheckCore.save). From the read to the write nothing else runs, so two writers never interleave. False: no
 * check file here, or nothing written.
 */
export function updateCheck(
  core: Pick<CheckCore, 'state' | 'cli' | 'save'>, change: (check: Check) => boolean | void,
): boolean {
  const abs = core.state.abs
  if (!abs) return false
  const check = core.cli.readCheck(abs)
  if (change(check) === false) return false
  core.save(abs, check)
  return true
}

/**
 * `rec` with its writes one at a time: each reads the record after the one before was written, so two quick changes
 * (two TODOs added) both stay. A write with none waiting starts at once (a draft is in memory before it is stored).
 */
export function serialScoped<T>(rec: ScopedRecord<T>): ScopedRecord<T> {
  let tail: Promise<void> | undefined
  const queue = (write: () => Promise<void>): Promise<void> => {
    const run = tail ? tail.then(write, write) : write()
    // The queue empties when its last write is through (written or failed: the next one runs either way).
    const done = () => { if (tail === settled) tail = undefined }
    const settled: Promise<void> = run.then(done, done)
    tail = settled
    return run
  }
  return {
    get: (scope) => rec.get(scope),
    set: (scope, id, v) => queue(() => rec.set(scope, id, v)),
    replace: (scope, record) => queue(() => rec.replace(scope, record)),
  }
}
