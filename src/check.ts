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
import { Check, CheckView, Cli, CommitPlan, Link, QState, Question, Status, Who, Words, checkPhase, checkPrompt, checkView, writeFailure, concernOf, gradeBody, linksAt, questionBody, statusText, todoLines, todoPlace, gradeFailure, tourPrompt } from './checkModel'
import { clock } from './writing'
import { CliThread } from './cliThread'
import { Coalesced } from './gitKey'
import { nonce as newNonce } from './webview/page'

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
/** Files `init` writes: committed with the check when someone ran it by hand. */
const REPO_FILES = ['.gitattributes', '.ignore']
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
/** Per branch: per question, the file its suggested fix was applied to (offered, ticked, by Commit & push). */
const FIX_KEY = 'codeNotes.understanding.fixFiles'
/** Unsent answers typed in the Check view's box: per check file, per question (this workspace only, never the file). */
const DRAFT_KEY = 'codeNotes.understanding.drafts'
/** Questions being written (per workspace): a window reloaded meanwhile says so instead of offering Start again. */
const WRITING_KEY = 'codeNotes.understanding.writing'
/** The parts of VS Code's git extension API used here. */
interface GitRepo { rootUri: vscode.Uri; state: { HEAD?: { name?: string; commit?: string; upstream?: unknown; ahead?: number }; onDidChange: vscode.Event<void> } }
interface GitApi { repositories: GitRepo[]; onDidOpenRepository: vscode.Event<GitRepo> }
const importFn = new Function('u', 'return import(u)') as (u: string) => Promise<unknown>
const notDone = (s: string) => s === 'todo' || s === 'retry' || s === 'ungraded'

export class Understanding implements vscode.Disposable {
  private U!: Cli
  /** The CLI's git work (status, diffs, identity), on a worker thread: never waited for by the extension host. */
  private T!: CliThread
  /** What the last full refresh read, as one hash (cliWorker.ts, gateKey): a trigger that finds it unchanged stops there. */
  private key: string | undefined
  /** Who answers (git's user.name and user.email), as the last refresh read it. */
  private who: Who | undefined
  /** Refreshes done in full and skipped as unchanged (integration test). */
  private counts = { full: 0, same: 0 }
  private item: vscode.StatusBarItem
  readonly view: CheckViewProvider
  private subs: vscode.Disposable[] = []
  /** The workspace folder (its repository) the check is about: the first one. */
  private folder = vscode.workspace.workspaceFolders?.[0]
  st: Status | undefined
  words: Words | undefined
  private unpushed: boolean | undefined
  private pushed: string | undefined
  /** The commit Commit & push left HEAD at: its line goes once HEAD moves on (a pull, a merge, a commit). */
  private pushedHead: string | undefined
  /** The host's "create a merge request" link the last push printed (a branch without one). */
  private mr: string | undefined
  /** One line about what was just done (a merge kept both answers): until the next push or branch. */
  private said: string | undefined
  private pushing = false
  /** Questions written in the background and not opened yet: the status bar says how many are ready. */
  private ready = 0
  /** What the push watcher saw last (integration test). */
  private bgTrace: string[] = []
  /** Writing the questions failed (said in the view with Retry until a retry works). */
  private failed: { branch: string; topUp: boolean; text: string; setting?: boolean; path?: boolean } | undefined
  /** One line about what the questions left out, for this branch. */
  private notice: { branch: string; text: string } | undefined
  /** What Commit & push would commit (refreshed while the check is done), and the TODO files ticked to go with it. */
  private commit: Omit<CommitPlan, 'include' | 'exclude'> | undefined
  private include = new Set<string>()
  /** Files of an applied fix the person unticked (they go with Commit & push unless unticked). */
  private exclude = new Set<string>()
  /** The question selected in the Check view (its answer box is shown). */
  private selected: string | undefined
  private writing: { started: number; phase: string; branch: string; ask?: Ask } | undefined
  /** The tour being written (after the questions: they can be answered meanwhile); the last try failed (branch). */
  private touring: { started: number; phase: string; branch: string; session?: string; topUp: boolean; paused?: boolean; ask?: Ask } | undefined
  private tourFailed: string | undefined
  /** Branches whose unfinished check was moved out of the tree when another branch was checked out: put back quietly. */
  private parkedQuiet = new Set<string>()
  /** Nothing of the change is committed yet (said before any Claude call); the check starts once it is (branch). */
  private uncommittedOnly = false
  private startAfterCommit: string | undefined
  /** Ticks the view while questions written before a reload are still being written. */
  private orphanTimer: NodeJS.Timeout | undefined
  /** The tour was being written when its branch was switched away: stopped, and written again once it is back. */
  private tourPaused: { branch: string; session?: string; topUp: boolean } | undefined
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
    this.T = new CliThread(p.fsPath)
    // Claude runs the skill's script by its path: it must be executable (an unzip may have dropped the bit).
    const script = vscode.Uri.joinPath(this.host.extUri, 'skills', SKILL, 'scripts', 'questions.mjs').fsPath
    try { fs.accessSync(script, fs.constants.X_OK) } catch { try { fs.chmodSync(script, 0o755) } catch { /* read-only install */ } }
    if (!this.folder || this.folder.uri.scheme !== 'file') return
    const f = this.folder
    // Every trigger goes through the same check (gated): a refresh reads git only when something it shows can have
    // changed. No watcher on .git/index: any `git status` (VS Code's own Git view, a terminal, an agent) rewrites it,
    // which kept the check refreshing over and over; VS Code's git extension says when the working tree changed.
    const later = () => this.refreshSoon(400, false)
    // A commit moves the branch (logs/HEAD), not .git/HEAD; a checkout changes both.
    for (const glob of ['understanding/*.json', '.git/HEAD', '.git/logs/HEAD', '.git/refs/remotes/**']) {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(f, glob))
      w.onDidChange(later); w.onDidCreate(later); w.onDidDelete(later)
      this.subs.push(w)
    }
    this.subs.push(vscode.window.onDidChangeWindowState((s) => { if (s.focused) later() }), vscode.workspace.onDidSaveTextDocument(later),
      // An applied fix undone (or edited) before it is saved: what Commit & push offers follows.
      vscode.workspace.onDidChangeTextDocument((e) => { if (this.repo && e.contentChanges.length && Object.values(this.fixes()).some((f) => e.document.uri.fsPath === path.join(this.repo!, f))) later() }))
    this.watchPushes()
    await this.refresh()
  }

  private get repo(): string | undefined { return this.folder?.uri.fsPath }
  private get abs(): string | undefined { return this.st && this.repo ? path.join(this.repo, this.st.file) : undefined }

  /** `force` false: a trigger (a file event, focus, a save): skipped when nothing the refresh reads changed. */
  refreshSoon(ms = 400, force = true): void {
    clearTimeout(this.timer)
    this.soonForce ||= force
    this.timer = setTimeout(() => { const f = this.soonForce; this.soonForce = false; void this.refresh(f) }, ms)
  }
  private soonForce = false

  /** One refresh at a time; the calls made meanwhile share one more (coalesced). */
  private runs = new Coalesced((force) => this.doRefresh(force).catch((e) => { this.key = undefined; this.host.log.error(`understanding check: ${e}`) }))
  /**
   * Reads where the branch stands, then the status bar, the threads and the view follow. `force` false: only when
   * something it reads changed since the last refresh (HEAD, a ref, the working tree, the check file, …).
   */
  refresh(force = true): Promise<void> { return this.runs.run(force) }
  private async doRefresh(force: boolean): Promise<void> {
    const repo = this.repo
    if (!repo || !this.U) return
    // An applied fix edited and not saved yet: only the editor knows (Commit & push offers it).
    const fixFiles = Object.values(this.fixes())
    const edited = fixFiles.filter((f) => vscode.workspace.textDocuments.some((d) => d.isDirty && d.uri.fsPath === path.join(repo, f)))
    const r = await this.T.call<{ key?: string; same?: boolean; st?: Status; error?: string; ident?: Who }>('refreshState', repo,
      { prev: force ? undefined : this.key, files: [...REPO_FILES, ...this.todoFiles(), ...fixFiles], untracked: !!this.notice, extra: edited.join('\0') })
      .catch((e: Error) => ({ error: e.message } as { key?: string; same?: boolean; st?: Status; error?: string; ident?: Who }))
    if (r.same) { this.counts.same++; return }
    this.counts.full++
    // Unknown until this refresh is through (a failure part way leaves it unknown: the next trigger reads again).
    this.key = undefined
    const before = this.st?.branch
    this.st = r.st
    this.who = r.ident
    if (!r.st) this.host.log.info(`understanding check: no status (${r.error ?? 'unknown'})`)
    if (this.st && this.st.branch !== before) {
      this.pushed = undefined; this.mr = undefined; this.selected = undefined; this.said = undefined
      // The branch left behind had an unfinished check (untracked): it waits in the cache, not in this branch's tree.
      if (before && (await this.park(before))) this.parkedQuiet.add(before)
    }
    // What the last Commit & push said (a rejected push, a failed commit) is stale once HEAD has moved on.
    if (this.pushed && this.pushed !== 'Pushed.' && this.pushedHead !== undefined && (await gitOut(repo, ['rev-parse', 'HEAD'])) !== this.pushedHead) this.pushed = undefined
    // The tour reads the code checked out: another branch stops it (its check is left as it was); back, it goes on.
    const t = this.touring
    if (t && this.st && this.st.branch !== t.branch && !t.paused) {
      t.paused = true
      this.tourPaused = { branch: t.branch, session: t.session, topUp: t.topUp }
      this.host.log.info(`understanding check: tour paused: the branch changed to ${this.st.branch}`)
      t.ask?.cancel()
    }
    const p = this.tourPaused
    if (p && !this.touring && this.st?.branch === p.branch && this.st.check) {
      this.tourPaused = undefined
      this.host.log.info(`understanding check: back on ${p.branch}: the tour goes on`)
      setTimeout(() => void this.writeTour(p.topUp, { session: p.session }), 0)
    }
    if (this.st && !this.st.exists && (await this.restoreCached())) return this.doRefresh(true)
    this.words = this.st ? this.U.stateWords(this.st.state, this.st) : undefined
    // No check yet and nothing of the change committed: the questions would have nothing to ask about.
    const st0 = this.st
    this.uncommittedOnly = st0?.state.phase === 'none' && !!st0.base && !!st0.head && st0.changed > 0 && await this.T.call<{ added: number; removed: number }>('codeStat', repo, st0.base, st0.head, this.cfg().exempt).then((s) => this.U.linesOf(s) === 0, () => false)
    if (this.startAfterCommit && this.startAfterCommit === st0?.branch && st0.state.phase === 'none' && !this.uncommittedOnly && !this.writing) {
      this.startAfterCommit = undefined
      setTimeout(() => void this.write(false), 0)
    }
    // Pushed? Ahead of its upstream, or no upstream at all.
    const ahead = this.st?.state.phase === 'done' ? await gitOut(repo, ['rev-list', '--count', '@{u}..HEAD'], true) : undefined
    this.unpushed = ahead === undefined ? undefined : ahead !== '0'
    // What Commit & push would take (an applied fix is said on its question before the check is done, too).
    this.commit = this.st?.check ? await this.toCommit() : undefined
    // What the questions left out: only while it still is uncommitted (committed or reverted since: the line goes).
    if (this.notice && this.notice.branch === this.st?.branch && !this.writing) await this.noteLoose(this.notice.branch)
    if (!this.writing) {
      const t = statusText(this.st, this.words)
      if (t && this.ready && this.st?.state.phase === 'answering' && !this.st.summary?.done) { t.text = `$(checklist) ${this.ready} question${this.ready === 1 ? '' : 's'} ready`; t.tip = `Questions about ${this.st.branch} are ready · Check my understanding` }
      // Done: the same words as the Check view ("Pushed.", "Not pushed yet."), not the file's alone.
      const line = this.st?.state.phase === 'done' ? this.current()?.line : undefined
      if (t && line) t.tip = [this.words?.title, line].filter(Boolean).join(' · ')
      // Only what changed is sent to the window (each change is a message to it).
      const shown = t ? JSON.stringify([t.text, t.tip, !!t.warn]) : ''
      if (shown !== this.itemShown) {
        this.itemShown = shown
        if (t) {
          this.item.text = t.text; this.item.tooltip = t.tip
          // Read out as words (VS Code would read the icon's id: "pass Understanding").
          this.item.accessibilityInformation = { label: `Understanding check: ${t.tip.replace(/^✓\s*/, '').replace(/ · /g, '. ')}`, role: 'button' }
          this.item.backgroundColor = t.warn ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined
          this.item.show()
        } else this.item.hide()
      }
    }
    if (this.st?.check) await this.syncThreads(this.st.check)
    // While there is a check, an empty Code Notes view steps aside: the Check view gets its room (package.json).
    const open = !!this.st?.check
    if (open !== this.checkOpen) { this.checkOpen = open; void vscode.commands.executeCommand('setContext', 'codeNotes.checkOpen', open) }
    // A file that can't be read (a bad edit, a conflict) keeps the tour shown as it was until it reads again.
    if (this.st?.state.phase !== 'invalid') await this.host.tourChanged?.(this.st?.check, this.abs, this.st?.branch)
    this.post()
    this.host.listChanged?.()
    this.key = r.key
  }
  private checkOpen: boolean | undefined
  /** What the status bar item shows (set elsewhere too: then this is reset). */
  private itemShown: string | undefined

  private cfg() { return this.repo && this.U ? this.U.loadConfig(this.repo) : { maxDrift: 40, passRatio: 0.6, questions: { min: 1, max: 5 }, model: null } }

  private me(): Who | undefined { return this.who }

  current(): CheckView | undefined {
    if (!this.st || !this.words) return undefined
    // Writing for another branch (switched meanwhile): said with its name, never as this branch's progress.
    const w = this.writing
    const busy = w ? (w.branch === this.st.branch ? `Writing questions · ${clock(Date.now() - w.started)} · ${w.phase}` : `Writing questions for ${w.branch} · ${clock(Date.now() - w.started)}`) : this.pushing ? 'Pushing…' : undefined
    const orphan = !w && this.st.state.phase === 'none' ? this.orphan() : undefined
    if (orphan && !this.orphanTimer) this.orphanTimer = setInterval(() => { if (!this.orphan()) { clearInterval(this.orphanTimer); this.orphanTimer = undefined; this.refreshSoon(0) } else this.post() }, 1000)
    const busy2 = busy ?? (orphan ? `Writing questions · ${clock(Date.now() - orphan.started)}` : undefined)
    const tourBusy = this.touring && this.touring.branch === this.st.branch ? `Writing the tour · ${clock(Date.now() - this.touring.started)}` : undefined
    const sel = this.selected ? this.noteOf(this.selected) : undefined
    const gradeError = sel && this.gradeErrors.get(sel.data.id)
    return checkView(this.st, this.words, { ...(gradeError ? { error: gradeFailure(gradeError) } : {}), busy: busy2, tourBusy, uncommitted: this.uncommittedOnly, invalidAt: this.parseError()?.text, tourFailed: this.tourFailed === this.st.branch, grading: new Set([...this.grading.keys(), ...this.answering]), unpushed: this.unpushed, pushed: this.pushed, ...(this.mr ? { mr: this.mr } : {}), me: this.me(),
      notice: this.notice?.branch === this.st.branch && this.st.state.phase !== 'done' ? this.notice.text : undefined,
      ...(this.commit ? { commit: { ...this.commit, include: this.include, exclude: this.exclude } } : {}),
      ...(this.selected ? { selected: this.selected, draft: this.drafts()[this.selected] ?? '' } : {}),
      ...(this.failed?.branch === this.st.branch ? { failed: { text: this.failed.text, ...(this.failed.setting ? { setting: true } : {}), ...(this.failed.path ? { path: true } : {}) } } : {}),
      ...(this.said ? { said: this.said } : {}) })
  }
  private post(): void { this.view.update(this.current()) }
  /** Questions for this branch still being written by a Claude Code started before the window was reloaded. */
  private orphan(): { started: number } | undefined {
    const o = this.host.memento.get<{ branch: string; started: number; pid?: number }>(WRITING_KEY)
    if (!o || !this.st || o.branch !== this.st.branch || !o.pid || Date.now() - o.started > 10 * 60_000) return undefined
    try { process.kill(o.pid, 0); return { started: o.started } } catch { return undefined }
  }
  /** Where an invalid check file stops being JSON (not a conflict: that has its own words). */
  private parseError(): { line: number; col: number; text: string } | undefined {
    if (this.st?.state.phase !== 'invalid' || this.st.conflict || !this.abs) return undefined
    let text: string
    try { text = fs.readFileSync(this.abs, 'utf8'); JSON.parse(text); return undefined } catch (e) {
      const m = String((e as Error).message)
      let lc = /line (\d+) column (\d+)/.exec(m)?.slice(1).map(Number)
      const pos = /position (\d+)/.exec(m)?.[1]
      if (!lc && pos !== undefined && typeof text! === 'string') { const before = text.slice(0, Number(pos)).split('\n'); lc = [before.length, before.at(-1)!.length + 1] }
      if (!lc) return undefined
      const what = m.replace(/^(Unexpected token[^,]*|[^(]*?)(?:,.*| in JSON.*| at position.*|\(.*)$/s, '$1').trim().replace(/\.$/, '')
      return { line: lc[0], col: lc[1], text: `Line ${lc[0]}: ${what ? `${what[0].toLowerCase()}${what.slice(1)}` : 'not valid JSON'}.` }
    }
  }

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
    // A file that can't be read: open it, at the first conflict marker.
    if (p === 'invalid') { await this.openFile(); return }
    if (p === 'nothing' || p === 'stashed') { this.show(); return }
    if (p === 'none') { await this.write(false); return }
    this.show()
    if (p === 'drift') { if (st.state.commitFirst) await openScm(); else await this.write(true); return }
    // Done but not committed or pushed: the status item does what the view's button does.
    // Only the tour is new: no commit and pipeline of its own (it goes with the next push); the tour opens instead.
    if (p === 'done' && ((st.dirty && !this.commit?.tourOnly) || this.commit?.fixes?.length || this.unpushed !== false)) { this.show(); await this.commitPush(); return }
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
    if (!bg) { this.failed = undefined; await this.noteLoose(st.branch) }
    const cli = this.host.cli()
    const { dir, bundled } = this.skill()
    const prompt = checkPrompt({ skill: dir, branch: st.branch, baseRef: st.baseRef ?? 'the default branch', base: st.base ?? 'main', topUp, bundled, head: st.head })
    if (!cli && bg) return false
    if (!cli) {
      // Said in the view (install it, or set its path); the prompt is on the clipboard for another agent.
      await vscode.env.clipboard.writeText(prompt)
      this.failed = { branch: st.branch, topUp, text: "Claude Code wasn't found.", path: true }
      this.post()
      return false
    }
    const model = this.host.model()
    const w = (this.writing = { started: Date.now(), phase: 'starting', branch: st.branch } as NonNullable<Understanding['writing']>)
    this.itemShown = undefined
    this.item.text = '$(sync~spin) Understanding'
    this.item.accessibilityInformation = { label: 'Understanding check: writing questions', role: 'button' }
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
        this.remember(w)
        token.onCancellationRequested(() => ask.cancel())
        tick()
        const t = setInterval(tick, 1000)
        try { return await ask.done } finally { clearInterval(t) }
      })
    } finally { this.writing = undefined; void this.host.memento.update(WRITING_KEY, undefined) }
    const before = st.check?.questions.length ?? 0
    // The branch was switched while Claude worked: its questions wait in the cache (the script writes them there; a
    // file it wrote just before the switch is moved there) until it is checked out again. Nothing else happens here:
    // nothing opens, nothing is written to the branch checked out now.
    const now = await gitOut(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (now && now !== w.branch) {
      await this.park(w.branch)
      const kept = fs.existsSync(path.join(repo, this.U.cachedFor(w.branch)))
      if (kept && !bg) void vscode.window.showInformationMessage(`Questions for ${w.branch} are ready: switch back to answer them.`)
      this.host.log.info(`understanding check: the branch changed to ${now} while writing for ${w.branch}${kept ? '; kept for it' : ''}`)
      await this.refresh()
      return false
    }
    await this.refresh()
    if (res.cancelled) return false
    // A failure is said in the Check view, in plain words, with Retry (and logged); a success clears it.
    const fail = (f: { text: string; setting?: boolean }, detail: string) => {
      this.host.log.error(`understanding check: no questions for ${w.branch}: ${detail}`)
      if (!bg) { this.failed = { branch: w.branch, topUp, ...f }; this.post() }
      return false
    }
    if (res.error) return fail(writeFailure({ error: res.error, model }), res.error)
    const after = this.st?.check?.questions.length ?? 0
    if (after <= before) return fail(writeFailure({ text: res.text }), res.text.trim().split('\n').slice(-1)[0] ?? '')
    this.failed = undefined
    this.host.log.info(`understanding check: ${after - before} questions written in ${clock(Date.now() - w.started)}${res.costUsd ? `, $${res.costUsd.toFixed(3)}` : ''}`)
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
    const branch = this.st!.branch
    const t = (this.touring = { started: Date.now(), phase: 'starting', branch, session: o.session, topUp } as NonNullable<Understanding['touring']>)
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
    if (res.cancelled || t.paused) return false
    const after = this.st?.check?.journey?.steps.length ?? 0
    // Documentation that describes no code: no tour, on purpose.
    if (!res.error && !before && this.st?.check?.noTour) { this.host.log.info(`understanding check: no tour for ${branch}: the text describes no code`); this.post(); return true }
    if (res.error || after <= before) {
      // A short reason; Claude's own reply (it may talk to someone who isn't there) only in the debug log.
      this.host.log.error(`understanding check: no tour for ${branch}: ${res.error ? res.error.split('\n')[0].slice(0, 160) : 'Claude wrote none'}`)
      if (!res.error) this.host.log.debug(`understanding check: the tour writer said: ${res.text.trim().slice(-400)}`)
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
    this.remember(w)
    return ask.done
  }
  /** The writer, for a window reloaded before it is done (see orphan). */
  private remember(w: NonNullable<Understanding['writing']>): void { void this.host.memento.update(WRITING_KEY, { branch: w.branch, started: w.started, pid: w.ask?.pid }) }

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
          // The Git view read the repository again (a file changed, a commit, a checkout): whatever the check shows
          // follows, if it changed (gated: nothing is read again otherwise).
          this.refreshSoon(400, false)
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
  private async park(branch: string): Promise<boolean> {
    const repo = this.repo!
    const rel = this.U.fileFor(branch)
    const src = path.join(repo, rel)
    if (!fs.existsSync(src)) return false
    try {
      fs.mkdirSync(path.join(repo, CACHE), { recursive: true })
      const ignore = path.join(repo, '.code-notes/.cache/.gitignore')
      if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n')
      // Tracked on this branch (it has a check of that name): leave it, it is not ours to move.
      const tracked = !!(await gitOut(repo, ['ls-files', '--', rel]))
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
    // Moved out only because another branch was checked out: back where it was, nothing said.
    if (this.parkedQuiet.delete(st.branch)) return true
    void vscode.window.showInformationMessage(`Your questions for ${st.branch} are here.`)
    setTimeout(() => void this.openNext(), 300)
    return true
  }

  /** The check file, at its first conflict marker when it has one. */
  private async openFile(): Promise<void> {
    if (!this.abs) return
    const pe = this.parseError()
    const line = Math.max(0, (this.st?.conflict?.line ?? pe?.line ?? 1) - 1), col = Math.max(0, (pe?.col ?? 1) - 1)
    const ed = await vscode.window.showTextDocument(vscode.Uri.file(this.abs), { preview: false, selection: new vscode.Selection(line, col, line, col) })
    ed.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter)
  }
  /** Keep both answers: each question once, from the side with more graded answers. */
  private async mergeConflict(): Promise<void> {
    const abs = this.abs
    if (!abs) return
    const text = fs.readFileSync(abs, 'utf8')
    const c = this.U.conflictOf(text)
    if (!c?.merged) { await this.openFile(); return }
    // A concern flagged on either side stays flagged (a flag is a request to a reviewer; a dismissal can be redone).
    const flagged = new Map<string, NonNullable<Question['concern']>>()
    for (const side of conflictSides(text)) for (const q of side?.questions ?? []) if (q.concern?.flagged) flagged.set(q.id, q.concern)
    const kept: number[] = []
    c.merged.questions.forEach((q, i) => { const f = flagged.get(q.id); if (f && !q.concern?.flagged) { q.concern = f; kept.push(i + 1) } })
    this.U.writeCheck(abs, this.U.stamp(c.merged, this.U.loadConfig(this.repo!)))
    this.said = `Both answers kept.${kept.length ? ` Question ${kept.join(', ')}: its concern stays flagged (one side flagged it).` : ''}`
    this.host.log.info(`understanding check: merge conflict in ${this.st?.file} resolved: both answers kept${kept.length ? `; flags kept on ${kept.join(', ')}` : ''}`)
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
    // Its own lines stay in view, also when a tour's step card far from them is drawn a moment later and scrolls there.
    const file = path.join(this.repo ?? '', n.data.file), r = n.data.range
    for (const ms of [250, 800]) setTimeout(() => {
      if (this.selected !== id) return
      const ed = vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === file)
      const want = new vscode.Range(r.start - 1, 0, r.end - 1, 0)
      if (ed && !ed.visibleRanges.some((v) => v.contains(want.start))) ed.revealRange(want, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
    }, ms)
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
    if (!n || !text.trim() || this.grading.has(id) || this.answering.has(id)) return
    // The box empties and says "Checking…" at once (the draft is in memory before it is stored); a failed answer
    // puts its text back.
    void this.setDraft(id, '')
    if (!(await this.answer(n, text)) && !this.grading.has(id)) void this.setDraft(id, text)
    this.post()
  }
  /** A code link in the box's grade: the same link as in the thread (lit, the keyboard stays in the box). */
  private async viewLink(id: string, i: number): Promise<void> {
    const n = this.noteOf(id)
    const q = this.st?.check?.questions.find((x) => x.id === id)
    if (!n || !q) return
    // The grade's message in the thread: the k-th agent message after the question for the k-th graded attempt.
    const k = (q.attempts ?? []).filter((a) => a.verdict && (a.answer !== undefined || a.verdict === 'explained')).length
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

  private onView(m: { type: string; id?: string; file?: string; on?: boolean; text?: string; i?: number; action?: string }): void {
    if (m.type === 'open' && m.id) { const id = m.id; void (this.host.openInTour?.(id) ?? Promise.resolve(false)).then((ok) => { if (!ok) void this.open(id) }) }
    else if (m.type === 'tour') void this.host.walkTour?.()
    else if (m.type === 'writeTour') void this.writeTour(false)
    else if (m.type === 'select' && m.id) { this.selected = m.id; this.post() }
    else if (m.type === 'answer' && m.id && typeof m.text === 'string') void this.answerFromView(m.id, m.text)
    else if (m.type === 'draft' && m.id && typeof m.text === 'string') void this.setDraft(m.id, m.text)
    else if (m.type === 'link' && m.id && typeof m.i === 'number') void this.viewLink(m.id, m.i)
    else if (m.type === 'next') void this.step(1)
    else if (m.type === 'concern' && m.id && ['fix', 'todo', 'flag', 'dismiss'].includes(String(m.action))) { const n = this.noteOf(m.id); if (n) void this.concern(n, m.action as 'fix' | 'todo' | 'flag' | 'dismiss') }
    else if (m.type === 'openFile') void this.openFile()
    else if (m.type === 'merge') void this.mergeConflict()
    else if (m.type === 'retry') { const t = !!this.failed?.topUp; this.failed = undefined; void this.write(t) }
    else if (m.type === 'modelSetting') void vscode.commands.executeCommand('workbench.action.openSettings', 'codeNotes.understanding.model')
    else if (m.type === 'pathSetting') void vscode.commands.executeCommand('workbench.action.openSettings', 'codeNotes.claude.path')
    else if (m.type === 'install') void vscode.env.openExternal(vscode.Uri.parse('https://claude.com/claude-code'))
    else if (m.type === 'regrade' && m.id) void this.grade(m.id)
    else if (m.type === 'escape') { this.view.cancelFocus(); void vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup') }
    else if (m.type === 'include' && m.file) {
      // A fix goes unless unticked; a TODO only when ticked.
      if (this.commit?.fixes?.includes(m.file)) { if (m.on) this.exclude.delete(m.file); else this.exclude.add(m.file) }
      else if (m.on) this.include.add(m.file); else this.include.delete(m.file)
      this.post()
    }
    else if (m.type === 'start') void this.write(false)
    else if (m.type === 'topUp') void this.write(true)
    else if (m.type === 'scm') { if (this.uncommittedOnly && this.st) this.startAfterCommit = this.st.branch; void openScm() }
    else if (m.type === 'commitPush') void this.commitPush()
    else if (m.type === 'pull') void this.pull()
    else if (m.type === 'openMr' && this.mr) void vscode.env.openExternal(vscode.Uri.parse(this.mr))
    else if (m.type === 'ready') this.post()
  }

  /**
   * What Commit & push commits: the check file and the setup files `init` changed; `todos`: files a TODO was added to
   * from the check (uncommitted), committed only when ticked; `fold`: the repository's first check commit also adds the
   * .gitattributes line that folds check files in diffs (written on commit). Nothing else the person changed.
   */
  private async toCommit(): Promise<Omit<CommitPlan, 'include' | 'exclude'>> {
    const repo = this.repo!, st = this.st!
    const dirty = async (f: string) => fs.existsSync(path.join(repo, f)) && !!(await gitOut(repo, ['status', '--porcelain', '--', f], true))
    // A fix applied and not saved yet counts too (Commit & push saves it first).
    const edited = (f: string) => !!vscode.workspace.textDocuments.find((d) => d.uri.fsPath === path.join(repo, f))?.isDirty
    const files = [st.file]
    for (const f of REPO_FILES) if (await dirty(f)) files.push(f)
    const todos: string[] = []
    for (const f of this.todoFiles()) if (await dirty(f)) todos.push(f)
    // An applied fix still in the code, not committed: its file, and the questions it answers.
    const fixes: string[] = [], applied: string[] = []
    const open = (q: string) => { const x = st.check?.questions.find((y) => y.id === q); return !!x && !!concernOf(x) }
    for (const [q, f] of Object.entries(this.fixes())) if (open(q) && (edited(f) || await dirty(f))) { if (!fixes.includes(f)) fixes.push(f); applied.push(q) }
    const fold = !files.includes('.gitattributes') && this.U.foldMissing(repo)
    return { files, todos, ...(fixes.length ? { fixes, applied } : {}), ...(st.dirty && !st.untracked && await this.tourOnly() ? { tourOnly: true } : {}), ...(fold ? { fold, foldText: this.U.FOLD_TEXT } : {}) }
  }
  /** The check file's only change since it was committed is its tour (the answers are in the commit). */
  private async tourOnly(): Promise<boolean> {
    const was = await gitOut(this.repo!, ['show', `HEAD:${this.st!.file}`], true)
    if (!was || !this.st?.check) return false
    const bare = (c: Record<string, unknown>) => JSON.stringify({ ...c, journey: undefined, result: undefined, updatedAt: undefined })
    try { const old = JSON.parse(was); return !!this.st.check.journey && JSON.stringify(old.journey ?? null) !== JSON.stringify(this.st.check.journey) && bare(old) === bare(this.st.check as unknown as Record<string, unknown>) } catch { return false }
  }
  /** The fixes applied from this branch's check: per question, the file. */
  private fixes(): Record<string, string> { return this.st ? this.host.memento.get<Record<string, Record<string, string>>>(FIX_KEY)?.[this.st.branch] ?? {} : {} }
  /** A suggested fix (a note asked from a concern) was applied to `file`: offered with Commit & push, the concern says so. */
  async fixApplied(q: string, file: string): Promise<void> {
    if (!this.st) return
    const all = this.host.memento.get<Record<string, Record<string, string>>>(FIX_KEY) ?? {}
    await this.host.memento.update(FIX_KEY, { ...all, [this.st.branch]: { ...(all[this.st.branch] ?? {}), [q]: file } })
    this.exclude.delete(file)
    this.refreshSoon(100)
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

  /**
   * A concern's code changed since it was raised: its suggested fix was applied, the line its grade named is gone, or
   * the file has uncommitted changes in the lines it is about.
   */
  private async concernChanged(q: Question, n: Note): Promise<boolean> {
    if (this.commit?.applied?.includes(q.id) || q.id in this.fixes()) return true
    const l = this.U.concernLink(q)
    try {
      if (l?.text) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(this.folder!.uri, l.file))
        if (!Array.from({ length: doc.lineCount }, (_, k) => doc.lineAt(k).text).includes(l.text)) return true
      }
      const at = await this.concernAt(q, n)
      const diff = await gitOut(this.repo!, ['diff', '-U0', 'HEAD', '--', at.file], true)
      return (diff ?? '').split('\n').some((h) => { const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(h); if (!m) return false; const a = Number(m[1]), b = a + Math.max(0, Number(m[2] ?? 1) - 1); return a <= at.end && b >= at.start })
    } catch { return false }
  }

  /** Commit & push: exactly the files named in the view (the check file, .gitattributes on the first check, ticked TODO files), then the push. */
  async commitPush(): Promise<void> {
    if (!this.repo || !this.st || this.pushing) return
    const { files, todos, fixes = [], fold } = await this.toCommit()
    const fixing = fixes.filter((f) => !this.exclude.has(f))
    // The repository's first check commit: the .gitattributes line that folds check files in diffs goes with it.
    if (fold && this.st.dirty) { try { if (this.U.foldDiffs(this.repo).length) files.push('.gitattributes') } catch (e) { this.host.log.error(`understanding check: couldn't write .gitattributes: ${(e as Error).message}`) } }
    for (const f of fixing) await vscode.workspace.textDocuments.find((d) => d.uri.fsPath === path.join(this.repo!, f) && d.isDirty)?.save()
    files.push(...todos.filter((f) => this.include.has(f) && !fixes.includes(f)), ...fixing)
    this.pushing = true; this.post()
    try {
      // A concern whose fix goes in this commit: marked fixed in the check file (off the merge request), in the same commit.
      const done = Object.entries(this.fixes()).filter(([, f]) => fixing.includes(f)).map(([q]) => q)
      if (done.length && this.abs) {
        const check = this.U.readCheck(this.abs)
        const me = this.me(), at = this.host.now()
        for (const q of check.questions) if (done.includes(q.id) && q.concern && !q.concern.dismissed && !q.concern.fixed) q.concern = { ...q.concern, flagged: false, fixed: { ...(me?.name || me?.email ? { by: { ...(me.name ? { name: me.name } : {}), ...(me.email ? { email: me.email } : {}) } } : {}), at } }
        this.save(this.abs, check)
      }
      // A merge in progress (its conflict resolved here): the merge commit first; the push then takes it.
      const merging = await this.merging()
      if (merging) {
        await gitOut(this.repo, ['add', '--', this.st.file], true)
        if ((await gitOut(this.repo, ['commit', '--no-edit', '-q'], true)) === undefined) {
          const left = ((await gitOut(this.repo, ['diff', '--name-only', '--diff-filter=U'], true)) ?? '').split('\n').filter(Boolean)
          this.pushed = left.length ? `Finish the merge first: ${left.map((f) => path.basename(f)).join(', ')} still ${left.length === 1 ? 'has' : 'have'} conflicts.` : "Couldn't finish the merge: commit it yourself."
          this.pushedHead = await gitOut(this.repo, ['rev-parse', 'HEAD'])
          return
        }
      }
      const r = await this.U.commitAndPush(this.repo, files, `Understanding check: ${this.st.branch}`)
      this.pushed = r.line
      this.pushedHead = await gitOut(this.repo, ['rev-parse', 'HEAD'])
      this.mr = r.ok ? r.mr : undefined
      this.said = undefined
      // Said where the person looks (the status item may have done it): what went, and that it was pushed.
      if (r.ok) vscode.window.setStatusBarMessage(`$(check) ${r.committed || merging ? `Committed ${files.map((f) => path.basename(f)).join(', ')} and pushed` : 'Pushed'}${r.mr ? ' · no merge request yet' : ''}`, 8000)
      if (r.committed && fixing.length) {
        const all = this.host.memento.get<Record<string, Record<string, string>>>(FIX_KEY) ?? {}
        await this.host.memento.update(FIX_KEY, { ...all, [this.st.branch]: Object.fromEntries(Object.entries(all[this.st.branch] ?? {}).filter(([, f]) => !fixing.includes(f))) })
      }
      this.host.log.info(`understanding check: commit & push: ${r.line}`)
      if (!r.ok) void vscode.window.showWarningMessage(`Code Notes: ${r.line}`)
    } finally { this.pushing = false; await this.refresh() }
  }
  /** A merge is in progress (MERGE_HEAD in the git dir). */
  private async merging(): Promise<boolean> {
    const p = await gitOut(this.repo!, ['rev-parse', '--git-path', 'MERGE_HEAD'])
    return !!p && fs.existsSync(path.resolve(this.repo!, p))
  }
  /** After a rejected push: the remote's commits merged in (a conflict in the check file is then offered to merge). */
  private async pull(): Promise<void> {
    if (!this.repo || this.pushing) return
    this.pushing = true; this.post()
    try {
      const ok = await gitOut(this.repo, ['pull', '--no-rebase', '--no-edit', '-q'], true) !== undefined
      this.pushed = ok || await this.merging() ? undefined : "Couldn't pull: pull in a terminal to see why."
      this.pushedHead = await gitOut(this.repo, ['rev-parse', 'HEAD'])
    } finally { this.pushing = false; await this.refresh() }
  }

  // ---------- threads (a view of the file) ----------

  private noteOf(id: string): Note | undefined {
    const file = this.st?.file
    return this.host.store.all().find((n) => linkOf(n)?.q === id && linkOf(n)?.file === file)
  }

  /**
   * The thread messages a question's file entry stands for: the question, then each answer and its grade. A superseded
   * answer (not kept in the file) is left out with its grade, except an explanation: that is the lesson.
   */
  private messagesOf(q: Question, check: Check): NoteData['messages'] {
    const out: NoteData['messages'] = [{ author: AUTHOR, role: 'agent', body: questionBody(q) }]
    let explained = false
    for (const a of q.attempts ?? []) {
      if (a.answer !== undefined) out.push({ author: a.by?.name ?? check.answeredBy?.name ?? this.host.me(), role: 'human', body: a.answer, ...(a.at ? { at: a.at } : {}) })
      if (a.verdict && (a.answer !== undefined || a.verdict === 'explained')) out.push({ author: AUTHOR, role: 'agent', body: gradeBody(a, { restatement: explained }), ...(a.gradedAt ? { at: a.gradedAt } : {}) })
      if (a.verdict === 'explained') explained = true
    }
    return out
  }
  /**
   * A thread's copies of answers the file no longer keeps (a later one superseded them) go, with the grade under each
   * (an explanation stays). They are the thread's answers before the kept one that aren't kept, matched from the last.
   */
  private dropSuperseded(n: Note, q: Question): boolean {
    const gone = (q.attempts ?? []).filter((a) => a.answer === undefined)
    const kept = new Set((q.attempts ?? []).flatMap((a) => (a.answer !== undefined ? [a.answer] : [])))
    const ms = n.data.messages
    let last = -1
    ms.forEach((m, i) => { if (m.role === 'human' && kept.has(m.body)) last = i })
    if (!gone.length || last < 0) return false
    const old = ms.map((m, i) => ({ m, i })).filter(({ m, i }) => i > 0 && i < last && m.role === 'human' && !kept.has(m.body))
    if (!old.length) return false
    const drop = new Set<number>()
    old.reverse().forEach(({ i }, k) => {
      const a = gone[gone.length - 1 - k]
      drop.add(i)
      if (ms[i + 1]?.role === 'agent' && a?.verdict !== 'explained') drop.add(i + 1)
    })
    n.data.messages = ms.filter((_m, i) => !drop.has(i))
    return true
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
      if (this.dropSuperseded(n, q) && await this.host.store.save(n)) await this.host.changed(n, false)
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
    // Another branch's check, or this branch's while its file is gone (stashed, deleted): not shown.
    return !!f && !!this.st && (f !== this.st.file || !this.st.exists)
  }
  /** For a note made from a check thread: the check it belongs to (hidden with it on other branches). */
  branchOf(n: Note): { checkFile?: string } { const f = linkOf(n)?.file; return f ? { checkFile: f } : {} }
  /** Graded in this window: the thread stays open where it is. */
  pinned(n: Note): boolean { return this.graded.has(n.data.id) }
  /** A question not done yet is in this file: journey lenses step aside. */
  hasOpenIn(uri: vscode.Uri): boolean { return this.openIn(uri).length > 0 }
  /** The ids of the questions not done yet in this file (journey lenses step aside around their lines). */
  openIn(uri: vscode.Uri): string[] {
    if (!this.repo || !this.st?.check) return []
    const rel = path.relative(this.repo, uri.fsPath).split(path.sep).join('/')
    return this.st.check.questions.filter((q) => q.file === rel && notDone(this.U.stateOf(q))).map((q) => q.id)
  }

  /** The person answered in a question's thread: the answer goes into the file, then it is graded. */
  /** True when the answer was taken (saved in the thread, and in the file unless it is a remark). */
  async answer(n: Note, text: string): Promise<boolean> {
    const link = linkOf(n)
    if (!link || !this.repo) return false
    const body = text.trim()
    if (!body) return false
    // One answer at a time per question: a second Ctrl+Enter meanwhile is not a second answer.
    if (this.answering.has(link.q)) return false
    this.answering.add(link.q)
    this.post(); this.host.refresh()
    try { return await this.takeAnswer(n, link, body) } finally { this.answering.delete(link.q); this.post(); this.host.refresh() }
  }
  /** Questions whose answer is being taken: "Checking…" from the first moment. */
  private answering = new Set<string>()
  private async takeAnswer(n: Note, link: { file: string; q: string }, body: string): Promise<boolean> {
    // Gated: reads git again only if something changed (the check file is read below anyway).
    await this.refresh(false)
    const abs = path.join(this.repo!, link.file)
    let check: Check
    try { check = this.U.readCheck(abs) } catch { void vscode.window.showWarningMessage(`Code Notes: ${link.file} can't be read.`); return false }
    const q = check.questions.find((x) => x.id === link.q)
    // Only an answer to the question as it was shown: the file may have been rewritten since.
    if (!q || !sameQuestion(n, q)) {
      void vscode.window.showWarningMessage('This question changed: reopen it from the Check view.')
      await this.refresh()
      return false
    }
    const state = this.U.stateOf(q)
    // Passed: a remark, not graded. Explained: a restatement, graded against the explanation.
    if (state === 'pass' || state === 'restated') return this.host.addReply(n, body)
    if (this.grading.has(q.id)) return false
    // The thread first: a refresh between the two then finds the answer there already (no second copy).
    if (!(await this.host.addReply(n, body))) return false
    this.U.addAttempt(check, q, body, this.who)
    this.save(abs, check)
    // Not awaited: the reply box clears once the answer is in (VS Code clears it when the command returns).
    void this.grade(q.id)
    return true
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
    // Graded from here on (a second click while the diff is read starts nothing).
    this.grading.set(id, undefined)
    try { diff = await this.T.call<string>('diffText', repo, check.base ?? check.head) } catch { /* no diff: the grader reads the code */ }
    const prompt = this.U.graderPrompt({ q, answer: last.answer ?? "", ...mode, diff: this.U.diffForGrader(diff, q.file), code: this.U.codeWindow(repo, q), canRead: true, tour: this.U.tourText(check), others: this.U.openOthers(check, q) })
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
    if (this.grading.has(l.q) || this.answering.has(l.q)) return { checking: true }
    const e = this.gradeErrors.get(n.data.id)
    if (e) return { error: gradeFailure(e) }
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
  async concern(n: Note, action: 'fix' | 'todo' | 'flag' | 'dismiss' | 'fixed', given?: string): Promise<void> {
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
      const lines = Array.from({ length: doc.lineCount }, (_, k) => doc.lineAt(k).text)
      // Above the line, at its indentation (inside the block a "} catch {" line opens); the whole concern, wrapped.
      const place = todoPlace(lines, Math.min(doc.lineCount - 1, Math.max(0, at.start - 1)))
      const mark = commentMark(at.file)
      const edit = new vscode.WorkspaceEdit()
      edit.insert(uri, new vscode.Position(place.line, 0), todoLines(mark, c.suspect ? q.text : c.text).map((l) => `${place.indent}${l}\n`).join(''))
      if (!(await vscode.workspace.applyEdit(edit))) return
      await doc.save()
      await this.addTodo(q.id, at.file, place.line + 1)
      this.host.refresh()
      return
    }
    // Dismiss (not a problem, with a short reason) or Mark fixed: the concern leaves the merge request.
    let reason: string | undefined
    if (action === 'dismiss') {
      // Its code changed since it was raised (or its suggested fix was applied): "I fixed it" first, else why it's fine.
      let fixed = false
      if (given === undefined && await this.concernChanged(q, n)) {
        const pick = await vscode.window.showQuickPick([{ label: 'I fixed it', id: 'fixed' }, { label: "It isn't a problem…", id: 'why' }], { title: 'Dismiss this concern' })
        if (!pick) return
        fixed = pick.id === 'fixed'
      }
      reason = fixed ? 'fixed' : (given ?? await vscode.window.showInputBox({ title: 'Dismiss this concern', prompt: 'Why is it not a problem? One line, kept in the check file.', placeHolder: 'e.g. the caller checks it first' }))?.trim()
      if (!reason) return
    }
    // Flag for reviewer: on the merge request (toggles); independent of a TODO.
    const abs = this.abs!
    const check = this.U.readCheck(abs)
    const fq = check.questions.find((x) => x.id === q.id)
    if (!fq) return
    const text = c.suspect ? q.text : c.text
    const me = this.me(), by = check.answeredBy
    const who = me ? { ...(me.name ? { name: me.name } : {}), ...(me.email ? { email: me.email } : {}) } : undefined
    const at = this.host.now()
    if (action === 'dismiss' || action === 'fixed') {
      fq.concern = { ...(fq.concern ?? { text }), text: fq.concern?.text ?? text, flagged: false, ...(action === 'dismiss' ? { dismissed: { reason: reason!, ...(who ? { by: who } : {}), at } } : { fixed: { ...(who ? { by: who } : {}), at } }) }
      this.save(abs, check)
      await this.refresh()
      this.host.refresh()
      return
    }
    fq.concern = { ...(fq.concern ?? { text }), text: fq.concern?.text ?? text, flagged: !c.flagged }
    // Flagged by someone other than the check's author: the merge request says who.
    const other = !!me && !!by && (me.email && by.email ? me.email !== by.email : me.name !== by.name)
    if (fq.concern.flagged && other) fq.concern.by = { ...(me!.name ? { name: me!.name } : {}), ...(me!.email ? { email: me!.email } : {}) }
    else delete fq.concern.by
    this.save(abs, check)
    await this.refresh()
    this.host.refresh()
  }

  /** For the integration test. */
  snapshot() { return { itemLabel: this.item.accessibilityInformation?.label, tourBusy: !!this.touring, bg: this.bgTrace, status: this.st && { ...this.st, check: undefined }, words: this.words, item: this.item.text, itemWarn: !!this.item.backgroundColor, view: this.current(), panel: this.view.state(), grading: [...this.grading.keys()], errors: [...this.gradeErrors.values()], refreshes: { ...this.counts } } }
  panelSend(m: unknown): void { this.view.send(m) }
  /** The worker stops; the next call starts a new one (integration test: with another PATH). */
  restartWorker(): void { this.T?.dispose() }

  dispose(): void { for (const s of this.subs) s.dispose(); this.item.dispose(); clearTimeout(this.timer); this.T?.dispose() }
}

/** git's output (trimmed), or undefined. Reads never take the index lock (a `git status` here rewrites nothing). */
function gitOut(repo: string, args: string[], allowEmpty = false): Promise<string | undefined> {
  return new Promise((resolve) => execFile('git', args, { cwd: repo, timeout: 5000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (err, out) => resolve(err ? undefined : out.trim() || (allowEmpty ? '' : undefined))))
}
/** Both sides of a check file with conflict markers, as checks (undefined: a side that doesn't read). */
function conflictSides(text: string): (Check | undefined)[] {
  return (['ours', 'theirs'] as const).map((keep) => {
    let at: 'both' | 'ours' | 'theirs' = 'both'
    const out: string[] = []
    for (const l of text.split('\n')) {
      if (/^<{7}( |$)/.test(l)) at = 'ours'
      else if (/^={7}$/.test(l) && at === 'ours') at = 'theirs'
      else if (/^>{7}( |$)/.test(l)) at = 'both'
      else if (at === 'both' || at === keep) out.push(l)
    }
    try { return JSON.parse(out.join('\n')) as Check } catch { return undefined }
  })
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

  constructor(private extUri: vscode.Uri, private log: vscode.LogOutputChannel, private onMessage: (m: { type: string; id?: string; file?: string; on?: boolean; text?: string; i?: number; action?: string }) => void) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.wv = view
    this.ready = false
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extUri, 'media')] }
    view.webview.html = this.html(view.webview)
    view.webview.onDidReceiveMessage((m: { type: string; id?: string; file?: string; on?: boolean; ok?: boolean; text?: string; i?: number; action?: string; rows?: number; overflow?: string[]; message?: string; height?: number }) => {
      if (m.type === 'ready') { this.ready = true; this.sent = undefined; this.post(); for (const q of this.queue.splice(0)) void view.webview.postMessage(q) }
      else if (m.type === 'rendered') this.reported = { ...this.reported, rows: m.rows, overflow: m.overflow, height: m.height }
      else if (m.type === 'error') { this.reported.errors.push(String(m.message)); this.log.error(`check view: ${m.message}`) }
      else if (m.type === 'focused' && m.id) this.focused(m.id, !!m.ok)
      this.onMessage(m)
    })
    view.onDidDispose(() => { this.wv = undefined; this.ready = false; this.sent = undefined })
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
  /** The view as last sent to the webview: the same view again is not sent (a message to the window each time). */
  private sent: string | undefined
  private post(): void {
    if (!this.wv || !this.ready) return
    const msg = { type: 'check', view: this.last ?? null }
    const text = JSON.stringify(msg, (_k, v) => (v instanceof Set ? [...v] : v))
    if (text === this.sent) return
    this.sent = text
    void this.wv.webview.postMessage(msg)
  }
  send(m: unknown): void { if (this.wv && this.ready) void this.wv.webview.postMessage(m); else this.queue.push(m) }
  state() { return { open: !!this.wv, visible: !!this.wv?.visible, ...this.reported } }

  private html(w: vscode.Webview): string {
    const nonce = newNonce()
    const uri = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'media', f))
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri('check.css')}"><link rel="stylesheet" href="${uri('checkAnswer.css')}"></head>
<body><div id="app"></div><script nonce="${nonce}" src="${uri('checkAnswer.js')}"></script><script nonce="${nonce}" src="${uri('check.js')}"></script></body></html>`
  }
}
