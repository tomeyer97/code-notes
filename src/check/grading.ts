// An answer (in a question's thread or the Check view's box) goes into the check file, then Claude grades it,
// read-only; the verdict is written into the file and reaches the thread through the threads' sync.
import * as vscode from 'vscode'
import * as path from 'path'
import { Ask, AskErrorKind, AskResult } from '../claude'
import type { Note } from '../store'
import type { Attempt, Cli, Question } from './types'
import { sameQuestion } from './links'
import { costOf } from './log'
import type { CheckController } from './controller'

/** Why a grade failed: the error's words, and its kind when the extension knows it. */
export interface GradeError { message: string; kind?: AskErrorKind }

export class Grader {
  /** Questions being graded now (by id; the Ask once Claude runs). */
  readonly grading = new Map<string, Ask | undefined>()
  /** Failures to grade (by note id: shown in the thread with Try again). */
  readonly errors = new Map<string, GradeError>()
  /** Questions whose answer is being taken: "Checking…" from the first moment. */
  readonly answering = new Set<string>()

  constructor(private ctl: CheckController) {}

  private get host() { return this.ctl.host }

  /** Being graded, or its answer being taken. */
  busy(id: string): boolean { return this.grading.has(id) || this.answering.has(id) }

  /**
   * The person answered in a question's thread: the answer goes into the file, then it is graded. True when the answer
   * was taken (saved in the thread, and in the file unless it is a remark).
   */
  async answer(n: Note, text: string, link: { file: string; q: string }): Promise<boolean> {
    const body = text.trim()
    if (!body) return false
    // One answer at a time per question: a second Ctrl+Enter meanwhile is not a second answer.
    if (this.answering.has(link.q)) return false
    this.answering.add(link.q)
    this.ctl.post()
    this.host.refresh()
    try {
      return await this.take(n, link, body)
    } finally {
      this.answering.delete(link.q)
      this.ctl.post()
      this.host.refresh()
    }
  }
  private async take(n: Note, link: { file: string; q: string }, body: string): Promise<boolean> {
    const ctl = this.ctl
    // Gated: reads git again only if something changed (the check file is read below anyway).
    await ctl.refresh(false)
    const abs = path.join(ctl.repo!, link.file)
    let check
    try {
      check = ctl.cli.readCheck(abs)
    } catch {
      void vscode.window.showWarningMessage(`Code Notes: ${link.file} can't be read.`)
      return false
    }
    const q = check.questions.find((x) => x.id === link.q)
    // Only an answer to the question as it was shown: the file may have been rewritten since.
    if (!q || !sameQuestion(n, q)) {
      void vscode.window.showWarningMessage('This question changed: reopen it from the Check view.')
      await ctl.refresh()
      return false
    }
    const state = ctl.cli.stateOf(q)
    // Passed: a remark, not graded. Explained: a restatement, graded against the explanation.
    if (state === 'pass' || state === 'restated') return this.host.addReply(n, body)
    if (this.grading.has(q.id)) return false
    // The thread first: a refresh between the two then finds the answer there already (no second copy).
    if (!(await this.host.addReply(n, body))) return false
    ctl.cli.addAttempt(check, q, body, ctl.who)
    ctl.save(abs, check)
    // Not awaited: the reply box clears once the answer is in (VS Code clears it when the command returns).
    void this.grade(q.id)
    return true
  }

  /** Grades a question's latest answer with Claude (read-only), writes the verdict, replies in the thread. */
  async grade(id: string): Promise<void> {
    const ctl = this.ctl, repo = ctl.repo
    if (!repo || !ctl.st?.exists || this.grading.has(id)) return
    const abs = ctl.abs!
    const n = ctl.threads.noteOf(id)
    if (n) {
      this.errors.delete(n.data.id)
      ctl.threads.graded.add(n.data.id)
    }
    if (!this.host.allowed('grade answers')) return
    const fail = (e: GradeError) => {
      if (n) this.errors.set(n.data.id, e)
      this.ctl.log.error(`${id}: ${e.message}`)
    }
    const claude = this.host.cli()
    if (!claude) {
      fail({ message: 'Claude Code (the `claude` CLI) was not found.', kind: 'no-cli' })
      this.host.refresh()
      return
    }
    const check = ctl.cli.readCheck(abs)
    const q = check.questions.find((x) => x.id === id)
    const last = q?.attempts?.at(-1)
    if (!q || !last) return
    const mode = ctl.cli.gradeMode(q)
    // Graded from here on (a second click while the diff is read starts nothing).
    this.grading.set(id, undefined)
    let diff = ''
    try {
      diff = await ctl.worker.call<string>('diffText', repo, check.base ?? check.head)
    } catch { /* no diff: the grader reads the code */ }
    const prompt = ctl.cli.graderPrompt({
      q, answer: last.answer ?? '', ...mode,
      diff: ctl.cli.diffForGrader(diff, q.file), code: ctl.cli.codeWindow(repo, q), canRead: true,
      tour: ctl.cli.tourText(check), others: ctl.cli.openOthers(check, q),
    })
    const ask = new Ask({ cli: claude, cwd: repo, prompt, model: this.host.model() })
    this.grading.set(id, ask)
    ctl.post()
    this.host.refresh()
    const res = await ask.done
    this.grading.delete(id)
    try {
      if (res.cancelled) return
      if (res.error) { fail({ message: res.error, kind: res.errorKind }); return }
      let v: ReturnType<Cli['parseVerdict']>
      try {
        v = ctl.cli.parseVerdict(res.text, mode.attempt, { restate: mode.explanation !== undefined })
      } catch (e) {
        fail({ message: (e as Error).message })
        return
      }
      if (!this.applyVerdict(abs, id, last, v, res)) return
      // The grade reaches the thread through the threads' sync. The editor stays on this question: the feedback is
      // the lesson. Moving on is the person's: "Next question ›" under the grade, or Ctrl+' D.
      await ctl.refresh()
    } finally {
      ctl.post()
      this.host.refresh()
    }
  }

  /**
   * Writes verdict `v` on the attempt it graded (`last`). The file may have changed while Claude worked: it is read
   * again, and the verdict goes only to the same answer, still ungraded and still the latest. False when it is gone.
   */
  private applyVerdict(abs: string, id: string, last: Attempt, v: ReturnType<Cli['parseVerdict']>, res: AskResult): boolean {
    const ctl = this.ctl
    const check = ctl.cli.readCheck(abs)
    const q: Question | undefined = check.questions.find((x) => x.id === id)
    const latest = q?.attempts?.at(-1)
    const a = latest?.answer === last.answer && !latest?.verdict ? latest : undefined
    if (!q || !a) return false
    // As the CLI records a grade: links to lines that are really there (the words stay either way), the time, the hash,
    // one concern per question kept on it (its flag survives a later grade).
    ctl.cli.recordGrade(ctl.repo!, q, a, v, this.host.now())
    ctl.save(abs, check)
    this.ctl.log.info(`${id} ${v.verdict}${v.concern ? ' (concern)' : ''}${costOf(res)}`)
    return true
  }
}
