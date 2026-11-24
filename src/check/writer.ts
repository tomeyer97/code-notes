// Claude writes the check: the questions (skills/understanding-check), then the tour of the change through the code
// they are about (its section "The tour", with the code-journey skill's journey.py). In the foreground (a progress
// notification, question 1 opens) or in the background (after a push: nothing is said until the person clicks).
// Where each stands is writerState.ts's two state machines; this file runs Claude and reacts to what it did.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import type { AgentRun } from '../platform/agent/agent'
import type { AskResult } from '../platform/agent/claude'
import { agentRunner } from '../platform/agent/runner'
import { withRunProgress } from '../platform/agentProgress'
import { findSkill, type SkillDir } from '../platform/skillDir'
import { gitOut, statusPaths } from '../platform/git'
import { modelLabel } from '../core/agentRun'
import { clock } from '../core/writing'
import { DEFAULT_BRANCHES } from '../../cli/understanding/git'
import { ORPHAN_MAX_MS, SKILL, TICK_MS } from './constants'
import type { CheckHost } from './host'
import type { CheckCore } from './state'
import { writeFailure, type WriteFailure } from './failures'
import { costOf } from './log'
import { checkPhase, checkPrompt, PHASE, tourPrompt } from './prompts'
import type { BranchStatus } from './types'
import { busyLabel } from './viewModel'
import { QuestionsState, TourStates, type CheckRun, type QuestionsFailure, type TourRun } from './writerState'
import { fireAndForget } from '../platform/run'
import { STATE } from '../platform/state'

/** What the writer needs: the check's core, Claude, and the controller's and the other parts' few calls. */
export interface WriterPorts extends Pick<CheckCore, 'state' | 'cli' | 'log' | 'refresh' | 'post'> {
  host: Pick<CheckHost, 'allowed' | 'cli' | 'extUri' | 'journeySkill' | 'model' | 'stored' | 'walkTour'>
  /** cli/understanding.mjs's path (the skills' scripts get it as UNDERSTANDING_CLI). */
  cliPath: string
  refreshSoon(ms: number): void
  /** The status bar says the questions are being written. */
  showWritingItem(): void
  /** The Check view shown. */
  show(): void
  /** The first question not done yet opened. */
  openNext(): Promise<void>
  /** Commit & push is running. */
  pushing(): boolean
  /** The questions written for `branch` moved out of a working tree that has another branch now (park.ts). */
  park(branch: string): Promise<boolean>
}

/** Claude Code with a skill, for the questions or the tour: what it is asked, and what it may run and read. */
interface SkillJob {
  kind: 'questions' | 'tour'
  claude: string
  prompt: string
  model: string | undefined
  /** The skills' folders: their scripts may run, they may be read. */
  dirs: string[]
  resume?: string
  env?: Record<string, string>
}

/** How a run is shown: a progress notification (`title`), the Check view's clock, or nothing (the background). */
type Shown = { kind: 'progress'; title: string } | { kind: 'view' } | { kind: 'quiet' }

/** Whether the questions can be written now: the job, or why not (`no-cli` in the foreground is said already). */
type Preflight = { ok: true; job: SkillJob } | { ok: false; reason: 'untrusted' | 'no-skill' | 'no-cli' }

export class Writer {
  private readonly questions = new QuestionsState()
  private readonly tours = new TourStates()
  /** One line about what the questions left out, for this branch. */
  notice: { branch: string; text: string } | undefined
  /** Nothing of the change was committed when Start was asked for (Commit…): the check starts once it is (branch). */
  private startAfterCommit: string | undefined
  /** Ticks the view while questions written before a reload are still being written. */
  private orphanTimer: NodeJS.Timeout | undefined

  constructor(private ports: WriterPorts) {}

  private get host() { return this.ports.host }

  // ---------- what the controller and the other parts read ----------

  /** The questions being written now. */
  get writing(): CheckRun | undefined { return this.questions.run }
  /** The tour being written (after the questions: they can be answered meanwhile). */
  get touring(): TourRun | undefined { return this.tours.run }
  /** The branch checked out, when its last try at the tour failed. */
  get tourFailed(): string | undefined {
    const branch = this.ports.state.st?.branch
    return this.tours.of(branch).kind === 'failed' ? branch : undefined
  }
  /** Writing the questions failed (said in the view with Retry until a retry works). */
  get failed(): QuestionsFailure | undefined { return this.questions.failure }
  /** Questions written in the background and not opened yet: the status bar says how many. */
  get ready(): number { return this.questions.ready }
  /** Only 0: the questions written in the background are being opened (clearReady). */
  set ready(n: number) { if (!n) this.clearReady() }
  /** The questions written in the background are being opened: the status bar no longer says they are ready. */
  clearReady(): void { this.questions.clearReady() }

  // ---------- the questions ----------

  /** Claude writes the questions with the skill, for the branch checked out now; then question 1 opens. */
  async write(topUp: boolean, o: { background?: boolean } = {}): Promise<boolean> {
    const bg = !!o.background
    if (this.questions.run) {
      if (!bg) this.ports.show()
      return false
    }
    const st = this.ports.state.st!
    const pre = await this.preflight(st, topUp, bg)
    if (!pre.ok) return false
    const run: CheckRun = { started: Date.now(), phase: PHASE.starting, branch: st.branch }
    if (!this.questions.start(run)) return false
    const before = st.check?.questions.length ?? 0
    const res = await this.runQuestions(pre.job, run, topUp, bg)
    return this.afterQuestions(res, { run, topUp, bg, before, model: pre.job.model })
  }

  /**
   * Before Claude writes: Claude may run here (in the background: the folder is trusted; nothing is asked), what the
   * questions leave out is noted, Claude Code is found (else that is said, and the prompt goes to the clipboard).
   */
  private async preflight(st: BranchStatus, topUp: boolean, bg: boolean): Promise<Preflight> {
    if (!this.trusted(bg, 'write understanding-check questions')) return { ok: false, reason: 'untrusted' }
    // Uncommitted work doesn't stop the start: the view names what the questions leave out.
    if (!bg) {
      this.questions.clearFailure()
      await this.noteLoose(st.branch)
    }
    const skill = this.skill()
    if (!skill) return { ok: false, reason: 'no-skill' }
    const prompt = checkPrompt({
      skill: skill.dir, bundled: skill.bundled, branch: st.branch, topUp, head: st.head,
      baseRef: st.baseRef ?? 'the default branch',
      // No base found: the CLI's first usual default branch name.
      base: st.base ?? DEFAULT_BRANCHES[0],
    })
    const claude = this.host.cli()
    if (!claude) {
      if (!bg) await this.noClaude(prompt, { branch: st.branch, topUp })
      return { ok: false, reason: 'no-cli' }
    }
    return { ok: true, job: { kind: 'questions', claude, prompt, model: this.host.model(), dirs: [skill.dir] } }
  }
  /** No Claude Code: said in the view (install it, or set its path); the prompt is on the clipboard for another agent. */
  private async noClaude(prompt: string, o: { branch: string; topUp: boolean }): Promise<void> {
    await vscode.env.clipboard.writeText(prompt)
    this.questions.cantStart({ ...o, text: "Claude Code wasn't found.", path: true })
    this.ports.post()
  }

  /** Claude writes the questions (`run`): in the background quietly, else in a progress notification. */
  private async runQuestions(job: SkillJob, run: CheckRun, topUp: boolean, bg: boolean): Promise<AskResult> {
    this.ports.showWritingItem()
    const how = `${topUp ? 'topping up' : 'writing'} the questions for ${run.branch}${bg ? ' in the background' : ''}`
    this.ports.log.info(`Claude (${modelLabel(job.model)}) is ${how}`)
    const shown: Shown = bg ? { kind: 'quiet' } : { kind: 'progress', title: topUp ? 'Adding questions' : 'Writing questions' }
    try {
      return await this.runSkill(job, run, shown)
    } finally {
      this.questions.ended()
      fireAndForget(this.host.stored.set(STATE.checkWriting, undefined), 'writer: store checkWriting')
    }
  }

  /**
   * After the questions' run: a switched branch keeps them aside; no new questions is a failure, said in the Check
   * view with Retry (and logged); else question 1 opens (in the background: the status bar counts them) and the tour
   * is written next.
   */
  private async afterQuestions(res: AskResult, o: { run: CheckRun; topUp: boolean; bg: boolean; before: number; model?: string }): Promise<boolean> {
    const ports = this.ports
    if (await this.branchSwitched(o.run, o.bg)) return false
    await ports.refresh()
    if (res.cancelled) return false
    const after = ports.state.st?.check?.questions.length ?? 0
    if (res.error) return this.recordFailure(writeFailure({ error: res.error, errorKind: res.errorKind, model: o.model }), res.error, o)
    if (after <= o.before) return this.recordFailure(writeFailure({ text: res.text }), lastLine(res.text), o)
    ports.log.info(`${after - o.before} questions written${took(o.run, res)}`)
    this.questions.wrote(after - o.before, o.bg)
    // In the background: the status bar says so; nothing opens until the person clicks. Else only the first question
    // opens: its code and its thread (the list is in the Check view).
    if (o.bg) await ports.refresh()
    else await ports.openNext()
    // Then the tour, in the same session (the change is read already); the questions can be answered meanwhile. It
    // starts once question 1 is open (its thread has the keyboard before anything else is drawn).
    fireAndForget(this.writeTour(o.topUp, { session: res.sessionId, background: o.bg }), 'writer: writeTour')
    return true
  }

  /** No questions for `o.run`'s branch: logged with `detail`; said in the view unless written in the background. */
  private recordFailure(f: WriteFailure, detail: string, o: { run: CheckRun; topUp: boolean; bg: boolean }): false {
    this.ports.log.error(`no questions for ${o.run.branch}: ${detail}`)
    this.questions.failed({ branch: o.run.branch, topUp: o.topUp, ...f }, o.bg)
    if (!o.bg) this.ports.post()
    return false
  }

  /**
   * The branch was switched while Claude worked (`run`): true, and its questions wait in the cache (the script writes
   * them there; a file it wrote just before the switch is moved there) until it is checked out again. Nothing else
   * happens: nothing opens, nothing is written to the branch checked out now.
   */
  private async branchSwitched(run: CheckRun, bg: boolean): Promise<boolean> {
    const ports = this.ports, repo = ports.state.repo!
    const now = await gitOut(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (!now || now === run.branch) return false
    await ports.park(run.branch)
    const kept = fs.existsSync(path.join(repo, ports.cli.cachedFor(run.branch)))
    if (kept && !bg) {
      const said = vscode.window.showInformationMessage(`Questions for ${run.branch} are ready: switch back to answer them.`)
      fireAndForget(said, 'writer: window.showInformationMessage')
    }
    ports.log.info(`the branch changed to ${now} while writing for ${run.branch}${kept ? '; kept for it' : ''}`)
    await ports.refresh()
    return true
  }

  /** Claude may run (`what`: for the trust prompt); in the background only in a trusted folder, nothing asked. */
  private trusted(bg: boolean | undefined, what: string): boolean {
    return bg ? vscode.workspace.isTrusted : this.host.allowed(what)
  }

  // ---------- the tour ----------

  /**
   * Claude writes the check's tour: a journey of the change through the code the questions are about, each question
   * placed after the step that shows its answer (skills/understanding-check, "The tour"). No progress notification:
   * the Check view says "Writing the tour · 1:20"; the questions stay open meanwhile. `topUp`: steps for the new part.
   */
  async writeTour(topUp: boolean, o: { session?: string; background?: boolean } = {}): Promise<boolean> {
    const ports = this.ports, check = ports.state.st?.check
    if (!ports.state.repo || !check || this.tours.run) return false
    if (!this.trusted(o.background, 'write the tour of your change')) return false
    const job = this.tourJob(topUp && (check.journey?.steps.length ?? 0) > 0, o.session)
    if (!job) return false
    const before = check.journey?.steps.length ?? 0
    const run: TourRun = { started: Date.now(), phase: PHASE.starting, branch: ports.state.st!.branch, session: o.session, topUp }
    if (!this.tours.start(run)) return false
    ports.post()
    ports.log.info(`Claude (${modelLabel(job.model)}) is writing the tour of ${run.branch}${o.session ? ' (same session)' : ''}`)
    let res: AskResult, paused: boolean
    try {
      res = await this.runSkill(job, run, { kind: 'view' })
    } finally {
      paused = !this.tours.ended(run)
    }
    await ports.refresh()
    if (res.cancelled || paused) return false
    return this.afterTour(res, run, before, !!o.background)
  }

  /** Claude Code with both skills, for the tour; undefined (logged) without Claude Code or the code-journey skill. */
  private tourJob(topUp: boolean, session: string | undefined): SkillJob | undefined {
    const claude = this.host.cli()
    const js = this.host.journeySkill()
    const skill = this.skill()
    if (!claude || !js || !skill) {
      this.ports.log.info(`no tour (${!claude ? 'no claude CLI' : !js ? 'no code-journey skill' : 'no understanding-check skill'})`)
      return undefined
    }
    const model = this.host.model()
    return {
      kind: 'tour', claude, model, resume: session,
      prompt: tourPrompt({ skill: skill.dir, journeySkill: js, topUp, bundled: skill.bundled, resumed: !!session }),
      dirs: [skill.dir, js],
      env: { JOURNEY_PY: path.join(js, 'scripts', 'journey.py'), JOURNEY_MODEL: modelLabel(model) },
    }
  }

  /** After the tour's run: written (offered, in the foreground), none on purpose, or a failure (offered again). */
  private afterTour(res: AskResult, run: TourRun, before: number, bg: boolean): boolean {
    const ports = this.ports, check = ports.state.st?.check
    const after = check?.journey?.steps.length ?? 0
    // Documentation that describes no code: no tour, on purpose.
    if (!res.error && !before && check?.noTour) {
      ports.log.info(`no tour for ${run.branch}: the text describes no code`)
      ports.post()
      return true
    }
    if (res.error || after <= before) {
      // A short reason; Claude's own reply (it may talk to someone who isn't there) only in the debug log.
      ports.log.error(`no tour for ${run.branch}: ${res.error ? res.error.split('\n')[0].slice(0, 160) : 'Claude wrote none'}`)
      if (!res.error) ports.log.debug(`the tour writer said: ${res.text.trim().slice(-400)}`)
      this.tours.failed(run.branch)
      ports.post()
      return false
    }
    ports.log.info(`tour written (${after - before} steps)${took(run, res)}`)
    if (!bg && ports.state.st?.state.phase !== 'done') this.offerWalk()
    return true
  }
  /** "The tour of your change is ready." with Walk it. */
  private offerWalk(): void {
    const offer = vscode.window.showInformationMessage('The tour of your change is ready.', 'Walk it')
    fireAndForget(offer.then((b) => { if (b) fireAndForget(this.host.walkTour(), 'writer: host.walkTour') }), 'writer: offer.then')
  }

  // ---------- running Claude ----------

  /** Claude on `job` for `run`, shown as `shown` says: its result once it ends. */
  private async runSkill(job: SkillJob, run: CheckRun, shown: Shown): Promise<AskResult> {
    switch (shown.kind) {
      case 'quiet':
        return this.startSkill(job, run).done
      case 'progress':
        return withRunProgress(run, shown.title, (tick) => this.startSkill(job, run, tick), () => this.ports.post())
      case 'view': {
        // The Check view's clock ("Writing the tour · 1:20").
        const timer = setInterval(() => this.ports.post(), TICK_MS)
        try {
          return await this.startSkill(job, run).done
        } finally {
          clearInterval(timer)
        }
      }
    }
  }

  /**
   * Claude Code with a skill, listed with the agent runner's runs: its scripts may run (Bash on the skills' scripts/
   * only) and read the skills' folders; the scripts find the understanding CLI and the model's name in the
   * environment. `run.phase` follows what Claude does (`onPhase` when it changes).
   */
  private startSkill(job: SkillJob, run: CheckRun, onPhase?: () => void): AgentRun {
    const label = `${job.kind === 'tour' ? 'The tour' : 'Questions'} of ${run.branch}`
    const agent = agentRunner().start(job.claude, { key: `check:${job.kind}:${run.branch}`, purpose: 'check', label }, {
      cwd: this.ports.state.repo!, prompt: job.prompt, model: job.model, resume: job.resume,
      extraTools: job.dirs.map((d) => `Bash(${d}/scripts/*)`), addDirs: job.dirs,
      env: { UNDERSTANDING_CLI: this.ports.cliPath, UNDERSTANDING_MODEL_LABEL: modelLabel(job.model), ...job.env },
      onProgress: (p) => {
        const phase = checkPhase(p.tool, run.phase)
        if (phase === run.phase) return
        run.phase = phase
        onPhase?.()
      },
    })
    run.agent = agent
    if (job.kind === 'questions') this.remember(run)
    return agent
  }

  /** The skill: the repository's copy, the home folder's, else the one inside the extension. */
  private skill(): SkillDir | undefined {
    const bundled = vscode.Uri.joinPath(this.host.extUri, 'skills').fsPath
    const found = findSkill(SKILL, { repo: this.ports.state.repo, bundled, marker: 'scripts/questions.mjs' })
    if (!found) this.ports.log.error(`no ${SKILL} skill (not even the extension's own copy)`)
    return found
  }

  // ---------- a writer from before a reload (an orphan) ----------

  /** The writer, for a window reloaded before it is done (see orphan). */
  private remember(run: CheckRun): void {
    const writing = { branch: run.branch, started: run.started, pid: run.agent?.pid }
    fireAndForget(this.host.stored.set(STATE.checkWriting, writing), 'writer: store checkWriting')
  }

  /**
   * Questions for this branch still being written by a Claude Code started before the window was reloaded: its
   * process still answers signal 0. A pid can be reused by another process; that is acceptable here because the
   * record is only trusted for ORPHAN_MAX_MS after the start and, for that branch, while it has no check: at worst
   * the view shows a busy clock that ends there, and nothing is written or stopped on that process's behalf.
   */
  orphan(): { started: number } | undefined {
    const o = this.host.stored.get(STATE.checkWriting)
    const st = this.ports.state.st
    if (!o || !st || o.branch !== st.branch || !o.pid || Date.now() - o.started > ORPHAN_MAX_MS) return undefined
    try {
      process.kill(o.pid, 0)
      return { started: o.started }
    } catch {
      return undefined
    }
  }
  /** While an orphan writes (no check yet): the view ticks; once it is gone, a refresh shows what it wrote. */
  private watchOrphan(): void {
    if (this.orphanTimer || this.ports.state.st?.state.phase !== 'none' || !this.orphan()) return
    this.orphanTimer = setInterval(() => {
      if (this.orphan()) { this.ports.post(); return }
      clearInterval(this.orphanTimer)
      this.orphanTimer = undefined
      this.ports.refreshSoon(0)
    }, TICK_MS)
  }

  // ---------- what the view says ----------

  /** "Writing questions · 0:42 · reading the change" (or for another branch, or an orphan's), else "Pushing…". */
  busy(): string | undefined {
    const st = this.ports.state.st!, w = this.questions.run
    if (w && w.branch === st.branch) return `${busyLabel('Writing questions', w.started)} · ${w.phase}`
    // Writing for another branch (switched meanwhile): said with its name, never as this branch's progress.
    if (w) return busyLabel(`Writing questions for ${w.branch}`, w.started)
    const orphan = st.state.phase === 'none' ? this.orphan() : undefined
    if (this.ports.pushing()) return 'Pushing…'
    return orphan ? busyLabel('Writing questions', orphan.started) : undefined
  }
  /** "Writing the tour · 1:20", while the tour of this branch is written. */
  tourBusy(): string | undefined {
    const t = this.tours.run
    return t && t.branch === this.ports.state.st?.branch ? busyLabel('Writing the tour', t.started) : undefined
  }

  // ---------- following the branch (called from the controller's refresh) ----------

  /**
   * After each refresh read the branch: the tour reads the code checked out, so another branch stops it (its check is
   * left as it was) and, back, it goes on; an orphan's clock starts ticking.
   */
  followBranch(): void {
    const st = this.ports.state.st, t = this.tours.run
    if (t && st && st.branch !== t.branch) {
      this.tours.pause(t)
      this.ports.log.info(`tour paused: the branch changed to ${st.branch}`)
      t.agent?.cancel()
    }
    const p = st?.check ? this.tours.resume(st.branch) : undefined
    if (st && p) {
      this.ports.log.info(`back on ${st.branch}: the tour goes on`)
      this.queueAfterRefresh(() => this.writeTour(p.topUp, { session: p.session }), 'writer: writeTour')
    }
    this.watchOrphan()
  }
  /** Commit… asked for while nothing of the change on `branch` is committed: the questions are written once it is. */
  startOnceCommitted(branch: string): void { this.startAfterCommit = branch }
  /** Retry after writing the questions failed: the same kind of run (a top-up or a start). */
  retry(): Promise<boolean> {
    const topUp = !!this.questions.failure?.topUp
    this.questions.clearFailure()
    return this.write(topUp)
  }
  /** Commit… was asked for before the start: once the change is committed (no check yet), the questions are written. */
  startIfCommitted(): void {
    const st = this.ports.state.st
    if (!this.startAfterCommit || this.startAfterCommit !== st?.branch || this.questions.run) return
    if (st.state.phase !== 'none' || this.ports.state.uncommittedOnly) return
    this.startAfterCommit = undefined
    this.queueAfterRefresh(() => this.write(false), 'writer: write')
  }
  /**
   * `job` once the refresh that called followBranch or startIfCommitted is over: started from inside it, the job's
   * own refresh would join that coalesced run and wait for itself.
   */
  private queueAfterRefresh(job: () => Promise<unknown>, what: string): void {
    setTimeout(() => fireAndForget(job(), what), 0)
  }

  // ---------- what the questions leave out ----------

  /** What the questions left out, said in the view while the branch's check is being answered. */
  async noteLoose(branch: string): Promise<void> {
    const text = await this.loose()
    this.notice = text ? { branch, text } : undefined
  }
  /**
   * Uncommitted and untracked (not ignored) files the questions won't see, as one line for the Check view: "Not asked
   * about (uncommitted): refunds.js, scratch.js". The check's own files don't count.
   */
  private async loose(): Promise<string | undefined> {
    const out = await gitOut(this.ports.state.repo!, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], true)
    const files = statusPaths(out ?? '').filter((f) => !this.ports.cli.own(f))
    return files.length ? `Not asked about (uncommitted): ${files.map((f) => path.basename(f)).join(', ')}` : undefined
  }
}

/** " in 1:20, $0.123": how long run `r` took, and what it cost. */
const took = (r: CheckRun, res: AskResult) => ` in ${clock(Date.now() - r.started)}${costOf(res)}`
/** The last line of Claude's reply (what it said when it wrote nothing), for the log. */
const lastLine = (text: string) => text.trim().split('\n').at(-1) ?? ''
