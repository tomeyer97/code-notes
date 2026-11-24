// Claude writes the check: the questions (skills/understanding-check), then the tour of the change through the code
// they are about (its section "The tour", with the code-journey skill's journey.py). In the foreground (a progress
// notification, question 1 opens) or in the background (after a push: nothing is said until the person clicks).
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Ask, AskResult } from '../platform/agent/claude'
import { gitOut, statusPaths } from '../platform/git'
import { clock } from '../core/writing'
import { DEFAULT_MODEL_LABEL, ORPHAN_MAX_MS, SKILL, TICK_MS, WRITING_KEY } from './constants'
import type { CheckController } from './controller'
import { writeFailure } from './failures'
import { costOf } from './log'
import { checkPhase, checkPrompt, tourPrompt } from './prompts'
import type { Status } from './types'
import { busyLabel } from './viewModel'

/** A run of Claude writing (the questions or the tour): when it started, what it does now, for which branch. */
interface Run { started: number; phase: string; branch: string; ask?: Ask }
/** Claude Code (`claude`) asked `prompt` with a model, for run `run` (its phase follows what Claude does). */
interface SkillRun { claude: string; prompt: string; model: string | undefined; run: Run }

export class Writer {
  /** The questions being written now. */
  writing: Run | undefined
  /** The tour being written (after the questions: they can be answered meanwhile). */
  touring: (Run & { session?: string; topUp: boolean; paused?: boolean }) | undefined
  /** The branch whose last try at the tour failed. */
  tourFailed: string | undefined
  /** The tour was being written when its branch was switched away: stopped, and written again once it is back. */
  private tourPaused: { branch: string; session?: string; topUp: boolean } | undefined
  /** Writing the questions failed (said in the view with Retry until a retry works). */
  failed: { branch: string; topUp: boolean; text: string; setting?: boolean; path?: boolean } | undefined
  /** Questions written in the background and not opened yet: the status bar says how many are ready. */
  ready = 0
  /** One line about what the questions left out, for this branch. */
  notice: { branch: string; text: string } | undefined
  /** Nothing of the change was committed when Start was asked for (Commit…): the check starts once it is (branch). */
  startAfterCommit: string | undefined
  /** Ticks the view while questions written before a reload are still being written. */
  private orphanTimer: NodeJS.Timeout | undefined

  constructor(private ctl: CheckController) {}

  private get host() { return this.ctl.host }

  /** Claude writes the questions with the skill, for the branch checked out now; then question 1 opens. */
  async write(topUp: boolean, o: { background?: boolean } = {}): Promise<boolean> {
    const ctl = this.ctl, st = ctl.st!
    const bg = !!o.background
    if (this.writing) { if (!bg) ctl.show(); return false }
    const ask = await this.preflight(st, topUp, bg)
    if (!ask) return false
    const w: Run = (this.writing = { started: Date.now(), phase: 'starting', branch: st.branch })
    ctl.showWritingItem()
    const how = `${topUp ? 'topping up' : 'writing'} the questions for ${st.branch}${bg ? ' in the background' : ''}`
    ctl.log.info(`Claude (${ask.model ?? 'default model'}) is ${how}`)
    let res: AskResult
    try {
      const run = { ...ask, run: w }
      res = bg ? await this.askQuietly(run) : await this.askWithProgress(run, topUp ? 'Adding questions' : 'Writing questions')
    } finally {
      this.writing = undefined
      void this.host.memento.update(WRITING_KEY, undefined)
    }
    const before = st.check?.questions.length ?? 0
    if (await this.branchSwitched(w, bg)) return false
    await ctl.refresh()
    if (res.cancelled) return false
    return this.finish(res, { w, topUp, bg, before, model: ask.model })
  }

  /**
   * Before Claude writes: Claude may run here (in the background: the folder is trusted; nothing is asked), what the
   * questions leave out is noted, Claude Code is found (else that is said, and the prompt goes to the clipboard).
   */
  private async preflight(st: Status, topUp: boolean, bg: boolean): Promise<(Omit<SkillRun, 'run'> & { dir: string }) | undefined> {
    if (!this.trusted(bg, 'write understanding-check questions')) return undefined
    // Uncommitted work doesn't stop the start: the view names what the questions leave out.
    if (!bg) {
      this.failed = undefined
      await this.noteLoose(st.branch)
    }
    const claude = this.host.cli()
    const { dir, bundled } = this.skill()
    const baseRef = st.baseRef ?? 'the default branch'
    const prompt = checkPrompt({ skill: dir, branch: st.branch, baseRef, base: st.base ?? 'main', topUp, bundled, head: st.head })
    if (!claude && bg) return undefined
    if (!claude) {
      // Said in the view (install it, or set its path); the prompt is on the clipboard for another agent.
      await vscode.env.clipboard.writeText(prompt)
      this.failed = { branch: st.branch, topUp, text: "Claude Code wasn't found.", path: true }
      this.ctl.post()
      return undefined
    }
    return { claude, prompt, dir, model: this.host.model() }
  }

  /**
   * The branch was switched while Claude worked (`w`): true, and its questions wait in the cache (the script writes them
   * there; a file it wrote just before the switch is moved there) until it is checked out again. Nothing else happens:
   * nothing opens, nothing is written to the branch checked out now.
   */
  private async branchSwitched(w: Run, bg: boolean): Promise<boolean> {
    const ctl = this.ctl, repo = ctl.repo!
    const now = await gitOut(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (!now || now === w.branch) return false
    await ctl.parking.park(w.branch)
    const kept = fs.existsSync(path.join(repo, ctl.cli.cachedFor(w.branch)))
    if (kept && !bg) void vscode.window.showInformationMessage(`Questions for ${w.branch} are ready: switch back to answer them.`)
    ctl.log.info(`the branch changed to ${now} while writing for ${w.branch}${kept ? '; kept for it' : ''}`)
    await ctl.refresh()
    return true
  }

  /**
   * After a run on the same branch: no new questions is a failure, said in the Check view with Retry (and logged);
   * else question 1 opens (in the background: the status bar counts them) and the tour is written next.
   */
  private async finish(res: AskResult, o: { w: Run; topUp: boolean; bg: boolean; before: number; model: string | undefined }): Promise<boolean> {
    const ctl = this.ctl, { w, topUp, bg, before } = o
    const fail = (f: { text: string; setting?: boolean }, detail: string) => {
      ctl.log.error(`no questions for ${w.branch}: ${detail}`)
      if (!bg) {
        this.failed = { branch: w.branch, topUp, ...f }
        ctl.post()
      }
      return false
    }
    if (res.error) return fail(writeFailure({ error: res.error, errorKind: res.errorKind, model: o.model }), res.error)
    const after = ctl.st?.check?.questions.length ?? 0
    if (after <= before) return fail(writeFailure({ text: res.text }), res.text.trim().split('\n').slice(-1)[0] ?? '')
    this.failed = undefined
    ctl.log.info(`${after - before} questions written${took(w, res)}`)
    // Then the tour, in the same session (the change is read already); the questions can be answered meanwhile. It
    // starts once question 1 is open (its thread has the keyboard before anything else is drawn).
    const tour = () => void this.writeTour(topUp, { session: res.sessionId, background: bg })
    // In the background: the status bar says so; nothing opens until the person clicks.
    if (bg) {
      this.ready = after - before
      await ctl.refresh()
      tour()
      return true
    }
    // Only the first question opens: its code and its thread. The list is in the Check view.
    await ctl.openNext()
    tour()
    return true
  }

  /** Claude may run (`what`: for the trust prompt); in the background only in a trusted folder, nothing asked. */
  private trusted(bg: boolean | undefined, what: string): boolean {
    return bg ? vscode.workspace.isTrusted : this.host.allowed(what)
  }

  /**
   * Claude writes the check's tour: a journey of the change through the code the questions are about, each question
   * placed after the step that shows its answer (skills/understanding-check, "The tour"). No progress notification:
   * the Check view says "Writing the tour · 1:20"; the questions stay open meanwhile. `topUp`: steps for the new part.
   */
  async writeTour(topUp: boolean, o: { session?: string; background?: boolean } = {}): Promise<boolean> {
    const ctl = this.ctl, repo = ctl.repo, check = ctl.st?.check
    if (!repo || !check || this.touring) return false
    if (!this.trusted(o.background, 'write the tour of your change')) return false
    const claude = this.host.cli()
    const js = this.host.journeySkill()
    if (!claude || !js) {
      ctl.log.info(`no tour (${!claude ? 'no claude CLI' : 'no code-journey skill'})`)
      return false
    }
    const { dir, bundled } = this.skill()
    const model = this.host.model()
    const before = check.journey?.steps.length ?? 0
    const branch = ctl.st!.branch
    const t: NonNullable<Writer['touring']> = (this.touring = { started: Date.now(), phase: 'starting', branch, session: o.session, topUp })
    this.tourFailed = undefined
    ctl.post()
    const timer = setInterval(() => ctl.post(), TICK_MS)
    this.ctl.log.info(`Claude (${model ?? 'default model'}) is writing the tour of ${branch}${o.session ? ' (same session)' : ''}`)
    let res: AskResult
    try {
      const ask = this.askSkill({
        claude, model, resume: o.session, run: t,
        prompt: tourPrompt({ skill: dir, journeySkill: js, topUp: topUp && before > 0, bundled, resumed: !!o.session }),
        dirs: [dir, js],
        env: { JOURNEY_PY: path.join(js, 'scripts', 'journey.py'), JOURNEY_MODEL: model ?? DEFAULT_MODEL_LABEL },
      })
      res = await ask.done
    } finally {
      clearInterval(timer)
      this.touring = undefined
    }
    await ctl.refresh()
    if (res.cancelled || t.paused) return false
    const after = ctl.st?.check?.journey?.steps.length ?? 0
    // Documentation that describes no code: no tour, on purpose.
    if (!res.error && !before && ctl.st?.check?.noTour) {
      this.ctl.log.info(`no tour for ${branch}: the text describes no code`)
      ctl.post()
      return true
    }
    if (res.error || after <= before) {
      // A short reason; Claude's own reply (it may talk to someone who isn't there) only in the debug log.
      this.ctl.log.error(`no tour for ${branch}: ${res.error ? res.error.split('\n')[0].slice(0, 160) : 'Claude wrote none'}`)
      if (!res.error) this.ctl.log.debug(`the tour writer said: ${res.text.trim().slice(-400)}`)
      this.tourFailed = branch
      ctl.post()
      return false
    }
    ctl.log.info(`tour written (${after - before} steps)${took(t, res)}`)
    if (!o.background && ctl.st?.state.phase !== 'done') {
      const offer = vscode.window.showInformationMessage('The tour of your change is ready.', 'Walk it')
      void offer.then((b) => { if (b) void this.host.walkTour() })
    }
    return true
  }

  /**
   * Claude Code with a skill: its scripts may run (Bash on `dirs`' scripts/ only) and read `dirs`; the scripts find
   * the understanding CLI and the model's name in the environment. `run.phase` follows what Claude does.
   */
  private askSkill(o: SkillRun & { dirs: string[]; resume?: string; env?: Record<string, string>; onPhase?: () => void }): Ask {
    const ask = new Ask({
      cli: o.claude, cwd: this.ctl.repo!, prompt: o.prompt, model: o.model, resume: o.resume,
      extraTools: o.dirs.map((d) => `Bash(${d}/scripts/*)`), addDirs: o.dirs,
      env: { UNDERSTANDING_CLI: this.ctl.cliPath, UNDERSTANDING_MODEL_LABEL: o.model ?? DEFAULT_MODEL_LABEL, ...o.env },
      onProgress: (p) => {
        const ph = checkPhase(p.tool, o.run.phase)
        if (ph === o.run.phase) return
        o.run.phase = ph
        o.onPhase?.()
      },
    })
    o.run.ask = ask
    return ask
  }

  /** The questions, without a progress notification (the background run). */
  private askQuietly(o: SkillRun & { dir: string }): Promise<AskResult> {
    const ask = this.askSkill({ ...o, dirs: [o.dir] })
    this.remember(o.run)
    return ask.done
  }
  /** The questions, with a progress notification: the clock and the phase, and Cancel. */
  private askWithProgress(o: SkillRun & { dir: string }, title: string): Promise<AskResult> {
    const w = o.run
    return Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
      const tick = () => {
        progress.report({ message: `${clock(Date.now() - w.started)} · ${w.phase}` })
        this.ctl.post()
      }
      const ask = this.askSkill({ ...o, dirs: [o.dir], onPhase: tick })
      this.remember(w)
      token.onCancellationRequested(() => ask.cancel())
      tick()
      const t = setInterval(tick, TICK_MS)
      try { return await ask.done } finally { clearInterval(t) }
    }))
  }
  /** The writer, for a window reloaded before it is done (see orphan). */
  private remember(w: Run): void { void this.host.memento.update(WRITING_KEY, { branch: w.branch, started: w.started, pid: w.ask?.pid }) }

  /** Questions for this branch still being written by a Claude Code started before the window was reloaded. */
  orphan(): { started: number } | undefined {
    const o = this.host.memento.get<{ branch: string; started: number; pid?: number }>(WRITING_KEY)
    const st = this.ctl.st
    if (!o || !st || o.branch !== st.branch || !o.pid || Date.now() - o.started > ORPHAN_MAX_MS) return undefined
    try {
      process.kill(o.pid, 0)
      return { started: o.started }
    } catch {
      return undefined
    }
  }
  /** While an orphan writes: the view ticks; once it is gone, a refresh shows what it wrote. */
  private watchOrphan(): void {
    if (this.orphanTimer) return
    this.orphanTimer = setInterval(() => {
      if (this.orphan()) { this.ctl.post(); return }
      clearInterval(this.orphanTimer)
      this.orphanTimer = undefined
      this.ctl.refreshSoon(0)
    }, TICK_MS)
  }

  /** "Writing questions · 0:42 · reading the change" (or for another branch, or an orphan's), else "Pushing…". */
  busy(): string | undefined {
    const st = this.ctl.st!, w = this.writing
    if (w && w.branch === st.branch) return `${busyLabel('Writing questions', w.started)} · ${w.phase}`
    // Writing for another branch (switched meanwhile): said with its name, never as this branch's progress.
    if (w) return busyLabel(`Writing questions for ${w.branch}`, w.started)
    const orphan = st.state.phase === 'none' ? this.watchedOrphan() : undefined
    if (this.ctl.push.pushing) return 'Pushing…'
    return orphan ? busyLabel('Writing questions', orphan.started) : undefined
  }
  /** The orphan (see orphan()), if any; while there is one, the view ticks until it is gone (watchOrphan). */
  private watchedOrphan(): { started: number } | undefined {
    const orphan = this.orphan()
    if (orphan) this.watchOrphan()
    return orphan
  }
  /** "Writing the tour · 1:20", while the tour of this branch is written. */
  tourBusy(): string | undefined {
    const t = this.touring
    return t && t.branch === this.ctl.st?.branch ? busyLabel('Writing the tour', t.started) : undefined
  }

  /** The tour reads the code checked out: another branch stops it (its check is left as it was); back, it goes on. */
  followBranch(): void {
    const st = this.ctl.st, t = this.touring
    if (t && st && st.branch !== t.branch && !t.paused) {
      t.paused = true
      this.tourPaused = { branch: t.branch, session: t.session, topUp: t.topUp }
      this.ctl.log.info(`tour paused: the branch changed to ${st.branch}`)
      t.ask?.cancel()
    }
    const p = this.tourPaused
    if (p && !this.touring && st?.branch === p.branch && st.check) {
      this.tourPaused = undefined
      this.ctl.log.info(`back on ${p.branch}: the tour goes on`)
      setTimeout(() => void this.writeTour(p.topUp, { session: p.session }), 0)
    }
  }
  /** Commit… was asked for before the start: once the change is committed (no check yet), the questions are written. */
  startIfCommitted(): void {
    const st = this.ctl.st
    if (this.startAfterCommit && this.startAfterCommit === st?.branch && st.state.phase === 'none' && !this.ctl.uncommittedOnly && !this.writing) {
      this.startAfterCommit = undefined
      setTimeout(() => void this.write(false), 0)
    }
  }

  /** The skill: the repository's copy, the home folder's, else the one inside the extension. */
  private skill(): { dir: string; bundled: boolean } {
    const bundled = vscode.Uri.joinPath(this.host.extUri, 'skills', SKILL).fsPath
    const dirs = [path.join(this.ctl.repo!, '.claude/skills', SKILL), path.join(os.homedir(), '.claude/skills', SKILL), bundled]
    const dir = dirs.find((d) => fs.existsSync(path.join(d, 'scripts', 'questions.mjs')))!
    return { dir, bundled: dir === bundled }
  }

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
    const out = await gitOut(this.ctl.repo!, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], true)
    const files = statusPaths(out ?? '').filter((f) => !this.ctl.cli.own(f))
    return files.length ? `Not asked about (uncommitted): ${files.map((f) => path.basename(f)).join(', ')}` : undefined
  }
}

/** " in 1:20, $0.123": how long run `r` took, and what it cost. */
const took = (r: Run, res: AskResult) => ` in ${clock(Date.now() - r.started)}${costOf(res)}`
