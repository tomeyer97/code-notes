// The understanding check in VS Code (docs/understanding-check.md): Claude writes a few questions about the branch's
// change (skills/understanding-check); they show as note threads on their lines and as rows in the Check view (in
// the Code Notes sidebar); an answer in a thread is graded by Claude (read-only) and the reply lands in the same
// thread. The file understanding/<branch>.json is the source of truth; the threads are a view of it, kept in sync
// both ways. Where the check stands comes from the CLI (checkState / stateWords): the status bar, the view, `status`
// and CI say the same thing.
//
// This file is the controller: refresh, the status bar, the command, opening questions, the Check view's requests, and
// what the rest of the extension asks. Its parts: writer.ts (Claude writes the questions and the tour), grading.ts
// (answers and grades), threads.ts (the questions as note threads), concern.ts (concerns about the code), push.ts
// (Commit & push), park.ts (a check moved aside while another branch is checked out), background.ts (questions after a
// push), invalidFile.ts (a check file that can't be read), view.ts (the Check view's webview). The model they share
// is in types.ts, viewModel.ts and the other vscode-free files; the CLI (cli/understanding.mjs) holds the rules.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import type { Note } from '../notes/store'
import { BranchStatus, Check, Link, notDone, QState, Question, RefreshResult, Who, Words } from './types'
import { linksAt, gradeMessageAt, gradedAttempts } from './threadText'
import { concernOf } from './concernState'
import { CheckView, checkView, definedOnly, runAction, statusText } from './viewModel'
import { gradeFailure } from './failures'
import { Coalesced } from '../core/serial'
import { plural } from '../core/text'
import { BackgroundQuestions } from './background'
import { CliThread } from './cliThread'
import { Concerns, ConcernAction, VIEW_CONCERN_ACTIONS } from './concern'
import { FIX_REFRESH_MS, REFRESH_SOON_MS, REPO_FILES, REVEAL_RETRY_MS, SKILL } from './constants'
import { Grader } from './grading'
import type { CheckHost } from './host'
import { hostCli, type HostCli } from './cliApi'
import { InvalidFile } from './invalidFile'
import { isCheck, linkOf } from './threadLink'
import { checkLog, type CheckLog } from './log'
import { ScopedRecord, STATE } from '../platform/state'
import { Parking } from './park'
import { Pusher, unsavedDocument } from './push'
import { CheckThreads } from './threads'
import { CheckViewProvider } from './view'
import type { CheckViewMessage, CheckViewMessageOf, CheckViewRequest } from './viewMessages'
import { Writer } from './writer'
import { baseName } from '../core/paths'
import { fireAndForget } from '../platform/run'
import { Cmd, HiddenCmd } from '../platform/commands'
import { checkLinkKey } from '../platform/keys'

export type { CheckHost } from './host'
export { SESSION } from './constants'

export class CheckController implements vscode.Disposable {
  // ---------- shared with the parts in this folder (check/wiring.ts and the rest of the extension use the methods further down) ----------

  /** The understanding CLI (cli/understanding.mjs), loaded by init(). Not Claude Code (host.cli()). */
  cli!: HostCli
  /** cli/understanding.mjs's path (the skills' scripts get it as UNDERSTANDING_CLI). */
  readonly cliPath: string
  /** The CLI's git work (status, diffs, identity), on a worker thread: never waited for by the extension host. */
  worker!: CliThread
  /** The workspace folder (its repository) the check is about: the first one. */
  readonly folder = vscode.workspace.workspaceFolders?.[0]
  st: BranchStatus | undefined
  words: Words | undefined
  /** Who answers (git's user.name and user.email), as the last refresh read it. */
  who: Who | undefined
  /** No check yet and nothing of the change committed: the questions would have nothing to ask about. */
  uncommittedOnly = false
  /** The question selected in the Check view (its answer box is shown). */
  selected: string | undefined
  /** One line about what was just done (a merge kept both answers): until the next push or branch. */
  said: string | undefined
  /** Unsent answers typed in the view's box (per check file), applied fixes and added TODOs (per branch): per question. */
  readonly drafts: ScopedRecord<string>
  readonly fixes: ScopedRecord<string>
  readonly todos: ScopedRecord<{ file: string; line: number }>
  readonly view: CheckViewProvider
  readonly writer = new Writer(this)
  readonly grader = new Grader(this)
  readonly threads = new CheckThreads(this)
  readonly concerns = new Concerns(this)
  readonly push = new Pusher(this)
  readonly parking = new Parking(this)
  readonly background = new BackgroundQuestions(this)
  readonly invalid = new InvalidFile(this)
  /** The extension's log, each line starting "understanding check: ". */
  readonly log: CheckLog

  // ---------- refresh ----------

  /** What the last full refresh read, as one hash (cliWorker.ts, gateKey): a trigger that finds it unchanged stops there. */
  private key: string | undefined
  /** Refreshes done in full and skipped as unchanged (integration test). */
  private counts = { full: 0, same: 0 }
  private timer: NodeJS.Timeout | undefined
  /** A refreshSoon meanwhile asked for a full refresh (not gated). */
  private soonForce = false
  /** One refresh at a time; the calls made meanwhile share one more (coalesced). */
  private runs = new Coalesced((force) => this.doRefresh(force).catch((e) => {
    this.key = undefined
    this.log.error(`${e}`)
  }))

  // ---------- what the window shows ----------

  private item: vscode.StatusBarItem
  /** What the status bar item shows (set elsewhere too: then this is reset). */
  private itemShown: string | undefined
  /** The codeNotes.checkOpen context as last set. */
  private checkOpen: boolean | undefined
  private subs: vscode.Disposable[] = []

  constructor(readonly host: CheckHost) {
    this.log = checkLog(host.log)
    this.cliPath = vscode.Uri.joinPath(host.extUri, 'cli', 'understanding.mjs').fsPath
    this.drafts = host.stored.scoped(STATE.checkDrafts)
    this.fixes = host.stored.scoped(STATE.checkFixes)
    this.todos = host.stored.scoped(STATE.checkTodos)
    this.item = vscode.window.createStatusBarItem('codeNotes.understanding', vscode.StatusBarAlignment.Left, 48)
    this.item.name = 'Understanding check'
    this.item.command = Cmd.checkUnderstanding
    this.view = new CheckViewProvider(host.extUri, host.log, (m) => this.onView(m))
    this.subs.push(vscode.window.registerWebviewViewProvider('codeNotes.check', this.view, { webviewOptions: { retainContextWhenHidden: true } }))
  }

  async init(): Promise<void> {
    this.cli = hostCli
    this.worker = new CliThread()
    // Claude runs the skill's script by its path: it must be executable (an unzip may have dropped the bit).
    const script = vscode.Uri.joinPath(this.host.extUri, 'skills', SKILL, 'scripts', 'questions.mjs').fsPath
    try { fs.accessSync(script, fs.constants.X_OK) } catch { try { fs.chmodSync(script, 0o755) } catch { /* read-only install */ } }
    if (!this.folder || this.folder.uri.scheme !== 'file') return
    const f = this.folder
    // Every trigger goes through the same check (gated): a refresh reads git only when something it shows can have
    // changed. No watcher on .git/index: any `git status` (VS Code's own Git view, a terminal, an agent) rewrites it,
    // which kept the check refreshing over and over; VS Code's git extension says when the working tree changed.
    const later = () => this.refreshSoon(REFRESH_SOON_MS, false)
    // A commit moves the branch (logs/HEAD), not .git/HEAD; a checkout changes both.
    for (const glob of ['understanding/*.json', '.git/HEAD', '.git/logs/HEAD', '.git/refs/remotes/**']) {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(f, glob))
      w.onDidChange(later); w.onDidCreate(later); w.onDidDelete(later)
      this.subs.push(w)
    }
    // An applied fix undone (or edited) before it is saved: what Commit & push offers follows.
    const isFixFile = (doc: vscode.TextDocument) => {
      return Object.values(this.fixes.get(this.st?.branch)).some((f) => doc.uri.fsPath === path.join(this.repo!, f))
    }
    this.subs.push(
      vscode.window.onDidChangeWindowState((s) => { if (s.focused) later() }),
      vscode.workspace.onDidSaveTextDocument(later),
      vscode.workspace.onDidChangeTextDocument((e) => { if (this.repo && e.contentChanges.length && isFixFile(e.document)) later() }),
    )
    this.background.watchPushes()
    await this.refresh()
  }

  get repo(): string | undefined { return this.folder?.uri.fsPath }
  /** The check file's absolute path (when there is a status). */
  get abs(): string | undefined { return this.st && this.repo ? path.join(this.repo, this.st.file) : undefined }

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

  private async doRefresh(force: boolean): Promise<void> {
    const repo = this.repo
    if (!repo || !this.cli) return
    const r = await this.readState(repo, force)
    if (r.same) { this.counts.same++; return }
    this.counts.full++
    // Unknown until this refresh is through (a failure part way leaves it unknown: the next trigger reads again).
    this.key = undefined
    const before = this.st?.branch
    this.st = r.st
    this.who = r.ident
    if (!r.st) this.log.info(`no status (${r.error ?? 'unknown'})`)
    if (this.st && this.st.branch !== before) await this.branchChanged(before)
    await this.push.forgetIfMoved(repo)
    this.writer.followBranch()
    if (this.st && !this.st.exists && (await this.parking.restore())) return this.doRefresh(true)
    this.words = this.st ? this.cli.stateWords(this.st.state, this.st) : undefined
    this.uncommittedOnly = await this.nothingCommitted(repo)
    this.writer.startIfCommitted()
    await this.push.read(repo)
    // What the questions left out: only while it still is uncommitted (committed or reverted since: the line goes).
    const notice = this.writer.notice
    if (notice && notice.branch === this.st?.branch && !this.writer.writing) await this.writer.noteLoose(notice.branch)
    if (!this.writer.writing) this.paintStatusItem()
    if (this.st?.check) await this.threads.sync(this.st.check)
    // While there is a check, an empty Code Notes view steps aside: the Check view gets its room (package.json).
    const open = !!this.st?.check
    if (open !== this.checkOpen) {
      this.checkOpen = open
      fireAndForget(vscode.commands.executeCommand('setContext', 'codeNotes.checkOpen', open), 'controller: command setContext')
    }
    // A file that can't be read (a bad edit, a conflict) keeps the tour shown as it was until it reads again.
    if (this.st?.state.phase !== 'invalid') await this.host.tourChanged(this.st?.check, this.abs, this.st?.branch)
    this.post()
    this.host.listChanged()
    this.key = r.key
  }
  /** Where the branch stands, read on the worker (gated by the last key unless `force`). */
  private readState(repo: string, force: boolean): Promise<RefreshResult> {
    // An applied fix edited and not saved yet: only the editor knows (Commit & push offers it).
    const fixFiles = Object.values(this.fixes.get(this.st?.branch))
    const edited = fixFiles.filter((f) => !!unsavedDocument(repo, f))
    const files = [...REPO_FILES, ...this.todoFiles(), ...fixFiles]
    const o = { prev: force ? undefined : this.key, files, untracked: !!this.writer.notice, extra: edited.join('\0') }
    return this.worker.api.refreshState(repo, o)
      .catch((e: Error): RefreshResult => ({ error: e.message }))
  }
  /** Another branch is checked out (`before`: the one left, if any). */
  private async branchChanged(before: string | undefined): Promise<void> {
    this.push.forgetBranch()
    this.selected = undefined
    this.said = undefined
    // The branch left behind had an unfinished check (untracked): it waits in the cache, not in this branch's tree.
    if (before) await this.parking.left(before)
  }
  /** No check yet and nothing of the change committed (the questions would have nothing to ask about). */
  private async nothingCommitted(repo: string): Promise<boolean> {
    const st = this.st
    if (!(st?.state.phase === 'none' && !!st.base && !!st.head && st.changed > 0)) return false
    const exempt = this.cli.loadConfig(repo).exempt
    const stat = this.worker.api.codeStat(repo, st.base, st.head, exempt)
    return stat.then((s) => this.cli.linesOf(s) === 0, () => false)
  }
  /** The status bar item, from the CLI's words (only what changed is sent to the window: each change is a message). */
  private paintStatusItem(): void {
    const st = this.st, ready = this.writer.ready
    const t = statusText(st, this.words)
    if (t && ready && st?.state.phase === 'answering' && !st.summary?.done) {
      t.text = `$(checklist) ${plural(ready, 'question')} ready`
      t.tip = `Questions about ${st.branch} are ready · Check my understanding`
    }
    // Done: the same words as the Check view ("Pushed.", "Not pushed yet."), not the file's alone.
    const line = st?.state.phase === 'done' ? this.current()?.line : undefined
    if (t && line) t.tip = [this.words?.title, line].filter(Boolean).join(' · ')
    const shown = t ? JSON.stringify([t.text, t.tip, !!t.warn]) : ''
    if (shown === this.itemShown) return
    this.itemShown = shown
    if (!t) { this.item.hide(); return }
    this.item.text = t.text
    this.item.tooltip = t.tip
    // Read out as words (VS Code would read the icon's id: "pass Understanding").
    this.item.accessibilityInformation = { label: `Understanding check: ${t.tip.replace(/^✓\s*/, '').replace(/ · /g, '. ')}`, role: 'button' }
    this.item.backgroundColor = t.warn ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined
    this.item.show()
  }
  /** The status bar item while the questions are written (paintStatusItem takes over again after). */
  showWritingItem(): void {
    this.itemShown = undefined
    this.item.text = '$(sync~spin) Understanding'
    this.item.accessibilityInformation = { label: 'Understanding check: writing questions', role: 'button' }
    this.item.show()
  }

  /** The Check view's model: where the check stands, and everything going on now. */
  current(): CheckView | undefined {
    const st = this.st
    if (!st || !this.words) return undefined
    const w = this.writer, p = this.push
    const sel = this.selected ? this.threads.noteOf(this.selected) : undefined
    const gradeError = sel && this.grader.errors.get(sel.data.id)
    const failed = w.failed?.branch === st.branch ? w.failed : undefined
    return checkView(st, this.words, definedOnly({
      error: gradeError ? gradeFailure(gradeError.message, gradeError.kind) : undefined,
      busy: w.busy(),
      tourBusy: w.tourBusy(),
      uncommitted: this.uncommittedOnly,
      invalidAt: this.invalid.parseError()?.text,
      tourFailed: w.tourFailed === st.branch,
      grading: new Set([...this.grader.grading.keys(), ...this.grader.answering]),
      unpushed: p.unpushed,
      pushed: p.pushed,
      mr: p.mr || undefined,
      me: this.who,
      notice: w.notice?.branch === st.branch && st.state.phase !== 'done' ? w.notice.text : undefined,
      commit: p.commit ? { ...p.commit, include: p.include, exclude: p.exclude } : undefined,
      selected: this.selected || undefined,
      draft: this.selected ? this.drafts.get(st.file)[this.selected] ?? '' : undefined,
      failed: failed ? definedOnly({ text: failed.text, setting: failed.setting || undefined, path: failed.path || undefined }) : undefined,
      said: this.said || undefined,
    }))
  }
  post(): void { this.view.update(this.current()) }

  // ---------- the command ----------

  /** Check my understanding: write the questions (or top them up), else show them. */
  async run(): Promise<void> {
    if (!this.repo) { fireAndForget(vscode.window.showInformationMessage('Open a folder (a git repository) to check your understanding of a change.'), 'controller: window.showInformationMessage'); return }
    // Questions written in the background are being opened: the status bar no longer says they are ready.
    this.writer.ready = 0
    await this.refresh()
    const st = this.st
    if (!st) { fireAndForget(vscode.window.showInformationMessage('Check my understanding needs a git repository with a branch to compare.'), 'controller: window.showInformationMessage'); return }
    // Questions written in the background: what they left out, now, as the person opens them.
    if (this.writer.ready) {
      this.writer.ready = 0
      await this.writer.noteLoose(st.branch)
      await this.refresh()
    }
    // The view is shown along with what the step does, except where the step opens something itself.
    const step = runAction(st, { commit: this.push.commit, unpushed: this.push.unpushed })
    switch (step) {
      // A file that can't be read: open it, at the first conflict marker.
      case 'openFile': return this.invalid.open()
      case 'show': return this.show()
      case 'start': await this.writer.write(false); return
      case 'scm': this.show(); return openScm()
      case 'topUp': this.show(); await this.writer.write(true); return
      // Done but not committed or pushed: the status item does what the view's button does.
      case 'commitPush': this.show(); return this.push.commitPush()
      case 'walk':
        this.show()
        // A check with a tour opens it: the steps lead to the questions. Without one, the first open question.
        if (st.check?.journey && (await this.host.walkTour())) return
        await this.openNext()
    }
  }

  show(): void { this.view.reveal() }

  // ---------- the check file ----------

  /** Writes the check file with today's line numbers and its result. */
  save(abs: string, check: Check): void {
    this.cli.relocate(this.repo!, check)
    this.cli.writeCheck(abs, this.cli.stamp(check, this.cli.loadConfig(this.repo!)))
  }

  // ---------- opening questions ----------

  /** The first question not done yet, else the first one. */
  async openNext(): Promise<void> {
    const c = this.st?.check
    if (!c) return
    const q = c.questions.find((x) => notDone(this.cli.stateOf(x))) ?? c.questions[0]
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
    this.selected = id
    this.post()
    let boxed = true
    try { await this.view.focus(id) } catch { boxed = false }
    await this.host.reveal(n, this.host.codeColumn(), boxed)
    if (!boxed) await this.host.focusReply(n)
    // Its own lines stay in view, also when a tour's step card far from them is drawn a moment later and scrolls there.
    const file = path.join(this.repo ?? '', n.data.file), r = n.data.range
    for (const ms of REVEAL_RETRY_MS) setTimeout(() => {
      if (this.selected !== id) return
      const ed = vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === file)
      const want = new vscode.Range(r.start - 1, 0, r.end - 1, 0)
      if (ed && !ed.visibleRanges.some((v) => v.contains(want.start))) ed.revealRange(want, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
    }, ms)
  }

  /** Ctrl+' D / A while questions are open: the next or previous one not done, from the one shown now. */
  hasOpen(): boolean { return !!this.st?.check?.questions.some((q) => notDone(this.cli.stateOf(q))) }
  async step(dir: 1 | -1): Promise<boolean> {
    const qs = this.st?.check?.questions ?? []
    const open = qs.filter((q) => notDone(this.cli.stateOf(q)))
    if (!open.length) return false
    const cur = this.host.revealed()
    const at = qs.findIndex((q) => this.threads.noteOf(q.id)?.data.id === cur)
    // Every question once, starting after (or before) the one shown, wrapping around.
    const from = Math.max(0, at)
    const order = dir === 1 ? [...qs.slice(at + 1), ...qs.slice(0, at + 1)] : [...qs.slice(0, from).reverse(), ...qs.slice(from).reverse()]
    const next = order.find((q) => open.includes(q) && this.threads.noteOf(q.id)?.data.id !== cur) ?? open[0]
    await this.open(next.id)
    return true
  }

  // ---------- the Check view's requests ----------

  private onView(m: CheckViewMessage): void {
    const handlers = this.viewHandlers()
    if (!Object.hasOwn(handlers, m.type)) return
    const handle = handlers[m.type as CheckViewRequest] as (m: CheckViewMessage) => void
    handle(m)
  }
  /** One handler per request of the view (viewMessages.ts CheckViewRequest); a request's fields are checked here. */
  private viewHandlers(): ViewHandlers {
    const str = (v: unknown): v is string => typeof v === 'string'
    return {
      ready: () => this.post(),
      open: (m) => { if (m.id) fireAndForget(this.openFromView(m.id), 'controller: openFromView') },
      select: (m) => { if (m.id) { this.selected = m.id; this.post() } },
      next: () => fireAndForget(this.step(1), 'controller: step'),
      answer: (m) => { if (m.id && str(m.text)) fireAndForget(this.answerFromView(m.id, m.text), 'controller: answerFromView') },
      draft: (m) => { if (m.id && str(m.text)) fireAndForget(this.setDraft(m.id, m.text), 'controller: setDraft') },
      link: (m) => { if (m.id && typeof m.i === 'number') fireAndForget(this.viewLink(m.id, m.i), 'controller: viewLink') },
      regrade: (m) => { if (m.id) fireAndForget(this.grader.grade(m.id), 'controller: grader.grade') },
      concern: (m) => { if (m.id) this.concernFromView(m.id, m.action) },
      escape: () => { this.view.cancelFocus(); fireAndForget(vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup'), 'controller: command workbench.action.focusActiveEditorGroup') },
      start: () => fireAndForget(this.writer.write(false), 'controller: writer.write'),
      topUp: () => fireAndForget(this.writer.write(true), 'controller: writer.write'),
      retry: () => { const topUp = !!this.writer.failed?.topUp; this.writer.failed = undefined; fireAndForget(this.writer.write(topUp), 'controller: writer.write') },
      modelSetting: () => fireAndForget(vscode.commands.executeCommand('workbench.action.openSettings', 'codeNotes.understanding.model'), 'controller: command workbench.action.openSettings'),
      pathSetting: () => fireAndForget(vscode.commands.executeCommand('workbench.action.openSettings', 'codeNotes.claude.path'), 'controller: command workbench.action.openSettings'),
      install: () => fireAndForget(vscode.env.openExternal(vscode.Uri.parse('https://claude.com/claude-code')), 'controller: env.openExternal'),
      tour: () => fireAndForget(this.host.walkTour(), 'controller: host.walkTour'),
      writeTour: () => fireAndForget(this.writer.writeTour(false), 'controller: writer.writeTour'),
      openFile: () => fireAndForget(this.invalid.open(), 'controller: invalid.open'),
      merge: () => fireAndForget(this.invalid.keepBoth(), 'controller: invalid.keepBoth'),
      include: (m) => { if (m.file) { this.push.tick(m.file, !!m.on); this.post() } },
      scm: () => { if (this.uncommittedOnly && this.st) this.writer.startAfterCommit = this.st.branch; fireAndForget(openScm(), 'controller: openScm') },
      commitPush: () => fireAndForget(this.push.commitPush(), 'controller: push.commitPush'),
      pull: () => fireAndForget(this.push.pull(), 'controller: push.pull'),
      openMr: () => { if (this.push.mr) fireAndForget(vscode.env.openExternal(vscode.Uri.parse(this.push.mr)), 'controller: env.openExternal') },
    }
  }
  /** A row clicked: its step of the tour, then its thread (without a step: the question on its own). */
  private async openFromView(id: string): Promise<void> {
    if (!(await this.host.openInTour(id))) fireAndForget(this.open(id), 'controller: open')
  }
  private concernFromView(id: string, action: string | undefined): void {
    if (!VIEW_CONCERN_ACTIONS.includes(action as ConcernAction)) return
    const n = this.threads.noteOf(id)
    if (n) fireAndForget(this.concerns.act(n, action as ConcernAction), 'controller: concerns.act')
  }
  private async setDraft(id: string, text: string): Promise<void> {
    if (!this.st) return
    await this.drafts.set(this.st.file, id, text.trim() ? text : undefined)
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
    const q = this.st?.check?.questions.find((x) => x.id === id)
    if (!n || !q) return
    // The latest grade's message in the thread.
    const mi = gradeMessageAt(n.data.messages.map((m) => m.role ?? ''), gradedAttempts(q).length)
    if (mi > 0) await vscode.commands.executeCommand(HiddenCmd.codeLink, checkLinkKey(n.data.id, mi), i)
  }

  /** The files a TODO was added to from this branch's check. */
  todoFiles(): string[] { return [...new Set(Object.values(this.todos.get(this.st?.branch)).map((t) => t.file))] }

  // ---------- what the rest of the extension asks (notes, threads, the tour) ----------

  /** The questions as stops of the tour: after which step, their state. */
  tourStops(): { id: string; n: number; step: number; text: string; state: QState }[] {
    const c = this.st?.check
    if (!c?.journey || !this.cli) return []
    return c.questions.flatMap((q, i) => (q.step ? [{ id: q.id, n: i + 1, step: q.step, text: q.text, state: this.stateOf(q) }] : []))
  }
  /** A question's state as shown (being graded: not graded yet). */
  private stateOf(q: Question): QState { return this.grader.grading.has(q.id) ? 'ungraded' : this.cli.stateOf(q) }

  /** A suggested fix (a note asked from a concern) was applied to `file`: offered with Commit & push, the concern says so. */
  async fixApplied(q: string, file: string): Promise<void> {
    if (!this.st) return
    await this.fixes.set(this.st.branch, q, file)
    this.push.exclude.delete(file)
    this.refreshSoon(FIX_REFRESH_MS)
  }

  isCheck(n: Note): boolean { return isCheck(n) }
  /**
   * A check thread of another branch's check, or a note made from one (Suggest a fix, Ask Claude): not shown (its file
   * and lines belong to that branch).
   */
  offBranch(n: Note): boolean {
    const f = linkOf(n)?.file ?? (n.data.extra as { checkFile?: string } | undefined)?.checkFile
    // Another branch's check, or this branch's while its file is gone (stashed, deleted): not shown.
    return !!f && !!this.st && (f !== this.st.file || !this.st.exists)
  }
  /** For a note made from a check thread: the check it belongs to (hidden with it on other branches). */
  branchOf(n: Note): { checkFile?: string } { const f = linkOf(n)?.file; return f ? { checkFile: f } : {} }
  /** Graded in this window: the thread stays open where it is. */
  pinned(n: Note): boolean { return this.threads.graded.has(n.data.id) }
  /** A question not done yet is in this file: journey lenses step aside. */
  hasOpenIn(uri: vscode.Uri): boolean { return this.openIn(uri).length > 0 }
  /** The ids of the questions not done yet in this file (journey lenses step aside around their lines). */
  openIn(uri: vscode.Uri): string[] {
    if (!this.repo || !this.st?.check) return []
    const rel = path.relative(this.repo, uri.fsPath).split(path.sep).join('/')
    return this.st.check.questions.filter((q) => q.file === rel && notDone(this.cli.stateOf(q))).map((q) => q.id)
  }

  /** The person answered in a question's thread (see Grader.answer). */
  async answer(n: Note, text: string): Promise<boolean> {
    const link = linkOf(n)
    if (!link || !this.repo) return false
    return this.grader.answer(n, text, link)
  }

  /** A thread's passing state for commentsOf: checking, why it couldn't be checked, a concern about the code. */
  threadStatus(n: Note): ThreadStatus | undefined {
    const l = linkOf(n)
    if (!l) return undefined
    if (this.grader.busy(l.q)) return { checking: true }
    const e = this.grader.errors.get(n.data.id)
    if (e) return { error: gradeFailure(e.message, e.kind) }
    const q = this.st?.check?.questions.find((x) => x.id === l.q)
    const c = q && concernOf(q)
    // Done here and another one open: the way on, under the grade.
    const next = !!q && !notDone(this.cli.stateOf(q)) && this.hasOpen()
    const t = q && this.todos.get(this.st?.branch)[q.id]
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
  /** The code links of message `mi` of a check thread (with the line text to find them after edits). */
  linksIn(n: Note, mi: number): (Link & { text: string })[] {
    const q = this.questionOf(n)
    if (!q) return []
    return linksAt(q, n.data.messages.map((m) => m.role ?? ''), mi).map((l) => ({ ...l, text: l.text ?? '' }))
  }
  /** The question behind a check thread (for Ask Claude about it). */
  questionOf(n: Note): Question | undefined {
    const l = linkOf(n)
    return l ? this.st?.check?.questions.find((x) => x.id === l.q) : undefined
  }

  /** For the integration test. */
  snapshot() {
    return {
      itemLabel: this.item.accessibilityInformation?.label, tourBusy: !!this.writer.touring, bg: this.background.trace,
      status: this.st && { ...this.st, check: undefined }, words: this.words, item: this.item.text, itemWarn: !!this.item.backgroundColor,
      view: this.current(), panel: this.view.state(), grading: [...this.grader.grading.keys()],
      errors: [...this.grader.errors.values()].map((e) => e.message), refreshes: { ...this.counts },
    }
  }
  panelSend(m: unknown): void { this.view.send(m) }
  /** The worker stops; the next call starts a new one (integration test: with another PATH). */
  restartWorker(): void { this.worker?.dispose() }

  dispose(): void {
    for (const s of this.subs) s.dispose()
    this.background.dispose()
    this.item.dispose()
    clearTimeout(this.timer)
    this.worker?.dispose()
  }
}

/** Each request's handler, given that request's message. */
type ViewHandlers = { [T in CheckViewRequest]: (m: CheckViewMessageOf<T>) => void }

/** A check thread's state for its comments (threads/comments.ts commentsOf). */
export interface ThreadStatus {
  /** Being graded (or its answer taken). */
  checking?: boolean
  /** Why it couldn't be graded. */
  error?: string
  /** A concern about the code; `todo`: where a TODO about it was added ("limits.js:12"). */
  concern?: { text: string; flagged: boolean; suspect: boolean; by?: string; todo?: string }
  /** Done, and another question is open: "Next question ›". */
  next?: boolean
}

/** Source Control with its message box focused. */
async function openScm(): Promise<void> {
  await vscode.commands.executeCommand('workbench.view.scm')
  await vscode.commands.executeCommand('workbench.scm.focus').then(undefined, () => undefined)
}
