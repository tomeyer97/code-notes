// The understanding check in VS Code (docs/understanding-check.md): Claude writes a few questions about the branch's
// change (skills/understanding-check); they show as note threads on their lines and as rows in the Check view (in
// the Code Notes sidebar); an answer in a thread is graded by Claude (read-only) and the reply lands in the same
// thread. The file understanding/<branch>.json is the source of truth; the threads are a view of it, kept in sync
// both ways. Where the check stands comes from the CLI (checkState / stateWords): the status bar, the view, `status`
// and CI say the same thing.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFile } from 'child_process'
import { pathToFileURL } from 'url'
import { Ask, AskResult } from './claude'
import { findCompact } from './compact'
import { Note, NoteData, Store } from './store'
import { Check, CheckView, Cli, Link, QState, Question, Status, Who, Words, checkPhase, checkPrompt, checkView, concernOf, gradeBody, linksAt, questionBody, statusText, todoLine, tourPrompt } from './checkModel'
import { clock } from './writing'

/** What the check needs from the rest of the extension (extension.ts). */
export interface CheckHost {
  log: vscode.LogOutputChannel
  store: Store
  extUri: vscode.Uri
  /** Per-workspace memory (the .gitattributes offer). */
  memento: vscode.Memento
  me(): string
  now(): string
  newId(): string
  /** The `claude` CLI, or undefined. */
  cli(): string | undefined
  /** Claude may run here (a trusted folder); says why not otherwise. */
  allowed(what: string): boolean
  model(): string | undefined
  /** After a note was created or changed by the check: unread state, the threads, the list. */
  changed(n: Note, created: boolean): Promise<void>
  /** Adds the person's reply to a note (false: not saved). */
  addReply(n: Note, text: string): Promise<boolean>
  resolve(n: Note): Promise<void>
  /** `preserveFocus`: the keyboard stays where it is (the answer box). */
  reveal(n: Note, column?: vscode.ViewColumn, preserveFocus?: boolean): Promise<void>
  /** The note shown last (revealed), if any. */
  revealed(): string | undefined
  /** The caret in the note's reply box. */
  focusReply(n: Note): Promise<boolean>
  refresh(): void
  /** The view column the code is shown in. */
  codeColumn(): vscode.ViewColumn | undefined
  /** The check's row in the journeys list changed (and what the editor shows around it: lenses). */
  listChanged?(): void
  /** A new note on these lines with this question, asked to Claude (Ask Claude on a check question). */
  askAbout(file: string, start: number, end: number, question: string, extra: Record<string, unknown>): Promise<void>
  /** The code-journey skill's folder (its journey.py writes the tour), or undefined. */
  journeySkill?(): string | undefined
  /** The check (or none) changed: its tour is shown and walked like a journey (absolute path of the check file). */
  tourChanged?(check: Check | undefined, file: string | undefined, branch: string | undefined): Promise<void>
  /** Walks the check's tour (where it was left, else step 1); false when there is none. */
  walkTour?(): Promise<boolean>
  /** A question of the tour: its step, then its thread; false when it has no step (then it opens on its own). */
  openInTour?(id: string): Promise<boolean>
  /** After a pass: the walk is at this question, so it goes on to the next stop; false when no walk is there. */
  tourNext?(id: string): Promise<boolean>
}

export const SESSION = (branch: string) => `Check · ${branch}`
const AUTHOR = 'Understanding check'
const SKILL = 'understanding-check'
/** Files the first check writes (initRepo): committed with the check. */
const REPO_FILES = ['.gitattributes', '.ignore']
/** A superseded answer: not kept in the check file, nor in its thread's note. */
const EARLIER = '_An earlier answer (not kept)._'
/** Questions written for a branch that was no longer checked out when they were done: kept here until it is. */
const CACHE = '.code-notes/.cache/checks'
const isCheck = (n: Note) => !!(n.data.extra as { check?: unknown } | undefined)?.check
/** A thread's link to its question: the check file, the question's id, and a hash of the text it was shown with. */
const linkOf = (n: Note) => (n.data.extra as { check?: { file: string; q: string; h?: string } } | undefined)?.check
const textHash = (q: Question) => require('crypto').createHash('sha1').update(`${q.id}\0${q.text}`, 'utf8').digest('hex').slice(0, 12) as string
/** The thread was made for this question as it is now (an older thread without a hash: its first message says). */
const sameQuestion = (n: Note, q: Question) => { const h = linkOf(n)?.h; return h ? h === textHash(q) : n.data.messages[0]?.body === questionBody(q) }
const BG_KEY = 'codeNotes.understanding.backgroundHeads'
/** Per branch: files a TODO was added to from the check (offered, not committed, by Commit & push). */
const TODO_KEY = 'codeNotes.understanding.todoFiles'
/** Unsent answers typed in the Check view's box: per check file, per question (this workspace only, never the file). */
const DRAFT_KEY = 'codeNotes.understanding.drafts'
/** The parts of VS Code's git extension API used here. */
interface GitRepo { rootUri: vscode.Uri; state: { HEAD?: { name?: string; commit?: string; upstream?: unknown; ahead?: number }; onDidChange: vscode.Event<void> } }
interface GitApi { repositories: GitRepo[]; onDidOpenRepository: vscode.Event<GitRepo> }
const importFn = new Function('u', 'return import(u)') as (u: string) => Promise<unknown>
const notDone = (s: string) => s === 'todo' || s === 'retry' || s === 'ungraded'

export class Understanding implements vscode.Disposable {
  private U!: Cli
  private item: vscode.StatusBarItem
  readonly view: CheckViewProvider
  private subs: vscode.Disposable[] = []
  /** The workspace folder (its repository) the check is about: the first one. */
  private folder = vscode.workspace.workspaceFolders?.[0]
  st: Status | undefined
  words: Words | undefined
  private unpushed: boolean | undefined
  private pushed: string | undefined
  private pushing = false
  /** Questions written in the background and not opened yet: the status bar says how many are ready. */
  private ready = 0
  /** What the push watcher saw last (integration test). */
  private bgTrace: string[] = []
  /** One line about what the questions left out, for this branch. */
  private notice: { branch: string; text: string } | undefined
  /** What Commit & push would commit (refreshed while the check is done), and the TODO files ticked to go with it. */
  private commit: { files: string[]; todos: string[] } | undefined
  private include = new Set<string>()
  /** The question selected in the Check view (its answer box is shown). */
  private selected: string | undefined
  private writing: { started: number; phase: string; branch: string; ask?: Ask } | undefined
  /** The tour being written (after the questions: they can be answered meanwhile); the last try failed (branch). */
  private touring: { started: number; phase: string; ask?: Ask } | undefined
  private tourFailed: string | undefined
  /** Questions being graded now (by id), and failures to grade (by note id: shown in the thread with Try again). */
  readonly grading = new Map<string, Ask | undefined>()
  readonly gradeErrors = new Map<string, string>()
  /** Check threads graded in this window: they stay open where they are (the reply is read next to the code). */
  private graded = new Set<string>()
  private timer: NodeJS.Timeout | undefined

  constructor(private host: CheckHost) {
    this.item = vscode.window.createStatusBarItem('codeNotes.understanding', vscode.StatusBarAlignment.Left, 48)
    this.item.name = 'Understanding check'
    this.item.command = 'codeNotes.checkUnderstanding'
    this.view = new CheckViewProvider(host.extUri, host.log, (m) => this.onView(m))
    this.subs.push(vscode.window.registerWebviewViewProvider('codeNotes.check', this.view, { webviewOptions: { retainContextWhenHidden: true } }))
  }

  async init(): Promise<void> {
    const p = vscode.Uri.joinPath(this.host.extUri, 'cli', 'understanding.mjs')
    this.U = (await importFn(pathToFileURL(p.fsPath).href)) as Cli
    // Claude runs the skill's script by its path: it must be executable (an unzip may have dropped the bit).
    const script = vscode.Uri.joinPath(this.host.extUri, 'skills', SKILL, 'scripts', 'questions.mjs').fsPath
    try { fs.accessSync(script, fs.constants.X_OK) } catch { try { fs.chmodSync(script, 0o755) } catch { /* read-only install */ } }
    if (!this.folder || this.folder.uri.scheme !== 'file') return
    const f = this.folder
    const later = () => this.refreshSoon()
    // A commit moves the branch (logs/HEAD), not .git/HEAD; a checkout changes both.
    for (const glob of ['understanding/*.json', '.git/{HEAD,index}', '.git/logs/HEAD', '.git/refs/remotes/**']) {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(f, glob))
      w.onDidChange(later); w.onDidCreate(later); w.onDidDelete(later)
      this.subs.push(w)
    }
    this.subs.push(vscode.window.onDidChangeWindowState((s) => { if (s.focused) later() }), vscode.workspace.onDidSaveTextDocument(later))
    this.watchPushes()
    await this.refresh()
  }

  private get repo(): string | undefined { return this.folder?.uri.fsPath }
  private get abs(): string | undefined { return this.st && this.repo ? path.join(this.repo, this.st.file) : undefined }

  refreshSoon(ms = 400): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.refresh(), ms)
  }

  private chain: Promise<void> = Promise.resolve()
  /** Reads where the branch stands, then the status bar, the threads and the view follow (one at a time). */
  refresh(): Promise<void> {
    this.chain = this.chain.then(() => this.doRefresh(), (e) => this.host.log.error(`understanding check: ${e}`))
    return this.chain
  }
  private async doRefresh(): Promise<void> {
    const repo = this.repo
    if (!repo || !this.U) return
    const before = this.st?.branch
    try { this.st = this.U.localStatus(repo) } catch (e) { this.st = undefined; this.host.log.info(`understanding check: no status (${(e as Error).message.split('\n')[0]})`) }
    if (this.st && this.st.branch !== before) { this.pushed = undefined; this.selected = undefined }
    if (this.st && !this.st.exists && (await this.restoreCached())) return this.doRefresh()
    this.words = this.st ? this.U.stateWords(this.st.state, this.st) : undefined
    // Pushed? Ahead of its upstream, or no upstream at all.
    const ahead = this.st?.state.phase === 'done' ? await gitOut(repo, ['rev-list', '--count', '@{u}..HEAD'], true) : undefined
    this.unpushed = ahead === undefined ? undefined : ahead !== '0'
    this.commit = this.st?.state.phase === 'done' ? await this.toCommit() : undefined
    if (!this.writing) {
      const t = statusText(this.st, this.words)
      if (t && this.ready && this.st?.state.phase === 'answering' && !this.st.summary?.done) { t.text = `$(checklist) ${this.ready} question${this.ready === 1 ? '' : 's'} ready`; t.tip = `Questions about ${this.st.branch} are ready · Check my understanding` }
      if (t) {
        this.item.text = t.text; this.item.tooltip = t.tip
        this.item.backgroundColor = t.warn ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined
        this.item.show()
      } else this.item.hide()
    }
    if (this.st?.check) await this.syncThreads(this.st.check)
    await this.host.tourChanged?.(this.st?.check, this.abs, this.st?.branch)
    this.post()
    this.host.listChanged?.()
  }

  private cfg() { return this.repo && this.U ? this.U.loadConfig(this.repo) : { maxDrift: 40, passRatio: 0.6, questions: { min: 1, max: 5 }, model: null } }

  private me(): Who | undefined { return this.repo && this.U ? this.U.gitIdentity(this.repo) : undefined }

  current(): CheckView | undefined {
    if (!this.st || !this.words) return undefined
    // Writing for another branch (switched meanwhile): said with its name, never as this branch's progress.
    const w = this.writing
    const busy = w ? (w.branch === this.st.branch ? `Writing questions · ${clock(Date.now() - w.started)} · ${w.phase}` : `Writing questions for ${w.branch} · ${clock(Date.now() - w.started)}`) : this.pushing ? 'Pushing…' : undefined
    const tourBusy = this.touring ? `Writing the tour · ${clock(Date.now() - this.touring.started)}` : undefined
    return checkView(this.st, this.words, { busy, tourBusy, tourFailed: this.tourFailed === this.st.branch, grading: new Set(this.grading.keys()), unpushed: this.unpushed, pushed: this.pushed, me: this.me(),
      notice: this.notice?.branch === this.st.branch && this.st.state.phase !== 'done' ? this.notice.text : undefined,
      ...(this.commit ? { commit: { ...this.commit, include: this.include } } : {}),
      ...(this.selected ? { selected: this.selected, draft: this.drafts()[this.selected] ?? '' } : {}) })
  }
  private post(): void { this.view.update(this.current()) }

  // ---------- the command ----------

  /** Check my understanding: write the questions (or top them up), else show them. */
  async run(): Promise<void> {
    if (!this.repo) { void vscode.window.showInformationMessage('Open a folder (a git repository) to check your understanding of a change.'); return }
    // Questions written in the background are being opened: the status bar no longer says they are ready.
    const ready = this.ready
    this.ready = 0
    await this.refresh()
    const st = this.st
    if (!st) { void vscode.window.showInformationMessage('Check my understanding needs a git repository with a branch to compare.'); return }
    // Questions written in the background: what they left out, now, as the person opens them.
    if (this.ready) { this.ready = 0; await this.noteLoose(st.branch); await this.refresh() }
    const p = st.state.phase
    if (p === 'invalid') { void vscode.window.showWarningMessage(`Code Notes: ${st.next}`); return }
    if (p === 'nothing') { void vscode.window.showInformationMessage(st.next); return }
    if (p === 'none') { await this.write(false); return }
    this.show()
    if (p === 'drift') { if (st.state.commitFirst) await openScm(); else await this.write(true); return }
    // A check with a tour opens it: the steps lead to the questions. Without one, the first open question.
    if (st.check?.journey && (await this.host.walkTour?.())) return
    await this.openNext()
  }

  /** The skill: the repository's copy, the home folder's, else the one inside the extension. */
  private skill(): { dir: string; bundled: boolean } {
    const bundled = vscode.Uri.joinPath(this.host.extUri, 'skills', SKILL).fsPath
    const dir = [path.join(this.repo!, '.claude/skills', SKILL), path.join(os.homedir(), '.claude/skills', SKILL), bundled].find((d) => fs.existsSync(path.join(d, 'scripts', 'questions.mjs')))!
    return { dir, bundled: dir === bundled }
  }

  /**
   * Uncommitted and untracked (not ignored) files the questions won't see, as one line for the Check view: "Not asked
   * about (uncommitted): refunds.js, scratch.js". The check's own files don't count.
   */
  private async loose(): Promise<string | undefined> {
    const out = await gitOut(this.repo!, ['status', '--porcelain', '--untracked-files=all'], true)
    // "XY path" (the output is trimmed: the first line may have lost its leading space); a rename: "old -> new".
    const files = (out ?? '').split('\n').map((l) => /^[ MTADRCU?!]{1,2} (.+)$/.exec(l)?.[1]).filter((f): f is string => !!f)
      .map((f) => f.replace(/^.* -> /, '').replace(/^"|"$/g, '')).filter((f) => !this.U.own(f))
    return files.length ? `Not asked about (uncommitted): ${files.map((f) => path.basename(f)).join(', ')}` : undefined
  }
  /** What the questions left out, said in the view while the branch's check is being answered. */
  private async noteLoose(branch: string): Promise<void> {
    const text = await this.loose()
    this.notice = text ? { branch, text } : undefined
  }

  /** Claude writes the questions with the skill, for the branch checked out now; then question 1 opens. */
  async write(topUp: boolean, o: { background?: boolean } = {}): Promise<boolean> {
    const repo = this.repo!, st = this.st!
    const bg = !!o.background
    if (this.writing) { if (!bg) this.show(); return false }
    // In the background nothing is said: no trust prompt, no notice, no progress, nothing opens.
    if (bg ? !vscode.workspace.isTrusted : !this.host.allowed('write understanding-check questions')) return false
    // Uncommitted work doesn't stop the start: the view names what the questions leave out.
    if (!bg) await this.noteLoose(st.branch)
    const cli = this.host.cli()
    const { dir, bundled } = this.skill()
    const prompt = checkPrompt({ skill: dir, branch: st.branch, baseRef: st.baseRef ?? 'the default branch', base: st.base ?? 'main', topUp, bundled, head: st.head })
    if (!cli && bg) return false
    if (!cli) {
      await vscode.env.clipboard.writeText(prompt)
      void vscode.window.showInformationMessage('Claude Code was not found: copied a prompt for your agent.')
      return false
    }
    const model = this.host.model()
    const w = (this.writing = { started: Date.now(), phase: 'starting', branch: st.branch } as NonNullable<Understanding['writing']>)
    this.item.text = '$(sync~spin) Understanding'
    this.item.show()
    this.host.log.info(`understanding check: Claude (${model ?? 'default model'}) is ${topUp ? 'topping up' : 'writing'} the questions for ${st.branch}${bg ? ' in the background' : ''}`)
    let res: AskResult
    try {
      res = bg ? await this.ask(cli, prompt, dir, model, w) : await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: topUp ? 'Adding questions' : 'Writing questions', cancellable: true }, async (progress, token) => {
        const tick = () => { progress.report({ message: `${clock(Date.now() - w.started)} · ${w.phase}` }); this.post() }
        const ask = new Ask({
          cli, cwd: repo, prompt, model, extraTools: [`Bash(${dir}/scripts/*)`], addDirs: [dir],
          env: { UNDERSTANDING_CLI: vscode.Uri.joinPath(this.host.extUri, 'cli', 'understanding.mjs').fsPath, UNDERSTANDING_MODEL_LABEL: model ?? 'Claude Code default' },
          onProgress: (p) => { const ph = checkPhase(p.tool, w.phase); if (ph !== w.phase) { w.phase = ph; tick() } },
        })
        w.ask = ask
        token.onCancellationRequested(() => ask.cancel())
        tick()
        const t = setInterval(tick, 1000)
        try { return await ask.done } finally { clearInterval(t) }
      })
    } finally { this.writing = undefined }
    const before = st.check?.questions.length ?? 0
    // The branch was switched while Claude worked: its questions wait in the cache (the script writes them there; a
    // file it wrote just before the switch is moved there) until it is checked out again. Nothing else happens here:
    // nothing opens, nothing is written to the branch checked out now.
    const now = await gitOut(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (now && now !== w.branch) {
      this.park(w.branch)
      const kept = fs.existsSync(path.join(repo, this.U.cachedFor(w.branch)))
      if (kept && !bg) void vscode.window.showInformationMessage(`Questions for ${w.branch} are ready: switch back to answer them.`)
      this.host.log.info(`understanding check: the branch changed to ${now} while writing for ${w.branch}${kept ? '; kept for it' : ''}`)
      await this.refresh()
      return false
    }
    await this.refresh()
    if (res.cancelled) return false
    if (res.error) { if (bg) this.host.log.error(`understanding check: background questions: ${res.error}`); else void vscode.window.showWarningMessage(`Code Notes: Claude couldn't write the questions: ${res.error}`); return false }
    const after = this.st?.check?.questions.length ?? 0
    if (after <= before && bg) { this.host.log.info(`understanding check: no background questions: ${res.text.trim().split('\n')[0]}`); return false }
    if (after <= before) {
      // NOTHING / UNCOMMITTED / PROBLEM: the script's own words.
      const why = /(SMALL|NOTHING|UNCOMMITTED|PROBLEM):?\s*([^\n]+)/.exec(res.text)?.[2] ?? res.text.trim().split('\n')[0] ?? 'no questions were written'
      void vscode.window.showInformationMessage(`No questions: ${why}`)
      return false
    }
    this.host.log.info(`understanding check: ${after - before} questions written in ${clock(Date.now() - w.started)}${res.costUsd ? `, $${res.costUsd.toFixed(3)}` : ''}`)
    if (!topUp) await this.initRepo()
    // Then the tour, in the same session (the change is read already); the questions can be answered meanwhile. It
    // starts once question 1 is open (its thread has the keyboard before anything else is drawn).
    const tour = () => void this.writeTour(topUp, { session: res.sessionId, background: bg })
    // In the background: the status bar says so; nothing opens until the person clicks.
    if (bg) { this.ready = after - before; await this.refresh(); tour(); return true }
    // Only the first question opens: its code and its thread. The list is in the Check view.
    await this.openNext()
    tour()
    return true
  }

  /**
   * Claude writes the check's tour: a journey of the change through the code the questions are about, each question
   * placed after the step that shows its answer (skills/understanding-check, "The tour"). No progress notification:
   * the Check view says "Writing the tour · 1:20"; the questions stay open meanwhile. `topUp`: steps for the new part.
   */
  async writeTour(topUp: boolean, o: { session?: string; background?: boolean } = {}): Promise<boolean> {
    const repo = this.repo, check = this.st?.check
    if (!repo || !check || this.touring) return false
    if (o.background ? !vscode.workspace.isTrusted : !this.host.allowed('write the tour of your change')) return false
    const cli = this.host.cli()
    const js = this.host.journeySkill?.()
    if (!cli || !js) { this.host.log.info(`understanding check: no tour (${!cli ? 'no claude CLI' : 'no code-journey skill'})`); return false }
    const { dir, bundled } = this.skill()
    const model = this.host.model()
    const before = check.journey?.steps.length ?? 0
    const t = (this.touring = { started: Date.now(), phase: 'starting' } as NonNullable<Understanding['touring']>)
    const branch = this.st!.branch
    this.tourFailed = undefined
    this.post()
    const timer = setInterval(() => this.post(), 1000)
    this.host.log.info(`understanding check: Claude (${model ?? 'default model'}) is writing the tour of ${this.st!.branch}${o.session ? ' (same session)' : ''}`)
    let res: AskResult
    try {
      const ask = new Ask({
        cli, cwd: repo, model, resume: o.session,
        prompt: tourPrompt({ skill: dir, journeySkill: js, topUp: topUp && before > 0, bundled, resumed: !!o.session }),
        extraTools: [`Bash(${dir}/scripts/*)`, `Bash(${js}/scripts/*)`], addDirs: [dir, js],
        env: { UNDERSTANDING_CLI: vscode.Uri.joinPath(this.host.extUri, 'cli', 'understanding.mjs').fsPath, UNDERSTANDING_MODEL_LABEL: model ?? 'Claude Code default', JOURNEY_PY: path.join(js, 'scripts', 'journey.py'), JOURNEY_MODEL: model ?? 'Claude Code default' },
        onProgress: (p) => { t.phase = checkPhase(p.tool, t.phase) },
      })
      t.ask = ask
      res = await ask.done
    } finally { clearInterval(timer); this.touring = undefined }
    await this.refresh()
    if (res.cancelled) return false
    const after = this.st?.check?.journey?.steps.length ?? 0
    if (res.error || after <= before) {
      this.host.log.error(`understanding check: no tour: ${res.error ?? res.text.trim().split('\n').slice(-3).join(' ')}`)
      this.tourFailed = branch
      this.post()
      return false
    }
    this.host.log.info(`understanding check: tour written (${after - before} steps) in ${clock(Date.now() - t.started)}${res.costUsd ? `, $${res.costUsd.toFixed(3)}` : ''}`)
    if (!o.background && this.st?.state.phase !== 'done') {
      void vscode.window.showInformationMessage('The tour of your change is ready.', 'Walk it').then((b) => { if (b) void this.host.walkTour?.() })
    }
    return true
  }

  /** The questions as stops of the tour: after which step, their state. */
  tourStops(): { id: string; n: number; step: number; text: string; state: QState }[] {
    const c = this.st?.check
    if (!c?.journey || !this.U) return []
    return c.questions.flatMap((q, i) => (q.step ? [{ id: q.id, n: i + 1, step: q.step, text: q.text, state: this.grading.has(q.id) ? 'ungraded' as QState : this.U.stateOf(q) }] : []))
  }

  /** Claude writes the questions without a progress notification (the background run). */
  private ask(cli: string, prompt: string, dir: string, model: string | undefined, w: NonNullable<Understanding['writing']>): Promise<AskResult> {
    const ask = new Ask({
      cli, cwd: this.repo!, prompt, model, extraTools: [`Bash(${dir}/scripts/*)`], addDirs: [dir],
      env: { UNDERSTANDING_CLI: vscode.Uri.joinPath(this.host.extUri, 'cli', 'understanding.mjs').fsPath, UNDERSTANDING_MODEL_LABEL: model ?? 'Claude Code default' },
      onProgress: (p) => { w.phase = checkPhase(p.tool, w.phase) },
    })
    w.ask = ask
    return ask.done
  }

  /**
   * Background questions: when a branch is pushed (it has an upstream and nothing left to push, after it had
   * something or no upstream), has code changes and no check, and is not the default branch, its questions are
   * written quietly. One run at a time; never twice for the same commit. Setting codeNotes.understanding.background.
   */
  private watchPushes(): void {
    const git = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi }>('vscode.git')
    const hook = (api: GitApi) => {
      const seen = (r: GitRepo) => {
        if (!this.folder || path.resolve(r.rootUri.fsPath) !== path.resolve(this.folder.uri.fsPath)) return
        // Per branch: pushed as last seen. A branch first seen already pushed (a checkout) starts nothing.
        const was = new Map<string, boolean>()
        this.subs.push(r.state.onDidChange(() => {
          const h = r.state.HEAD
          if (!h?.name) return
          const pushed = !!h.upstream && h.ahead === 0
          const before = was.get(h.name)
          was.set(h.name, pushed)
          this.bgTrace = [...this.bgTrace.slice(-9), `${h.name} ${pushed ? 'pushed' : 'unpushed'}${before === undefined ? ' (new)' : ''}`]
          if (pushed && before === false) void this.pushedBranch(h.name, h.commit)
        }))
      }
      this.bgTrace.push(`git api: ${api.repositories.length} repositories`)
      api.repositories.forEach(seen)
      this.subs.push(api.onDidOpenRepository(seen))
    }
    if (!git) { this.bgTrace.push('no git extension'); return }
    if (git.isActive) hook(git.exports.getAPI(1))
    else void git.activate().then((e) => hook(e.getAPI(1)), () => undefined)
  }
  private async pushedBranch(branch: string, commit: string | undefined): Promise<void> {
    if (!vscode.workspace.getConfiguration('codeNotes').get<boolean>('understanding.background', true) || this.writing || !commit) return
    const done = this.host.memento.get<string[]>(BG_KEY) ?? []
    if (done.includes(commit)) return
    await this.refresh()
    const st = this.st
    if (!st || st.branch !== branch || st.state.phase !== 'none') return
    const base = (st.baseRef ?? '').replace(/^origin\//, '')
    if (['main', 'master', base].includes(branch)) return
    await this.host.memento.update(BG_KEY, [...done.slice(-50), commit])
    await this.write(false, { background: true })
  }

  /** Moves the questions written for `branch` out of a working tree that has another branch now. */
  private park(branch: string): boolean {
    const repo = this.repo!
    const rel = this.U.fileFor(branch)
    const src = path.join(repo, rel)
    if (!fs.existsSync(src)) return false
    try {
      fs.mkdirSync(path.join(repo, CACHE), { recursive: true })
      const ignore = path.join(repo, '.code-notes/.cache/.gitignore')
      if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n')
      // Tracked on this branch (it has a check of that name): leave it, it is not ours to move.
      const tracked = !!(execFileSyncQuiet(repo, ['ls-files', '--', rel]))
      if (tracked) return false
      fs.renameSync(src, path.join(repo, this.U.cachedFor(branch)))
      this.host.log.info(`understanding check: questions for ${branch} kept in ${CACHE} until it is checked out`)
      return true
    } catch (e) { this.host.log.error(`understanding check: couldn't keep the questions for ${branch}: ${e}`); return false }
  }

  /** Back on a branch whose questions were parked: they go in place, and question 1 opens. */
  private async restoreCached(): Promise<boolean> {
    const repo = this.repo!, st = this.st!
    const cached = path.join(repo, CACHE, `${this.U.slugOf(st.branch)}.json`)
    if (!fs.existsSync(cached)) return false
    try {
      fs.mkdirSync(path.dirname(path.join(repo, st.file)), { recursive: true })
      fs.renameSync(cached, path.join(repo, st.file))
    } catch (e) { this.host.log.error(`understanding check: couldn't put back the questions for ${st.branch}: ${e}`); return false }
    void vscode.window.showInformationMessage(`Your questions for ${st.branch} are here.`)
    setTimeout(() => void this.openNext(), 300)
    return true
  }

  /**
   * On the first check, quietly: the repository's lines for check files (.gitattributes collapses them in merge
   * request diffs, .ignore keeps them out of search: VS Code's search reads it, search.useIgnoreFiles); committed with
   * the check. Nothing in the workspace's settings.
   */
  private async initRepo(): Promise<void> {
    try { const added = this.U.initRepo(this.repo!); if (added.length) this.host.log.info(`understanding check: added ${added.join('; ')}`) } catch (e) { this.host.log.error(`understanding check: init: ${e}`) }
    await this.refresh()
  }

  show(): void { this.view.reveal() }

  /** The first question not done yet, else the first one. */
  async openNext(): Promise<void> {
    const c = this.st?.check
    if (!c) return
    const q = c.questions.find((x) => notDone(this.U.stateOf(x))) ?? c.questions[0]
    await this.open(q.id)
  }

  /**
   * A question: its code and thread in the code's group, and the keyboard in its answer box in the Check view (never in
   * the code: typing there edits it). Without the view, in the thread.
   */
  async open(id: string): Promise<void> {
    const n = this.noteOf(id)
    if (!n) return
    // The keyboard into the box first, then the code (shown without taking it): no moment where typing edits code.
    this.selected = id
    this.post()
    let boxed = true
    try { await this.view.focus(id) } catch { boxed = false }
    await this.host.reveal(n, this.host.codeColumn(), boxed)
    if (!boxed) await this.host.focusReply(n)
  }

  // ---------- the answer box in the Check view ----------

  private drafts(): Record<string, string> { return (this.st && this.host.memento.get<Record<string, Record<string, string>>>(DRAFT_KEY)?.[this.st.file]) ?? {} }
  private async setDraft(id: string, text: string): Promise<void> {
    if (!this.st) return
    const all = this.host.memento.get<Record<string, Record<string, string>>>(DRAFT_KEY) ?? {}
    const mine = { ...(all[this.st.file] ?? {}) }
    if (text.trim()) mine[id] = text; else delete mine[id]
    await this.host.memento.update(DRAFT_KEY, { ...all, [this.st.file]: mine })
  }
  /** Sent from the box: the same path as a reply in the thread (the thread shows it, then its grade). */
  private async answerFromView(id: string, text: string): Promise<void> {
    const n = this.noteOf(id)
    if (!n || !text.trim()) return
    await this.setDraft(id, '')
    await this.answer(n, text)
    this.post()
  }
  /** A code link in the box's grade: the same link as in the thread (lit, the keyboard stays in the box). */
  private async viewLink(id: string, i: number): Promise<void> {
    const n = this.noteOf(id)
    const q = this.st?.check?.questions.find((x) => x.id === id)
    if (!n || !q) return
    // The grade's message in the thread: the k-th agent message after the question for the k-th graded attempt.
    const k = (q.attempts ?? []).filter((a) => a.verdict).length
    let seen = 0
    const mi = n.data.messages.findIndex((m, x) => x > 0 && m.role === 'agent' && ++seen === k)
    if (mi > 0) await vscode.commands.executeCommand('codeNotes.codeLink', `check|${n.data.id}|${mi}`, i)
  }

  /** Ctrl+' D / A while questions are open: the next or previous one not done, from the one shown now. */
  hasOpen(): boolean { return !!this.st?.check?.questions.some((q) => notDone(this.U.stateOf(q))) }
  async step(dir: 1 | -1): Promise<boolean> {
    const qs = this.st?.check?.questions ?? []
    const open = qs.filter((q) => notDone(this.U.stateOf(q)))
    if (!open.length) return false
    const cur = this.host.revealed()
    const at = qs.findIndex((q) => this.noteOf(q.id)?.data.id === cur)
    const order = dir === 1 ? [...qs.slice(at + 1), ...qs.slice(0, at + 1)] : [...qs.slice(0, Math.max(0, at)).reverse(), ...qs.slice(Math.max(0, at)).reverse()]
    const next = order.find((q) => open.includes(q) && this.noteOf(q.id)?.data.id !== cur) ?? open[0]
    await this.open(next.id)
    return true
  }

  private onView(m: { type: string; id?: string; file?: string; on?: boolean; text?: string; i?: number }): void {
    if (m.type === 'open' && m.id) { const id = m.id; void (this.host.openInTour?.(id) ?? Promise.resolve(false)).then((ok) => { if (!ok) void this.open(id) }) }
    else if (m.type === 'tour') void this.host.walkTour?.()
    else if (m.type === 'writeTour') void this.writeTour(false)
    else if (m.type === 'select' && m.id) { this.selected = m.id; this.post() }
    else if (m.type === 'answer' && m.id && typeof m.text === 'string') void this.answerFromView(m.id, m.text)
    else if (m.type === 'draft' && m.id && typeof m.text === 'string') void this.setDraft(m.id, m.text)
    else if (m.type === 'link' && m.id && typeof m.i === 'number') void this.viewLink(m.id, m.i)
    else if (m.type === 'next') void this.step(1)
    else if (m.type === 'escape') { this.view.cancelFocus(); void vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup') }
    else if (m.type === 'include' && m.file) { if (m.on) this.include.add(m.file); else this.include.delete(m.file); this.post() }
    else if (m.type === 'start') void this.write(false)
    else if (m.type === 'topUp') void this.write(true)
    else if (m.type === 'scm') void openScm()
    else if (m.type === 'commitPush') void this.commitPush()
    else if (m.type === 'ready') this.post()
  }

  /**
   * What Commit & push commits: the check file and the setup files `init` changed; `todos`: files a TODO was added to
   * from the check (uncommitted), committed only when ticked. Nothing else the person changed.
   */
  private async toCommit(): Promise<{ files: string[]; todos: string[] }> {
    const repo = this.repo!, st = this.st!
    const dirty = async (f: string) => fs.existsSync(path.join(repo, f)) && !!(await gitOut(repo, ['status', '--porcelain', '--', f], true))
    const files = [st.file]
    for (const f of REPO_FILES) if (await dirty(f)) files.push(f)
    const todos: string[] = []
    for (const f of this.todoFiles()) if (await dirty(f)) todos.push(f)
    return { files, todos }
  }
  /** The TODOs added from this branch's check: per question, the file and line it went to. */
  private todos(): Record<string, { file: string; line: number }> { return this.st ? this.host.memento.get<Record<string, Record<string, { file: string; line: number }>>>(TODO_KEY)?.[this.st.branch] ?? {} : {} }
  private todoFiles(): string[] { return [...new Set(Object.values(this.todos()).map((t) => t.file))] }
  private async addTodo(q: string, file: string, line: number): Promise<void> {
    const all = this.host.memento.get<Record<string, Record<string, { file: string; line: number }>>>(TODO_KEY) ?? {}
    const b = this.st!.branch
    await this.host.memento.update(TODO_KEY, { ...all, [b]: { ...(all[b] ?? {}), [q]: { file, line } } })
  }
  /**
   * The lines a concern is about: the code its grade linked (found again by its text when it moved), else the
   * question's thread.
   */
  private async concernAt(q: Question, n: Note): Promise<{ file: string; start: number; end: number }> {
    const l = this.U.concernLink(q)
    if (!l) return { file: n.data.file, start: n.data.range.start, end: n.data.range.end }
    let start = l.start
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(this.folder!.uri, l.file))
      if (l.text && doc.lineAt(Math.min(doc.lineCount - 1, l.start - 1)).text !== l.text) {
        const hits = Array.from({ length: doc.lineCount }, (_, k) => k).filter((k) => doc.lineAt(k).text === l.text)
        if (hits.length) start = hits.reduce((a, b) => (Math.abs(b + 1 - l.start) < Math.abs(a + 1 - l.start) ? b : a)) + 1
      }
    } catch { return { file: n.data.file, start: n.data.range.start, end: n.data.range.end } }
    return { file: l.file, start, end: start + (l.end - l.start) }
  }

  /** Commit & push: exactly the files named in the view (the check file, the setup files, ticked TODO files), then the push. */
  async commitPush(): Promise<void> {
    if (!this.repo || !this.st || this.pushing) return
    const { files, todos } = await this.toCommit()
    files.push(...todos.filter((f) => this.include.has(f)))
    this.pushing = true; this.post()
    try {
      const r = await this.U.commitAndPush(this.repo, files, `Understanding check: ${this.st.branch}`)
      this.pushed = r.line
      this.host.log.info(`understanding check: commit & push: ${r.line}`)
      if (!r.ok) void vscode.window.showWarningMessage(`Code Notes: ${r.line}`)
    } finally { this.pushing = false }
    await this.refresh()
  }

  // ---------- threads (a view of the file) ----------

  private noteOf(id: string): Note | undefined {
    const file = this.st?.file
    return this.host.store.all().find((n) => linkOf(n)?.q === id && linkOf(n)?.file === file)
  }

  /** The thread messages a question's file entry stands for: the question, then each answer and its grade. */
  private messagesOf(q: Question, check: Check): NoteData['messages'] {
    const out: NoteData['messages'] = [{ author: AUTHOR, role: 'agent', body: questionBody(q) }]
    let explained = false
    for (const a of q.attempts ?? []) {
      out.push({ author: a.by?.name ?? check.answeredBy?.name ?? this.host.me(), role: 'human', body: a.answer ?? EARLIER, ...(a.at ? { at: a.at } : {}) })
      if (a.verdict) out.push({ author: AUTHOR, role: 'agent', body: gradeBody(a, { restatement: explained }), ...(a.gradedAt ? { at: a.gradedAt } : {}) })
      if (a.verdict === 'explained') explained = true
    }
    return out
  }

  /**
   * Every question has its thread; answers and grades written elsewhere (the CLI, another window) are added. The file
   * rewritten (questions written again, a pull, a checkout): a thread whose question changed is made again, one whose
   * question is gone is removed. A thread never stands for a question it didn't show.
   */
  private async syncThreads(check: Check): Promise<void> {
    const file = this.st!.file
    for (const n of this.host.store.all().filter((x) => linkOf(x)?.file === file)) {
      const q = check.questions.find((x) => x.id === linkOf(n)!.q)
      if (!q || !sameQuestion(n, q)) { this.graded.delete(n.data.id); await this.host.store.trash(n); this.host.refresh() }
    }
    for (const q of check.questions) {
      const want = this.messagesOf(q, check)
      const n = this.noteOf(q.id)
      if (!n) { await this.createNote(q, want); continue }
      // An answer the file no longer keeps (a later one superseded it): its copy in the note goes too.
      let redacted = false
      const humans0 = n.data.messages.filter((m) => m.role === 'human')
      want.filter((m) => m.role === 'human').forEach((m, k) => { if (m.body === EARLIER && humans0[k] && humans0[k].body !== EARLIER) { humans0[k].body = EARLIER; redacted = true } })
      if (redacted && await this.host.store.save(n)) await this.host.changed(n, false)
      // Append-only: the thread may hold more (a remark after the question was done); never less.
      const humans = (m: NoteData['messages']) => m.filter((x) => x.role === 'human').length
      const agents = (m: NoteData['messages']) => m.filter((x) => x.role === 'agent').length
      if (humans(n.data.messages) >= humans(want) && agents(n.data.messages) >= agents(want)) continue
      const missing: NoteData['messages'] = []
      let h = humans(n.data.messages), a = agents(n.data.messages)
      for (const m of want) {
        if (m.role === 'human') { if (h-- > 0) continue } else if (a-- > 0) continue
        missing.push(m)
      }
      if (!missing.length) continue
      n.data.messages.push(...missing.map((m) => ({ ...m, at: m.at ?? this.host.now() })))
      const st = this.U.stateOf(q)
      // Done: resolved quietly (the ✓ in the thread says it; no "Resolved" line under it).
      if (!notDone(st) && n.data.status === 'open') n.data.status = 'resolved'
      if (await this.host.store.save(n)) await this.host.changed(n, false)
    }
  }

  private async createNote(q: Question, messages: NoteData['messages']): Promise<void> {
    const folder = this.folder!
    let lines: string[] | undefined
    try { lines = fs.readFileSync(path.join(folder.uri.fsPath, q.file), 'utf8').split(/\r?\n/) } catch { return /* its file is gone */ }
    let start = q.start ?? 1, end = q.end ?? start
    if (!q.target && q.anchor) {
      const f = findCompact(lines, q.anchor, start - 1)
      if (f.state !== 'gone') { start = f.loc.start + 1; end = f.loc.end + 1 }
    }
    start = Math.min(Math.max(1, start), lines.length); end = Math.min(Math.max(start, end), lines.length)
    const at = this.host.now()
    const id = this.host.newId()
    const done = !notDone(this.U.stateOf(q))
    const n: Note = {
      folder, uri: this.host.store.uriFor(folder, id),
      data: {
        id, file: q.file, range: { start, end },
        anchor: q.target ? { text: '', before: '', after: '' } : { text: lines.slice(start - 1, end).join('\n'), before: lines.slice(Math.max(0, start - 3), start - 1).join('\n'), after: lines.slice(end, end + 2).join('\n') },
        session: SESSION(this.st!.branch), status: done ? 'resolved' : 'open', stale: false, createdAt: at,
        messages: messages.map((m) => ({ ...m, at: m.at ?? at })),
        ...(q.target ? { target: 'file' as const } : {}),
        extra: { check: { file: this.st!.file, q: q.id, h: textHash(q) } },
      },
    }
    if (await this.host.store.save(n)) await this.host.changed(n, true)
  }

  // ---------- answering and grading ----------

  isCheck(n: Note): boolean { return isCheck(n) }
  /**
   * A check thread of another branch's check, or a note made from one (Suggest a fix, Ask Claude): not shown (its file
   * and lines belong to that branch).
   */
  offBranch(n: Note): boolean {
    const f = linkOf(n)?.file ?? (n.data.extra as { checkFile?: string } | undefined)?.checkFile
    return !!f && !!this.st && f !== this.st.file
  }
  /** For a note made from a check thread: the check it belongs to (hidden with it on other branches). */
  branchOf(n: Note): { checkFile?: string } { const f = linkOf(n)?.file; return f ? { checkFile: f } : {} }
  /** Graded in this window: the thread stays open where it is. */
  pinned(n: Note): boolean { return this.graded.has(n.data.id) }
  /** A question not done yet is in this file: journey lenses step aside. */
  hasOpenIn(uri: vscode.Uri): boolean {
    if (!this.repo || !this.st?.check) return false
    const rel = path.relative(this.repo, uri.fsPath).split(path.sep).join('/')
    return this.st.check.questions.some((q) => q.file === rel && notDone(this.U.stateOf(q)))
  }

  /** The person answered in a question's thread: the answer goes into the file, then it is graded. */
  async answer(n: Note, text: string): Promise<void> {
    const link = linkOf(n)
    if (!link || !this.repo) return
    const body = text.trim()
    if (!body) return
    await this.refresh()
    const abs = path.join(this.repo, link.file)
    let check: Check
    try { check = this.U.readCheck(abs) } catch { void vscode.window.showWarningMessage(`Code Notes: ${link.file} can't be read.`); return }
    const q = check.questions.find((x) => x.id === link.q)
    // Only an answer to the question as it was shown: the file may have been rewritten since.
    if (!q || !sameQuestion(n, q)) {
      void vscode.window.showWarningMessage('This question changed: reopen it from the Check view.')
      await this.refresh()
      return
    }
    const state = this.U.stateOf(q)
    // Passed: a remark, not graded. Explained: a restatement, graded against the explanation.
    if (state === 'pass' || state === 'restated') { await this.host.addReply(n, body); return }
    if (this.grading.has(q.id)) return
    // The thread first: a refresh between the two then finds the answer there already (no second copy).
    if (!(await this.host.addReply(n, body))) return
    this.U.addAttempt(check, q, body, this.U.gitIdentity(this.repo))
    this.save(abs, check)
    // Not awaited: the reply box clears once the answer is in (VS Code clears it when the command returns).
    void this.grade(q.id)
  }

  /** Writes the check file with today's line numbers and its result. */
  private save(abs: string, check: Check): void {
    this.U.relocate(this.repo!, check)
    this.U.writeCheck(abs, this.U.stamp(check, this.U.loadConfig(this.repo!)))
  }

  /** Grades a question's latest answer with Claude (read-only), writes the verdict, replies in the thread. */
  async grade(id: string): Promise<void> {
    const repo = this.repo
    if (!repo || !this.st?.exists || this.grading.has(id)) return
    const abs = this.abs!
    const n = this.noteOf(id)
    if (n) { this.gradeErrors.delete(n.data.id); this.graded.add(n.data.id) }
    if (!this.host.allowed('grade answers')) return
    const cli = this.host.cli()
    const fail = (why: string) => { if (n) this.gradeErrors.set(n.data.id, why); this.host.log.error(`understanding check: ${id}: ${why}`) }
    if (!cli) { fail('Claude Code (the `claude` CLI) was not found.'); this.host.refresh(); return }
    let check = this.U.readCheck(abs)
    let q = check.questions.find((x) => x.id === id)
    const last = q?.attempts?.at(-1)
    if (!q || !last) return
    const mode = this.U.gradeMode(q)
    let diff = ''
    try { diff = this.U.diffText(repo, check.base ?? check.head) } catch { /* no diff: the grader reads the code */ }
    const prompt = this.U.graderPrompt({ q, answer: last.answer ?? "", ...mode, diff: this.U.diffForGrader(diff, q.file), code: this.U.codeWindow(repo, q), canRead: true, tour: this.U.tourText(check) })
    const ask = new Ask({ cli, cwd: repo, prompt, model: this.host.model() })
    this.grading.set(id, ask)
    this.post(); this.host.refresh()
    const res = await ask.done
    this.grading.delete(id)
    try {
      if (res.cancelled) return
      if (res.error) { fail(res.error); return }
      let v: ReturnType<Cli['parseVerdict']>
      try { v = this.U.parseVerdict(res.text, mode.attempt, { restate: mode.explanation !== undefined }) } catch (e) { fail((e as Error).message); return }
      // Links to lines that are really there (the words stay either way).
      if (v.links) { v.links = this.U.codeLinksIn(repo, v.links); if (!v.links.length) delete v.links }
      // The file may have changed while Claude worked: read it again, grade the same answer.
      check = this.U.readCheck(abs)
      q = check.questions.find((x) => x.id === id)
      const a = q?.attempts?.at(-1)?.answer === last.answer && !q?.attempts?.at(-1)?.verdict ? q!.attempts!.at(-1) : undefined
      if (!q || !a) return
      Object.assign(a, v, { gradedAt: this.host.now() })
      a.hash = this.U.attemptHash(q, a)
      // One concern per question, kept on it (its flag survives a later grade).
      if (v.concern) q.concern = { text: v.concern, flagged: q.concern?.flagged ?? false, at: a.gradedAt }
      this.save(abs, check)
      this.host.log.info(`understanding check: ${id} ${v.verdict}${v.concern ? ' (concern)' : ''}${res.costUsd ? `, $${res.costUsd.toFixed(3)}` : ''}`)
      // The grade reaches the thread through syncThreads. The editor stays on this question: the feedback is the
      // lesson. Moving on is the person's: "Next question ›" under the grade, or Ctrl+' D.
      await this.refresh()
    } finally { this.post(); this.host.refresh() }
  }

  /** A thread's passing state for commentsOf: checking, why it couldn't be checked, a concern about the code. */
  threadStatus(n: Note): { checking?: boolean; error?: string; concern?: { text: string; flagged: boolean; suspect: boolean; by?: string; todo?: string }; next?: boolean } | undefined {
    const l = linkOf(n)
    if (!l) return undefined
    if (this.grading.has(l.q)) return { checking: true }
    const e = this.gradeErrors.get(n.data.id)
    if (e) return { error: e }
    const q = this.st?.check?.questions.find((x) => x.id === l.q)
    const c = q && concernOf(q)
    // Done here and another one open: the way on, under the grade.
    const next = !!q && !notDone(this.U.stateOf(q)) && this.hasOpen()
    const t = q && this.todos()[q.id]
    const todo = t ? `${t.file.split('/').pop()}:${t.line}` : undefined
    return c || next ? { ...(c ? { concern: { ...c, ...(todo ? { todo } : {}) } } : {}), ...(next ? { next } : {}) } : undefined
  }
  qidOf(n: Note): string | undefined { return linkOf(n)?.q }
  /** A check thread's question text and state (used where a check thread is handled outside the Check view). */
  rowOf(n: Note): { text: string; state: string } | undefined {
    const q = this.questionOf(n)
    return q ? { text: q.text, state: this.grading.has(q.id) ? 'ungraded' : this.U.stateOf(q) } : undefined
  }
  /** The code links of message `mi` of a check thread (with the line text to find them after edits). */
  linksIn(n: Note, mi: number): (Link & { text: string })[] {
    const q = this.questionOf(n)
    if (!q) return []
    return linksAt(q, n.data.messages.map((m) => m.role ?? ""), mi).map((l) => ({ ...l, text: l.text ?? '' }))
  }
  /** The question behind a check thread (for Ask Claude about it). */
  questionOf(n: Note): Question | undefined { const l = linkOf(n); return l ? this.st?.check?.questions.find((x) => x.id === l.q) : undefined }

  /** What to do about a concern: Suggest a fix (a new note, asked to Claude), Add TODO (a comment above the lines), Flag for review. */
  async concern(n: Note, action: 'fix' | 'todo' | 'flag'): Promise<void> {
    const q = this.questionOf(n)
    const c = q && concernOf(q)
    if (!q || !c || !this.repo) return
    if (action === 'fix') {
      // A note on the code the concern names, asked to Claude for a short fix that Apply puts in.
      const at = await this.concernAt(q, n)
      await this.host.askAbout(at.file, at.start, at.end, `Suggest a fix: ${c.suspect ? q.text : c.text}`, { checkFix: q.id, ...this.branchOf(n) })
      return
    }
    if (action === 'todo') {
      // Above the code the concern names (else the question's first line); one short line; said in the thread.
      const at = await this.concernAt(q, n)
      const uri = vscode.Uri.joinPath(this.folder!.uri, at.file)
      const doc = await vscode.workspace.openTextDocument(uri)
      const line = doc.lineAt(Math.min(doc.lineCount - 1, Math.max(0, at.start - 1)))
      const indent = line.text.slice(0, line.firstNonWhitespaceCharacterIndex)
      const mark = commentMark(at.file)
      const edit = new vscode.WorkspaceEdit()
      edit.insert(uri, new vscode.Position(line.lineNumber, 0), `${indent}${todoLine(mark, c.suspect ? q.text : c.text)}\n`)
      if (!(await vscode.workspace.applyEdit(edit))) return
      await doc.save()
      await this.addTodo(q.id, at.file, line.lineNumber + 1)
      this.host.refresh()
      return
    }
    // Flag for reviewer: on the merge request (toggles); independent of a TODO.
    const abs = this.abs!
    const check = this.U.readCheck(abs)
    const fq = check.questions.find((x) => x.id === q.id)
    if (!fq) return
    const text = c.suspect ? q.text : c.text
    fq.concern = { ...(fq.concern ?? { text }), text: fq.concern?.text ?? text, flagged: !c.flagged }
    // Flagged by someone other than the check's author: the merge request says who.
    const me = this.me(), by = check.answeredBy
    const other = !!me && !!by && (me.email && by.email ? me.email !== by.email : me.name !== by.name)
    if (fq.concern.flagged && other) fq.concern.by = { ...(me!.name ? { name: me!.name } : {}), ...(me!.email ? { email: me!.email } : {}) }
    else delete fq.concern.by
    this.save(abs, check)
    await this.refresh()
    this.host.refresh()
  }

  /** For the integration test. */
  snapshot() { return { tourBusy: !!this.touring, bg: this.bgTrace, status: this.st && { ...this.st, check: undefined }, words: this.words, item: this.item.text, itemWarn: !!this.item.backgroundColor, view: this.current(), panel: this.view.state(), grading: [...this.grading.keys()], errors: [...this.gradeErrors.values()] } }
  panelSend(m: unknown): void { this.view.send(m) }

  dispose(): void { for (const s of this.subs) s.dispose(); this.item.dispose(); clearTimeout(this.timer) }
}

function gitOut(repo: string, args: string[], allowEmpty = false): Promise<string | undefined> {
  return new Promise((resolve) => execFile('git', args, { cwd: repo, timeout: 5000 }, (err, out) => resolve(err ? undefined : out.trim() || (allowEmpty ? '' : undefined))))
}
function execFileSyncQuiet(repo: string, args: string[]): string {
  try { return require('child_process').execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' }
}
/** Source Control with its message box focused. */
async function openScm(): Promise<void> {
  await vscode.commands.executeCommand('workbench.view.scm')
  await vscode.commands.executeCommand('workbench.scm.focus').then(undefined, () => undefined)
}
/** A line comment for a file's language: [open, close]. */
function commentMark(file: string): [string, string] {
  const ext = path.extname(file).toLowerCase()
  if (['.py', '.rb', '.sh', '.bash', '.yaml', '.yml', '.toml', '.r', '.pl', '.ex', '.exs', '.tf'].includes(ext) || /(^|\/)(Dockerfile|Makefile)$/.test(file)) return ['#', '']
  if (['.sql', '.lua', '.hs'].includes(ext)) return ['--', '']
  if (['.html', '.xml', '.vue', '.svelte', '.md'].includes(ext)) return ['<!--', ' -->']
  if (['.css', '.scss'].includes(ext)) return ['/*', ' */']
  return ['//', '']
}

/** The Check view in the Code Notes sidebar: where the check stands, the questions as rows, one button. */
class CheckViewProvider implements vscode.WebviewViewProvider {
  private wv: vscode.WebviewView | undefined
  private ready = false
  private last: CheckView | undefined
  private queue: unknown[] = []
  /** What the webview reported (integration test): rows drawn, layout problems, errors. */
  private reported: { rows?: number; overflow?: string[]; errors: string[]; height?: number } = { errors: [] }

  constructor(private extUri: vscode.Uri, private log: vscode.LogOutputChannel, private onMessage: (m: { type: string; id?: string; file?: string; on?: boolean; text?: string; i?: number }) => void) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.wv = view
    this.ready = false
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extUri, 'media')] }
    view.webview.html = this.html(view.webview)
    view.webview.onDidReceiveMessage((m: { type: string; id?: string; file?: string; on?: boolean; ok?: boolean; text?: string; i?: number; rows?: number; overflow?: string[]; message?: string; height?: number }) => {
      if (m.type === 'ready') { this.ready = true; this.post(); for (const q of this.queue.splice(0)) void view.webview.postMessage(q) }
      else if (m.type === 'rendered') this.reported = { ...this.reported, rows: m.rows, overflow: m.overflow, height: m.height }
      else if (m.type === 'error') { this.reported.errors.push(String(m.message)); this.log.error(`check view: ${m.message}`) }
      else if (m.type === 'focused' && m.id) this.focused(m.id, !!m.ok)
      this.onMessage(m)
    })
    view.onDidDispose(() => { this.wv = undefined; this.ready = false })
  }

  /** Shows the view (opening the sidebar on it), keeping the keyboard where it is. */
  reveal(): void {
    if (this.wv) this.wv.show(true)
    else void vscode.commands.executeCommand('codeNotes.check.focus').then(() => vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup'))
  }
  update(v: CheckView | undefined): void { this.last = v; this.post() }
  /** The keyboard into question `id`'s answer box (the view shown and focused first; once more if it didn't arrive). */
  async focus(id: string): Promise<void> {
    const e = vscode.window.activeTextEditor
    this.focusTries = { id, left: 1, sel: e ? `${e.document.uri}|${e.selection.active.line}:${e.selection.active.character}` : '' }
    if (this.wv) this.wv.show(false)
    else await vscode.commands.executeCommand('codeNotes.check.focus')
    this.send({ type: 'focus', id })
  }
  private focusTries: { id: string; left: number; sel: string } | undefined
  /** Esc, or anything else that moves on: no second try. */
  cancelFocus(): void { this.focusTries = undefined }
  private focused(id: string, ok: boolean): void {
    const t = this.focusTries
    if (ok || !t || t.id !== id || t.left <= 0 || !this.wv) { if (ok) this.focusTries = undefined; return }
    // The person moved on meanwhile (the caret moved): leave the keyboard where they put it.
    const e = vscode.window.activeTextEditor
    if ((e ? `${e.document.uri}|${e.selection.active.line}:${e.selection.active.character}` : '') !== t.sel) { this.focusTries = undefined; return }
    t.left--
    this.log.info(`check view: the answer box didn't get the keyboard; again`)
    this.wv.show(false)
    this.send({ type: 'focus', id })
  }
  private post(): void {
    if (!this.wv || !this.ready) return
    void this.wv.webview.postMessage({ type: 'check', view: this.last ?? null })
  }
  send(m: unknown): void { if (this.wv && this.ready) void this.wv.webview.postMessage(m); else this.queue.push(m) }
  state() { return { open: !!this.wv, visible: !!this.wv?.visible, ...this.reported } }

  private html(w: vscode.Webview): string {
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('')
    const uri = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'media', f))
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri('check.css')}"><link rel="stylesheet" href="${uri('checkAnswer.css')}"></head>
<body><div id="app"></div><script nonce="${nonce}" src="${uri('checkAnswer.js')}"></script><script nonce="${nonce}" src="${uri('check.js')}"></script></body></html>`
  }
}
