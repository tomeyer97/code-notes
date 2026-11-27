// The understanding check's controller (src/check/README.md maps the folder): it builds the parts, each with only the
// ports it uses, and runs what no part owns: the refresh, the command and the Check view's requests (one table of
// actions for both), opening questions, and the answers to what the rest of the extension asks (CheckQuery).
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import type { Note } from '../notes/store'
import { Check, Link, notDone, Question, RefreshResult } from './types'
import { linksAt, gradeMessageAt, gradedAttempts } from './threadText'
import { concernOf, type ConcernAction } from './concernState'
import { type ActionId, CheckView, checkView, definedOnly, runAction, type RunStep, statusText } from './viewModel'
import { gradeFailure } from './failures'
import { Coalesced } from '../core/serial'
import { plural } from '../core/text'
import { BackgroundQuestions } from './background'
import { usesCheck } from './backgroundRule'
import { CliThread } from './cliThread'
import { Concerns } from './concern'
import {
  CHECK_ON_BASE_CONTEXT, CHECK_OPEN_CONTEXT, FIX_REFRESH_MS, INSTALL_URL, REFRESH_SOON_MS, REPO_FILES, REVEAL_RETRY_MS, SETTINGS, settingId, SKILL, VIEW_ID,
} from './constants'
import { Grader } from './grading'
import type { CheckHost } from './host'
import { hostCli } from './cliApi'
import { InvalidFile } from './invalidFile'
import { isCheck, linkOf } from './threadLink'
import { checkLog, type CheckLog } from './log'
import { STATE } from '../platform/state'
import { Parking } from './park'
import { Pusher, unsavedDocument } from './push'
import { CheckThreads } from './threads'
import { CheckViewProvider } from './view'
import type { FromCheck, ToCheck } from '../protocol/check'
import { Writer } from './writer'
import { baseName } from '../core/paths'
import { fireAndForget } from '../platform/run'
import { setCtx } from '../platform/context'
import { HiddenCmd } from '../platform/commands'
import { checkLinkKey } from '../platform/keys'
import { type CheckCore, CheckState, serialScoped } from './state'
import type { CheckQuery, ThreadStatus, TourStop } from './query'
import { nextOpen } from './navigation'
import { CheckStatusItem, type StatusLook } from './statusItem'
import { decodeViewRequest, type ViewRequest, type ViewRequestOf } from './viewRequests'

export type { CheckHost } from './host'
export type { ThreadStatus } from './query'
export { SESSION } from './constants'

/** What a refresh asks the worker (cliWorker.ts refreshState). */
interface RefreshRequest {
  /** The last full refresh's key: a refresh whose inputs hash the same stops there. Undefined: read in full. */
  prev?: string
  /** Files the refresh shows something of (a change of one changes the key): `init`'s, added TODOs', applied fixes'. */
  files: string[]
  /** Untracked files count too (the writer's notice is about them). */
  untracked: boolean
  /** Applied fixes edited and not saved yet: only the editor knows (Commit & push offers them). */
  edited: string[]
}

/** The command's steps that show the Check view along with what they do (the others open something themselves). */
const SHOWN_WITH: ReadonlySet<RunStep> = new Set(['topUp', 'scm', 'commitPush', 'walk'])

export class CheckController implements CheckQuery, vscode.Disposable {
  /** What the check knows now: the parts read it. */
  readonly state: CheckState
  /** The extension's log, each line starting "understanding check: ". */
  readonly log: CheckLog
  /** cli/understanding.mjs's path (the skills' scripts get it as UNDERSTANDING_CLI). */
  readonly cliPath: string
  /** The understanding CLI's functions (cli/understanding.mjs). Not Claude Code (host.cli()). */
  private readonly cli = hostCli
  /** The CLI's git work (status, diffs, identity), on a worker thread started by its first call: never waited for. */
  private readonly worker = new CliThread()
  private readonly view: CheckViewProvider
  private readonly status = new CheckStatusItem()
  private readonly writer: Writer
  private readonly grader: Grader
  private readonly threads: CheckThreads
  private readonly concerns: Concerns
  private readonly push: Pusher
  private readonly parking: Parking
  private readonly background: BackgroundQuestions
  private readonly invalid: InvalidFile

  private readonly changed = new vscode.EventEmitter<void>()
  /** After each full refresh: the check's row in the journeys list, and what the editor shows around it, may have changed. */
  readonly onDidChange = this.changed.event

  // ---------- refresh ----------

  /** init() ran: refreshes read git from then on. */
  private started = false
  /** What the last full refresh read, as one hash (cliWorker.ts, gateKey): a trigger that finds it unchanged stops there. */
  private key: string | undefined
  /** Refreshes done in full and skipped as unchanged (integration test). */
  private counts = { full: 0, same: 0 }
  private timer: NodeJS.Timeout | undefined
  /** The state offBranch read when the notes last followed it (CheckState.offBranchKey). */
  private hidesShown = ''
  /** A refreshSoon meanwhile asked for a full refresh (not gated). */
  private soonForce = false
  /** Run once the current refresh has published (a check put back from the cache opens its first question). */
  private afterRefresh: (() => void)[] = []
  /** One refresh at a time; the calls made meanwhile share one more (coalesced). */
  private runs = new Coalesced((force) => this.doRefresh(force).catch((e) => {
    this.key = undefined
    this.log.error(`${e}`)
  }))

  /** The codeNotes.checkOpen context as last set. */
  private checkOpen: boolean | undefined
  /** The codeNotes.checkOnBase context as last set. */
  private onBase = false
  /** An opened question's reveal retries (REVEAL_RETRY_MS). */
  private revealTimers: NodeJS.Timeout[] = []
  private subs: vscode.Disposable[] = []

  constructor(private readonly host: CheckHost) {
    this.log = checkLog(host.log)
    this.cliPath = vscode.Uri.joinPath(host.extUri, 'cli', 'understanding.mjs').fsPath
    this.state = new CheckState(vscode.workspace.workspaceFolders?.[0], {
      drafts: serialScoped(host.stored.scoped(STATE.checkDrafts)),
      fixes: serialScoped(host.stored.scoped(STATE.checkFixes)),
      todos: serialScoped(host.stored.scoped(STATE.checkTodos)),
    })
    const core: CheckCore = {
      state: this.state, cli: this.cli, log: this.log,
      refresh: (force) => this.refresh(force),
      post: () => this.post(),
      save: (abs, check) => this.save(abs, check),
    }
    this.threads = new CheckThreads({ ...core, host })
    this.grader = new Grader({ ...core, host, worker: this.worker, threads: this.threads })
    this.push = new Pusher({ ...core, host })
    this.parking = new Parking({ ...core, openNextAfterRefresh: () => this.afterRefresh.push(() => fireAndForget(this.openNext(), 'controller: openNext')) })
    this.writer = new Writer({
      ...core, host, cliPath: this.cliPath,
      refreshSoon: (ms) => this.refreshSoon(ms),
      showWritingItem: () => this.status.writing(),
      show: () => this.show(),
      openNext: () => this.openNext(),
      pushing: () => this.push.pushing,
      park: (branch) => this.parking.park(branch),
    })
    this.concerns = new Concerns({ ...core, host, push: this.push })
    this.background = new BackgroundQuestions({
      ...core, host, refreshSoon: (ms, force) => this.refreshSoon(ms, force), writer: this.writer,
      usesCheck: (refs) => (this.state.repo ? usesCheck(this.state.repo, refs) : Promise.resolve(false)),
    })
    this.invalid = new InvalidFile(core)
    this.view = new CheckViewProvider(host.extUri, host.log, (m) => this.onView(m))
    this.subs.push(vscode.window.registerWebviewViewProvider(VIEW_ID, this.view, { webviewOptions: { retainContextWhenHidden: true } }))
  }

  /** The check's git work: the triggers of a refresh, the push watcher, and the first refresh. */
  async init(): Promise<void> {
    this.started = true
    this.ensureSkillExecutable()
    const f = this.state.folder
    if (!f || f.uri.scheme !== 'file') return
    this.watchTriggers(f)
    this.background.watchPushes()
    await this.refresh()
  }

  /** Claude runs the skill's script by its path: it must be executable (an unzip may have dropped the bit). */
  private ensureSkillExecutable(): void {
    const script = vscode.Uri.joinPath(this.host.extUri, 'skills', SKILL, 'scripts', 'questions.mjs').fsPath
    if (isExecutable(script)) return
    try {
      fs.chmodSync(script, 0o755)
    } catch (e) {
      // A read-only install: Claude will say it can't run the script; this says why.
      this.log.debug(`couldn't make ${script} executable: ${e}`)
    }
  }

  /**
   * Every trigger goes through the same check (gated): a refresh reads git only when something it shows can have
   * changed. No watcher on .git/index: any `git status` (VS Code's own Git view, a terminal, an agent) rewrites it,
   * which kept the check refreshing over and over; VS Code's git extension says when the working tree changed
   * (background.ts).
   */
  private watchTriggers(f: vscode.WorkspaceFolder): void {
    const later = () => this.refreshSoon(REFRESH_SOON_MS, false)
    // A commit moves the branch (logs/HEAD), not .git/HEAD; a checkout changes both.
    for (const glob of ['understanding/*.json', '.git/HEAD', '.git/logs/HEAD', '.git/refs/remotes/**']) {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(f, glob))
      w.onDidChange(later); w.onDidCreate(later); w.onDidDelete(later)
      this.subs.push(w)
    }
    // An applied fix undone (or edited) before it is saved: what Commit & push offers follows.
    const isFixFile = (doc: vscode.TextDocument) => {
      const repo = this.state.repo
      return !!repo && Object.values(this.state.fixes.get(this.state.st?.branch)).some((file) => doc.uri.fsPath === path.join(repo, file))
    }
    this.subs.push(
      vscode.window.onDidChangeWindowState((s) => { if (s.focused) later() }),
      vscode.workspace.onDidSaveTextDocument(later),
      vscode.workspace.onDidChangeTextDocument((e) => { if (e.contentChanges.length && isFixFile(e.document)) later() }),
    )
  }

  // ---------- refresh ----------

  /** `force` false: a trigger (a file event, focus, a save): skipped when nothing the refresh reads changed. */
  refreshSoon(ms = REFRESH_SOON_MS, force = true): void {
    clearTimeout(this.timer)
    this.soonForce ||= force
    this.timer = setTimeout(() => {
      const f = this.soonForce
      this.soonForce = false
      fireAndForget(this.refresh(f), 'controller: refresh')
    }, ms)
  }

  /**
   * Reads where the branch stands, then the status bar, the threads and the view follow. `force` false: only when
   * something it reads changed since the last refresh (HEAD, a ref, the working tree, the check file, …).
   */
  refresh(force = true): Promise<void> { return this.runs.run(force) }

  /** One refresh, in three phases whose order matters: the branch read, what follows from it, what the window shows. */
  private async doRefresh(force: boolean): Promise<void> {
    const repo = this.state.repo
    if (!repo || !this.started) return
    for (;;) {
      const r = await this.readState(repo, force)
      if (r.same) { this.counts.same++; return }
      this.counts.full++
      // Unknown until this refresh is through (a failure part way leaves it unknown: the next trigger reads again).
      this.key = undefined
      // A check put back from the cache: read again at once, within this same run (not a new coalesced one).
      if (await this.readBranch(repo, r)) { force = true; continue }
      await this.reconcile(repo)
      await this.publish()
      this.key = r.key
      for (const run of this.afterRefresh.splice(0)) run()
      return
    }
  }
  /** Where the branch stands, read on the worker (gated by the last key unless `force`). */
  private readState(repo: string, force: boolean): Promise<RefreshResult> {
    const fixFiles = Object.values(this.state.fixes.get(this.state.st?.branch))
    const req: RefreshRequest = {
      prev: force ? undefined : this.key,
      files: [...REPO_FILES, ...this.state.todoFiles(), ...fixFiles],
      untracked: !!this.writer.notice,
      edited: fixFiles.filter((f) => !!unsavedDocument(repo, f)),
    }
    // The worker hashes `extra` with the rest of the key: one string.
    const { edited, ...o } = req
    return this.worker.api.refreshState(repo, { ...o, extra: edited.join('\0') })
      .catch((e: Error): RefreshResult => ({ error: e.message }))
  }
  /**
   * The branch as read: another branch checked out is handled, Commit & push and the writer follow it. True: a check
   * parked for this branch was put back (read again).
   */
  private async readBranch(repo: string, r: RefreshResult): Promise<boolean> {
    const before = this.state.st?.branch
    this.state.read(r.st, r.ident)
    if (!r.st) this.log.info(`no status (${r.error ?? 'unknown'})`)
    const st = this.state.st
    if (st && st.branch !== before) await this.branchChanged(before)
    await this.push.forgetIfMoved(repo)
    this.writer.followBranch()
    return !!st && !st.exists && (await this.parking.restore())
  }
  /** What follows from the branch: its words, whether anything is committed, the writer's start, Commit & push's plan. */
  private async reconcile(repo: string): Promise<void> {
    const st = this.state.st
    this.state.setWords(st ? this.cli.stateWords(st.state, st) : undefined)
    this.state.setUncommittedOnly(await this.nothingCommitted(repo))
    this.writer.startIfCommitted()
    await this.push.read(repo)
    // What the questions left out: only while it still is uncommitted (committed or reverted since: the line goes).
    const notice = this.writer.notice
    if (notice && notice.branch === st?.branch && !this.writer.writing) await this.writer.noteLoose(notice.branch)
  }
  /** What the window shows follows: the status bar, the threads, the context key, the tour, the view, the journeys list. */
  private async publish(): Promise<void> {
    const st = this.state.st
    // Another branch's notes hidden (or back): the notes' threads and lists follow. The branch watcher's own pass may
    // have run before this refresh read the branch, and hidden nothing.
    const hides = this.state.offBranchKey
    if (hides !== this.hidesShown) {
      this.hidesShown = hides
      this.host.refresh()
    }
    if (!this.writer.writing) this.status.show(this.statusLook())
    if (st?.check) await this.threads.sync(st.check)
    // While there is a check, an empty Code Notes view steps aside: the Check view gets its room (package.json).
    this.setCheckOpen(!!st?.check)
    // On a default branch with no check file there is nothing to check: the Check view is hidden (package.json).
    this.onBase = !!st?.onBase && !st.exists
    fireAndForget(setCtx(CHECK_ON_BASE_CONTEXT, this.onBase), 'controller: checkOnBase')
    // A file that can't be read (a bad edit, a conflict) keeps the tour shown as it was until it reads again.
    if (st?.state.phase !== 'invalid') await this.host.tourChanged(st?.check, this.state.abs, st?.branch)
    this.post()
    this.changed.fire()
  }
  /** Another branch is checked out (`before`: the one left, if any). */
  private async branchChanged(before: string | undefined): Promise<void> {
    this.push.forgetBranch()
    this.state.branchLeft()
    // The branch left behind had an unfinished check (untracked): it waits in the cache, not in this branch's tree.
    if (before) await this.parking.left(before)
  }
  /** No check yet and nothing of the change committed (the questions would have nothing to ask about). */
  private async nothingCommitted(repo: string): Promise<boolean> {
    const st = this.state.st
    // Only a branch with no check yet and a change to ask about can have nothing of it committed.
    if (st?.state.phase !== 'none' || !st.base || !st.head || st.changed <= 0) return false
    const exempt = this.cli.loadConfig(repo).exempt
    return this.worker.api.codeStat(repo, st.base, st.head, exempt).then((s) => this.cli.linesOf(s) === 0, () => false)
  }
  private setCheckOpen(open: boolean): void {
    if (open === this.checkOpen) return
    this.checkOpen = open
    fireAndForget(vscode.commands.executeCommand('setContext', CHECK_OPEN_CONTEXT, open), 'controller: command setContext')
  }
  /** The status bar item, from the CLI's words: questions written in the background say they are ready. */
  private statusLook(): StatusLook | undefined {
    const st = this.state.st, words = this.state.words, ready = this.writer.ready
    const t = statusText(st, words)
    if (!t) return undefined
    if (ready && st?.state.phase === 'answering' && !st.summary?.done) {
      t.text = `$(checklist) ${plural(ready, 'question')} ready`
      t.tip = `Questions about ${st.branch} are ready · Check my understanding`
    }
    // Done: the same words as the Check view ("Pushed.", "Not pushed yet."), not the file's alone.
    const line = st?.state.phase === 'done' ? this.current()?.line : undefined
    if (line) t.tip = [words?.title, line].filter(Boolean).join(' · ')
    return t
  }

  /** The Check view's model: where the check stands, and everything going on now. */
  current(): CheckView | undefined {
    const { st, words, selected } = this.state
    if (!st || !words) return undefined
    const w = this.writer, p = this.push
    /** About this branch (a failure or notice of another branch is not shown). */
    const here = <T extends { branch: string }>(x: T | undefined) => (x?.branch === st.branch ? x : undefined)
    const sel = selected ? this.threads.noteOf(selected) : undefined
    const gradeError = sel && this.grader.errors.get(sel.data.id)
    const failed = here(w.failed)
    const notice = st.state.phase !== 'done' ? here(w.notice) : undefined
    return checkView(st, words, definedOnly({
      error: gradeError ? gradeFailure(gradeError.message, gradeError.kind) : undefined,
      busy: w.busy(),
      tourBusy: w.tourBusy(),
      uncommitted: this.state.uncommittedOnly,
      invalidAt: this.invalid.parseError()?.text,
      tourFailed: w.tourFailed === st.branch,
      grading: new Set([...this.grader.grading.keys(), ...this.grader.answering]),
      unpushed: p.unpushed,
      pushed: p.pushed,
      mr: p.mr || undefined,
      me: this.state.who,
      notice: notice?.text,
      commit: p.commit ? { ...p.commit, include: p.include, exclude: p.exclude } : undefined,
      selected: selected || undefined,
      draft: selected ? this.state.drafts.get(st.file)[selected] ?? '' : undefined,
      failed: failed ? definedOnly({ text: failed.text, setting: failed.setting || undefined, path: failed.path || undefined }) : undefined,
      said: this.state.said || undefined,
    }))
  }
  post(): void { this.view.update(this.current()) }

  // ---------- the command, and the view's buttons ----------

  /** What each of the view's buttons and the command's steps does: one table for both. */
  private readonly actions: Record<ActionId | RunStep, () => Promise<unknown>> = {
    start: () => this.writer.write(false),
    topUp: () => this.writer.write(true),
    scm: () => this.commitFirst(),
    commitPush: () => this.push.commitPush(),
    // A file that can't be read: open it, at the first conflict marker.
    openFile: () => this.invalid.open(),
    merge: () => this.invalid.keepBoth(),
    pull: () => this.push.pull(),
    show: async () => this.show(),
    walk: () => this.walk(),
  }

  /** Check my understanding: write the questions (or top them up), else show them. */
  async run(): Promise<void> {
    if (!this.state.repo) { fireAndForget(vscode.window.showInformationMessage('Open a folder (a git repository) to check your understanding of a change.'), 'controller: window.showInformationMessage'); return }
    // Questions written in the background are being opened: the status bar no longer says they are ready.
    this.writer.ready = 0
    await this.refresh()
    const st = this.state.st
    if (!st) { fireAndForget(vscode.window.showInformationMessage('Check my understanding needs a git repository with a branch to compare.'), 'controller: window.showInformationMessage'); return }
    // Questions written in the background: what they left out, now, as the person opens them.
    if (this.writer.ready) {
      this.writer.ready = 0
      await this.writer.noteLoose(st.branch)
      await this.refresh()
    }
    const step = runAction(st, { commit: this.push.commit, unpushed: this.push.unpushed })
    if (SHOWN_WITH.has(step)) this.show()
    await this.actions[step]()
  }

  show(): void { this.view.reveal() }

  /** Commit…: Source Control. With nothing of the change committed yet, the check starts once it is. */
  private async commitFirst(): Promise<void> {
    const st = this.state.st
    if (this.state.uncommittedOnly && st) this.writer.startOnceCommitted(st.branch)
    await openScm()
  }
  /** A check with a tour opens it (the steps lead to the questions); without one, the first open question. */
  private async walk(): Promise<void> {
    if (this.state.st?.check?.journey && (await this.host.walkTour())) return
    await this.openNext()
  }

  /** Writes the check file with today's line numbers and its result. */
  private save(abs: string, check: Check): void {
    const repo = this.state.repo!
    this.cli.relocate(repo, check)
    this.cli.writeCheck(abs, this.cli.stamp(check, this.cli.loadConfig(repo)))
  }

  // ---------- opening questions ----------

  /** The first question not done yet, else the first one. */
  async openNext(): Promise<void> {
    const c = this.state.st?.check
    if (!c) return
    const q = c.questions.find((x) => this.isOpen(x)) ?? c.questions[0]
    await this.open(q.id)
  }

  /**
   * A question: its code and thread in the code's group, and the keyboard in its answer box in the Check view (never in
   * the code: typing there edits it). Without the view, in the thread.
   */
  async open(id: string): Promise<void> {
    const n = this.threads.noteOf(id)
    if (!n) return
    // The keyboard into the box first, then the code (shown without taking it): no moment where typing edits code.
    this.state.select(id)
    this.post()
    let boxed = true
    try { await this.view.focus(id) } catch { boxed = false }
    await this.host.reveal(n, this.host.codeColumn(), boxed)
    if (!boxed) await this.host.focusReply(n)
    // Its own lines stay in view, also when a tour's step card far from them is drawn a moment later and scrolls there.
    const file = path.join(this.state.repo ?? '', n.data.file), r = n.data.range
    this.clearRevealTimers()
    this.revealTimers = REVEAL_RETRY_MS.map((ms) => setTimeout(() => {
      if (this.state.selected !== id) return
      const ed = vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === file)
      const want = new vscode.Range(r.start - 1, 0, r.end - 1, 0)
      if (ed && !ed.visibleRanges.some((v) => v.contains(want.start))) ed.revealRange(want, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
    }, ms))
  }
  private clearRevealTimers(): void {
    for (const t of this.revealTimers) clearTimeout(t)
    this.revealTimers = []
  }

  /** A question that still asks for an answer. */
  private isOpen(q: Question): boolean { return notDone(this.cli.stateOf(q)) }
  /** Ctrl+' D / A while questions are open: the next or previous one not done, from the one shown now. */
  hasOpen(): boolean { return !!this.state.st?.check?.questions.some((q) => this.isOpen(q)) }
  async step(dir: 1 | -1): Promise<boolean> {
    const qs = this.state.st?.check?.questions ?? []
    const cur = this.host.revealed()
    const noteIds = new Map(qs.map((q) => [q, this.threads.noteOf(q.id)?.data.id]))
    const next = nextOpen(qs, (q) => this.isOpen(q), (q) => noteIds.get(q) === cur, dir)
    if (!next) return false
    await this.open(next.id)
    return true
  }

  // ---------- the Check view's requests ----------

  private onView(m: FromCheck): void {
    const r = decodeViewRequest(m)
    if (r) (this.viewHandlers[r.type] as (r: ViewRequest) => void)(r)
  }
  /** One handler per request of the view (viewMessages.ts CheckViewRequest), given it checked (viewRequests.ts). */
  private readonly viewHandlers: ViewHandlers = {
    ready: () => this.post(),
    open: (m) => fireAndForget(this.openFromView(m.id), 'controller: openFromView'),
    select: (m) => { this.state.select(m.id); this.post() },
    next: () => fireAndForget(this.step(1), 'controller: step'),
    answer: (m) => fireAndForget(this.answerFromView(m.id, m.text), 'controller: answerFromView'),
    draft: (m) => fireAndForget(this.setDraft(m.id, m.text), 'controller: setDraft'),
    link: (m) => fireAndForget(this.viewLink(m.id, m.i), 'controller: viewLink'),
    regrade: (m) => fireAndForget(this.grader.grade(m.id), 'controller: grader.grade'),
    concern: (m) => this.concernFromView(m.id, m.action),
    escape: () => { this.view.cancelFocus(); fireAndForget(vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup'), 'controller: command workbench.action.focusActiveEditorGroup') },
    start: () => this.act('start'),
    topUp: () => this.act('topUp'),
    scm: () => this.act('scm'),
    commitPush: () => this.act('commitPush'),
    openFile: () => this.act('openFile'),
    merge: () => this.act('merge'),
    pull: () => this.act('pull'),
    retry: () => fireAndForget(this.writer.retry(), 'controller: writer.retry'),
    modelSetting: () => this.openSetting(SETTINGS.model),
    pathSetting: () => this.openSetting(SETTINGS.claudePath),
    install: () => fireAndForget(vscode.env.openExternal(vscode.Uri.parse(INSTALL_URL)), 'controller: env.openExternal'),
    tour: () => fireAndForget(this.host.walkTour(), 'controller: host.walkTour'),
    writeTour: () => fireAndForget(this.writer.writeTour(false), 'controller: writer.writeTour'),
    include: (m) => { this.push.tick(m.file, m.on); this.post() },
    openMr: () => { if (this.push.mr) fireAndForget(vscode.env.openExternal(vscode.Uri.parse(this.push.mr)), 'controller: env.openExternal') },
  }
  private act(id: ActionId): void { fireAndForget(this.actions[id](), `controller: ${id}`) }
  private openSetting(key: (typeof SETTINGS)[keyof typeof SETTINGS]): void {
    fireAndForget(vscode.commands.executeCommand('workbench.action.openSettings', settingId(key)), 'controller: command workbench.action.openSettings')
  }
  /** A row clicked: its step of the tour, then its thread (without a step: the question on its own). */
  private async openFromView(id: string): Promise<void> {
    if (!(await this.host.openInTour(id))) fireAndForget(this.open(id), 'controller: open')
  }
  private concernFromView(id: string, action: ConcernAction): void {
    const n = this.threads.noteOf(id)
    if (n) fireAndForget(this.concerns.act(n, action), 'controller: concerns.act')
  }
  private async setDraft(id: string, text: string): Promise<void> {
    const st = this.state.st
    if (!st) return
    await this.state.drafts.set(st.file, id, text.trim() ? text : undefined)
  }
  /** Sent from the box: the same path as a reply in the thread (the thread shows it, then its grade). */
  private async answerFromView(id: string, text: string): Promise<void> {
    const n = this.threads.noteOf(id)
    if (!n || !text.trim() || this.grader.busy(id)) return
    // The box empties and says "Checking…" at once (the draft is in memory before it is stored); a failed answer
    // puts its text back.
    fireAndForget(this.setDraft(id, ''), 'controller: setDraft')
    if (!(await this.answer(n, text)) && !this.grader.grading.has(id)) fireAndForget(this.setDraft(id, text), 'controller: setDraft')
    this.post()
  }
  /** A code link in the box's grade: the same link as in the thread (lit, the keyboard stays in the box). */
  private async viewLink(id: string, i: number): Promise<void> {
    const n = this.threads.noteOf(id)
    const q = this.state.question(id)
    if (!n || !q) return
    // The latest grade's message in the thread.
    const mi = gradeMessageAt(n.data.messages.map((m) => m.role ?? ''), gradedAttempts(q).length)
    if (mi > 0) await vscode.commands.executeCommand(HiddenCmd.codeLink, checkLinkKey(n.data.id, mi), i)
  }

  // ---------- what the rest of the extension asks or does (notes, threads, the tour, the commands) ----------

  /** The questions as stops of the tour: after which step, their state. */
  tourStops(): TourStop[] {
    const c = this.state.st?.check
    if (!c?.journey) return []
    return c.questions.flatMap((q, i) => (q.step ? [{ id: q.id, n: i + 1, step: q.step, text: q.text, state: this.stateOf(q) }] : []))
  }
  /** A question's state as shown (being graded: not graded yet). */
  private stateOf(q: Question) { return this.grader.grading.has(q.id) ? 'ungraded' as const : this.cli.stateOf(q) }

  /** A suggested fix (a note asked from a concern) was applied to `file`: offered with Commit & push, the concern says so. */
  async fixApplied(q: string, file: string): Promise<void> {
    const st = this.state.st
    if (!st) return
    await this.state.fixes.set(st.branch, q, file)
    this.push.exclude.delete(file)
    this.refreshSoon(FIX_REFRESH_MS)
  }

  isCheck(n: Note): boolean { return isCheck(n) }
  offBranch(n: Note): boolean { return this.state.offBranch(n) }
  branchOf(n: Note): { checkFile?: string } { return this.state.branchOf(n) }
  pinned(n: Note): boolean { return this.threads.graded.has(n.data.id) }
  hasOpenIn(uri: vscode.Uri): boolean { return this.openIn(uri).length > 0 }
  openIn(uri: vscode.Uri): string[] {
    const repo = this.state.repo, check = this.state.st?.check
    if (!repo || !check) return []
    const rel = path.relative(repo, uri.fsPath).split(path.sep).join('/')
    return check.questions.filter((q) => q.file === rel && this.isOpen(q)).map((q) => q.id)
  }

  /** The person answered in a question's thread (see Grader.answer). */
  async answer(n: Note, text: string): Promise<boolean> {
    const link = linkOf(n)
    if (!link || !this.state.repo) return false
    return this.grader.answer(n, text, link)
  }
  /** codeNotes.checkConcern: `action` on the concern of thread `n`'s question (`reason`: a dismissal's). */
  concern(n: Note, action: ConcernAction, reason?: string): Promise<void> { return this.concerns.act(n, action, reason) }
  /** codeNotes.gradeCheck (Try again): thread `n`'s question graded again. */
  async regrade(n: Note): Promise<void> {
    const q = this.qidOf(n)
    if (q) await this.grader.grade(q)
  }

  /** A thread's passing state for commentsOf: checking, why it couldn't be checked, a concern about the code. */
  threadStatus(n: Note): ThreadStatus | undefined {
    const l = linkOf(n)
    if (!l) return undefined
    if (this.grader.busy(l.q)) return { checking: true }
    const e = this.grader.errors.get(n.data.id)
    if (e) return { error: gradeFailure(e.message, e.kind) }
    const q = this.state.question(l.q)
    const c = q && concernOf(q)
    // Done here and another one open: the way on, under the grade.
    const next = !!q && !this.isOpen(q) && this.hasOpen()
    const t = q && this.state.todos.get(this.state.st?.branch)[q.id]
    const todo = t ? `${baseName(t.file)}:${t.line}` : undefined
    if (!c && !next) return undefined
    return definedOnly({ concern: c ? definedOnly({ ...c, todo }) : undefined, next: next || undefined })
  }
  qidOf(n: Note): string | undefined { return linkOf(n)?.q }
  /** A check thread's question text and state (used where a check thread is handled outside the Check view). */
  rowOf(n: Note): { text: string; state: string } | undefined {
    const q = this.questionOf(n)
    return q ? { text: q.text, state: this.stateOf(q) } : undefined
  }
  linksIn(n: Note, mi: number): (Link & { text: string })[] {
    const q = this.questionOf(n)
    if (!q) return []
    return linksAt(q, n.data.messages.map((m) => m.role ?? ''), mi).map((l) => ({ ...l, text: l.text ?? '' }))
  }
  /** The question behind a check thread (for Ask Claude about it). */
  questionOf(n: Note): Question | undefined { return this.state.questionOf(n) }

  // ---------- for the integration test (src/testApi.ts) ----------

  /** What the check shows and knows now. */
  snapshot() {
    const st = this.state.st, item = this.status.state()
    return {
      itemLabel: item.label, tourBusy: !!this.writer.touring, bg: this.background.trace, onBase: this.onBase,
      status: st && { ...st, check: undefined }, words: this.state.words, item: item.text, itemWarn: item.warn,
      view: this.current(), panel: this.view.state(), grading: [...this.grader.grading.keys()],
      errors: [...this.grader.errors.values()].map((e) => e.message), refreshes: { ...this.counts },
    }
  }
  /** A message to the Check view's page (a test's click). */
  panelSend(m: ToCheck): void { this.view.send(m) }
  /** The worker stops; the next call starts a new one (with another PATH). */
  restartWorker(): void { this.worker.dispose() }

  dispose(): void {
    for (const s of this.subs) s.dispose()
    this.background.dispose()
    this.status.dispose()
    clearTimeout(this.timer)
    this.clearRevealTimers()
    this.worker.dispose()
    this.changed.dispose()
  }
}

/** Each request's handler, given that request as checked. */
type ViewHandlers = { [T in ViewRequest['type']]: (m: ViewRequestOf<T>) => void }

/** Whether this process may run `file`. */
function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Source Control with its message box focused. */
async function openScm(): Promise<void> {
  await vscode.commands.executeCommand('workbench.view.scm')
  await vscode.commands.executeCommand('workbench.scm.focus').then(undefined, () => undefined)
}
