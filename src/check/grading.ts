// An answer (in a question's thread or the Check view's box) goes into the check file, then Claude grades it,
// read-only; the verdict is written into the file and reaches the thread through the threads' sync.
import * as vscode from 'vscode'
import * as path from 'path'
import type { AgentRun } from '../platform/agent/agent'
import type { AskResult } from '../platform/agent/claude'
import { agentRunner } from '../platform/agent/runner'
import type { Note } from '../notes/store'
import type { Attempt, Check, ParsedVerdict, Question } from './types'
import { sameQuestion } from './threadLink'
import { costOf } from './log'
import type { CliThread } from './cliThread'
import type { CheckHost } from './host'
import type { CheckCore } from './state'
import type { CheckThreads } from './threads'
import { GradeStates, stillUngraded, type GradeError, type QuestionGrade } from './gradeState'
import { fireAndForget, showError } from '../platform/run'

export type { GradeError } from './gradeState'

/** What the grader needs: the check's core, Claude, the notes, the CLI's worker (diffs) and the question threads. */
export interface GraderPorts extends CheckCore {
  host: Pick<CheckHost, 'addReply' | 'allowed' | 'cli' | 'model' | 'now' | 'refresh'>
  worker: Pick<CliThread, 'api'>
  threads: Pick<CheckThreads, 'noteOf' | 'graded'>
}

/** How an answer is graded (its attempt number; against an explanation, a restatement), and the grader's prompt. */
interface GradeAsk { mode: ReturnType<GraderPorts['cli']['gradeMode']>; prompt: string }

export class Grader {
  /** What each question is doing here: its answer taken, graded, or the last failure to grade it. */
  private readonly states = new GradeStates<AgentRun>()

  constructor(private ports: GraderPorts) {}

  private get host() { return this.ports.host }

  /** What question `id` is doing: taking its answer, grading it (with Claude's run), its last failure. */
  stateOf(id: string): Readonly<QuestionGrade<AgentRun>> { return this.states.stateOf(id) }
  /** Being graded, or its answer being taken. */
  busy(id: string): boolean { return this.states.busy(id) }
  /** The questions being graded or whose answer is being taken ("Checking…"). */
  busyIds(): string[] { return this.states.busyIds() }

  /** Questions being graded now (by id; the run once Claude works). A snapshot: see stateOf. */
  get grading(): ReadonlyMap<string, AgentRun | undefined> { return this.states.runs() }
  /** Questions whose answer is being taken. A snapshot: see stateOf. */
  get answering(): ReadonlySet<string> { return new Set(this.busyIds().filter((id) => this.states.answering(id))) }
  /** Failures to grade, by the note id of the thread they are shown in (with Try again). A snapshot: see stateOf. */
  get errors(): ReadonlyMap<string, GradeError> { return this.states.errorsByNote() }

  /**
   * The person answered in a question's thread: the answer goes into the file, then it is graded. True when the answer
   * was taken (saved in the thread, and in the file unless it is a remark).
   */
  async answer(n: Note, text: string, link: { file: string; q: string }): Promise<boolean> {
    const body = text.trim()
    if (!body) return false
    if (!this.states.startAnswering(link.q)) return false
    this.changed()
    try {
      return await this.take(n, link, body)
    } finally {
      this.states.endAnswering(link.q)
      this.changed()
    }
  }

  /** The answer `body` to question `link.q` taken: as a remark (passed), or into the file and then graded. */
  private async take(n: Note, link: { file: string; q: string }, body: string): Promise<boolean> {
    const ports = this.ports
    // Gated: reads git again only if something changed (the check file is read below anyway).
    await ports.refresh(false)
    const abs = path.join(ports.state.repo!, link.file)
    const q = await this.questionAsShown(n, abs, link)
    if (!q) return false
    const state = ports.cli.stateOf(q)
    // Passed: a remark, not graded. Explained: a restatement, graded against the explanation.
    if (state === 'pass' || state === 'restated') return this.host.addReply(n, body)
    if (this.states.grading(q.id)) return false
    if (!(await this.appendAnswer(n, abs, q.id, body))) return false
    // Not awaited: the reply box clears once the answer is in (VS Code clears it when the command returns).
    fireAndForget(this.grade(q.id), 'grading: grade')
    return true
  }

  /** Question `link.q` of the file, as it was shown in thread `n` (the file may have been rewritten since); else said. */
  private async questionAsShown(n: Note, abs: string, link: { file: string; q: string }): Promise<Question | undefined> {
    let check: Check
    try {
      check = this.ports.cli.readCheck(abs)
    } catch {
      fireAndForget(showError(`${link.file} can't be read.`), 'grading: showError')
      return undefined
    }
    const q = check.questions.find((x) => x.id === link.q)
    if (q && sameQuestion(n, q)) return q
    fireAndForget(vscode.window.showWarningMessage('This question changed: reopen it from the Check view.'), 'grading: window.showWarningMessage')
    await this.ports.refresh()
    return undefined
  }

  /**
   * The answer into thread `n`, then into the check file. The order matters: the threads' sync copies attempts from
   * the file into the thread, so with the thread first a refresh in between finds the answer there already (no second
   * copy). The file part reads, changes and writes the file with no await in between (as recordVerdict does), so it
   * never writes over a grade saved meanwhile.
   */
  private async appendAnswer(n: Note, abs: string, id: string, body: string): Promise<boolean> {
    if (!(await this.host.addReply(n, body))) return false
    const ports = this.ports
    const check = ports.cli.readCheck(abs)
    const q = check.questions.find((x) => x.id === id)
    if (!q) return false
    ports.cli.addAttempt(check, q, body, ports.state.who)
    ports.save(abs, check)
    return true
  }

  /** Grades a question's latest answer with Claude (read-only), writes the verdict, replies in the thread. */
  async grade(id: string): Promise<void> {
    const ports = this.ports, repo = ports.state.repo, abs = ports.state.abs
    if (!repo || !abs || !ports.state.st?.exists || this.states.grading(id)) return
    const n = ports.threads.noteOf(id)
    if (n) {
      this.states.clearError(id)
      ports.threads.graded.add(n.data.id)
    }
    if (!this.host.allowed('grade answers')) return
    const claude = this.host.cli()
    if (!claude) {
      this.fail(id, { message: 'Claude Code (the `claude` CLI) was not found.', kind: 'no-cli' })
      this.host.refresh()
      return
    }
    const check = ports.cli.readCheck(abs)
    const q = check.questions.find((x) => x.id === id)
    const last = q?.attempts?.at(-1)
    if (!q || !last) return
    // Graded from here on (a second click while the diff is read starts nothing).
    this.states.startGrading(id)
    let ask: GradeAsk, res: AskResult
    try {
      ask = await this.buildGraderPrompt(repo, check, q, last)
      res = await this.runGrader(id, claude, ask.prompt)
    } finally {
      this.states.endGrading(id)
    }
    try {
      if (this.applyResult(abs, id, last, ask.mode, res)) await ports.refresh()
    } finally {
      this.changed()
    }
  }

  /** The grader's prompt for `last`, the latest answer to `q`: the change's diff, the code, the tour, the others. */
  private async buildGraderPrompt(repo: string, check: Check, q: Question, last: Attempt): Promise<GradeAsk> {
    const cli = this.ports.cli
    const mode = cli.gradeMode(q)
    const diff = await this.diffOf(repo, check)
    const prompt = cli.graderPrompt({
      q, answer: last.answer ?? '', ...mode,
      diff: cli.diffForGrader(diff, q.file), code: cli.codeWindow(repo, q), canRead: true,
      tour: cli.tourText(check), others: cli.openOthers(check, q),
    })
    return { mode, prompt }
  }

  /** The change's diff for the grader; empty when it can't be read (the grader then reads the code; logged). */
  private async diffOf(repo: string, check: Check): Promise<string> {
    try {
      return await this.ports.worker.api.diffText(repo, check.base ?? check.head)
    } catch (e) {
      this.ports.log.debug(`no diff for the grader (it reads the code): ${(e as Error).message}`)
      return ''
    }
  }

  /** Claude, read-only, on the grader's prompt: listed in progress while it runs; its result. */
  private runGrader(id: string, claude: string, prompt: string): Promise<AskResult> {
    const run = agentRunner().start(claude, { key: `check:grade:${id}`, purpose: 'check', label: `Grading ${id}` }, {
      cwd: this.ports.state.repo!, prompt, model: this.host.model(),
    })
    this.states.running(id, run)
    this.changed()
    return run.done
  }

  /** What Claude replied, written as the verdict (true) or kept as the failure; nothing when cancelled. */
  private applyResult(abs: string, id: string, last: Attempt, mode: GradeAsk['mode'], res: AskResult): boolean {
    if (res.cancelled) return false
    if (res.error) {
      this.fail(id, { message: res.error, kind: res.errorKind })
      return false
    }
    let v: ParsedVerdict
    try {
      v = this.ports.cli.parseVerdict(res.text, mode.attempt, { restate: mode.explanation !== undefined })
    } catch (e) {
      this.fail(id, { message: (e as Error).message })
      return false
    }
    // The grade reaches the thread through the threads' sync. The editor stays on this question: the feedback is the
    // lesson. Moving on is the person's: "Next question ›" under the grade, or Ctrl+' D.
    return this.recordVerdict(abs, id, last, v, res)
  }

  /**
   * Writes verdict `v` on the attempt it graded (`last`). The file may have changed while Claude worked: it is read
   * again, and the verdict goes only to the same answer, still ungraded and still the latest. False when it is gone.
   * Read, change and write with no await in between (see appendAnswer).
   */
  private recordVerdict(abs: string, id: string, last: Attempt, v: ParsedVerdict, res: AskResult): boolean {
    const ports = this.ports
    const check = ports.cli.readCheck(abs)
    const q = check.questions.find((x) => x.id === id)
    const a = stillUngraded(q?.attempts?.at(-1), last)
    if (!q || !a) return false
    // As the CLI records a grade: links to lines that are really there (the words stay either way), the time, the hash,
    // one concern per question kept on it (its flag survives a later grade).
    ports.cli.recordGrade(ports.state.repo!, q, a, v, this.host.now())
    ports.save(abs, check)
    ports.log.info(`${id} ${v.verdict}${v.concern ? ' (concern)' : ''}${costOf(res)}`)
    return true
  }

  /** Grading question `id` failed: shown in its thread (with Try again) and logged. */
  private fail(id: string, e: GradeError): void {
    const n = this.ports.threads.noteOf(id)
    if (n) this.states.fail(id, n.data.id, e)
    this.ports.log.error(`${id}: ${e.message}`)
  }

  /** The Check view and the threads drawn again ("Checking…" comes and goes). */
  private changed(): void {
    this.ports.post()
    this.host.refresh()
  }
}
