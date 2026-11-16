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
import { Check, CheckView, Cli, Question, Status, Who, Words, checkPhase, checkPrompt, checkView, concernOf, gradeBody, questionBody, statusText } from './checkModel'
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
  reveal(n: Note, column?: vscode.ViewColumn): Promise<void>
  /** The note shown last (revealed), if any. */
  revealed(): string | undefined
  refresh(): void
  /** The view column the code is shown in. */
  codeColumn(): vscode.ViewColumn | undefined
  /** The check's row in the journeys list changed (and what the editor shows around it: lenses). */
  listChanged?(): void
  /** A new note on these lines with this question, asked to Claude (Ask Claude on a check question). */
  askAbout(file: string, start: number, end: number, question: string, extra: Record<string, unknown>): Promise<void>
}

export const SESSION = (branch: string) => `Check · ${branch}`
const AUTHOR = 'Understanding check'
const SKILL = 'understanding-check'
const ATTR_LINE = 'understanding/*.json linguist-generated=true'
const ATTR_KEY = 'codeNotes.understanding.attributesOffered'
/** Questions written for a branch that was no longer checked out when they were done: kept here until it is. */
const CACHE = '.code-notes/.cache/checks'
const isCheck = (n: Note) => !!(n.data.extra as { check?: unknown } | undefined)?.check
const linkOf = (n: Note) => (n.data.extra as { check?: { file: string; q: string } } | undefined)?.check
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
  private writing: { started: number; phase: string; branch: string; ask?: Ask } | undefined
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
    if (this.st && this.st.branch !== before) this.pushed = undefined
    if (this.st && !this.st.exists && (await this.restoreCached())) return this.doRefresh()
    this.words = this.st ? this.U.stateWords(this.st.state, this.st) : undefined
    // Pushed? Ahead of its upstream, or no upstream at all.
    const ahead = this.st?.state.phase === 'done' ? await gitOut(repo, ['rev-list', '--count', '@{u}..HEAD'], true) : undefined
    this.unpushed = ahead === undefined ? undefined : ahead !== '0'
    if (!this.writing) {
      const t = statusText(this.st, this.words)
      if (t) {
        this.item.text = t.text; this.item.tooltip = t.tip
        this.item.backgroundColor = t.warn ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined
        this.item.show()
      } else this.item.hide()
    }
    if (this.st?.check) await this.syncThreads(this.st.check)
    this.post()
    this.host.listChanged?.()
  }

  private cfg() { return this.repo && this.U ? this.U.loadConfig(this.repo) : { maxDrift: 40, passRatio: 0.6, questions: { min: 1, max: 5 }, model: null } }

  private me(): Who | undefined { return this.repo && this.U ? this.U.gitIdentity(this.repo) : undefined }

  current(): CheckView | undefined {
    if (!this.st || !this.words) return undefined
    const busy = this.writing ? `Writing questions · ${clock(Date.now() - this.writing.started)} · ${this.writing.phase}` : this.pushing ? 'Pushing…' : undefined
    return checkView(this.st, this.words, { busy, grading: new Set(this.grading.keys()), unpushed: this.unpushed, pushed: this.pushed, me: this.me() })
  }
  private post(): void { this.view.update(this.current()) }

  // ---------- the command ----------

  /** Check my understanding: write the questions (or top them up), else show them. */
  async run(): Promise<void> {
    if (!this.repo) { void vscode.window.showInformationMessage('Open a folder (a git repository) to check your understanding of a change.'); return }
    await this.refresh()
    const st = this.st
    if (!st) { void vscode.window.showInformationMessage('Check my understanding needs a git repository with a branch to compare.'); return }
    const p = st.state.phase
    if (p === 'invalid') { void vscode.window.showWarningMessage(`Code Notes: ${st.next}`); return }
    if (p === 'nothing') { void vscode.window.showInformationMessage(st.next); return }
    if (p === 'none') { await this.write(false); return }
    this.show()
    if (p === 'drift') { if (st.state.commitFirst) await openScm(); else await this.write(true); return }
    await this.openNext()
  }

  /** The skill: the repository's copy, the home folder's, else the one inside the extension. */
  private skill(): { dir: string; bundled: boolean } {
    const bundled = vscode.Uri.joinPath(this.host.extUri, 'skills', SKILL).fsPath
    const dir = [path.join(this.repo!, '.claude/skills', SKILL), path.join(os.homedir(), '.claude/skills', SKILL), bundled].find((d) => fs.existsSync(path.join(d, 'scripts', 'questions.mjs')))!
    return { dir, bundled: dir === bundled }
  }

  /** Uncommitted and untracked (not ignored) changes the questions won't see: "1 uncommitted change and 1 new file (x.js)". */
  private async loose(): Promise<string | undefined> {
    const out = await gitOut(this.repo!, ['status', '--porcelain', '--untracked-files=all'], true)
    const lines = (out ?? '').split('\n').filter(Boolean).filter((l) => !/^.. (understanding|\.code-notes)\//.test(l))
    const fresh = lines.filter((l) => l.startsWith('??')).map((l) => path.basename(l.slice(3)))
    const changed = lines.length - fresh.length
    const parts = [changed ? `${changed} uncommitted change${changed === 1 ? '' : 's'}` : '', fresh.length ? `${fresh.length} new file${fresh.length === 1 ? '' : 's'} (${fresh.slice(0, 2).join(', ')}${fresh.length > 2 ? ', …' : ''})` : '']
    return parts.filter(Boolean).join(' and ') || undefined
  }

  /** Claude writes the questions with the skill, for the branch checked out now; then question 1 opens. */
  async write(topUp: boolean): Promise<boolean> {
    const repo = this.repo!, st = this.st!
    if (this.writing) { this.show(); return false }
    if (!this.host.allowed('write understanding-check questions')) return false
    const loose = await this.loose()
    if (loose) {
      const pick = await vscode.window.showInformationMessage(`Questions cover committed code only: ${loose} ${/ and |s \(/.test(loose) ? 'are' : 'is'} not included.`, 'Commit first', 'Continue')
      if (pick === 'Commit first') { await openScm(); return false }
      if (pick !== 'Continue') return false
    }
    const cli = this.host.cli()
    const { dir, bundled } = this.skill()
    const prompt = checkPrompt({ skill: dir, branch: st.branch, baseRef: st.baseRef ?? 'the default branch', base: st.base ?? 'main', topUp, bundled })
    if (!cli) {
      await vscode.env.clipboard.writeText(prompt)
      void vscode.window.showInformationMessage('Claude Code was not found: copied a prompt for your agent.')
      return false
    }
    const model = this.host.model()
    const w = (this.writing = { started: Date.now(), phase: 'starting', branch: st.branch } as NonNullable<Understanding['writing']>)
    this.item.text = '$(sync~spin) Understanding'
    this.item.show()
    this.host.log.info(`understanding check: Claude (${model ?? 'default model'}) is ${topUp ? 'topping up' : 'writing'} the questions for ${st.branch}`)
    let res: AskResult
    try {
      res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: topUp ? 'Adding questions' : 'Writing questions', cancellable: true }, async (progress, token) => {
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
    // The branch was switched while Claude worked: its questions wait in the cache until it is checked out again.
    const now = await gitOut(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (!res.cancelled && !res.error && now && now !== w.branch && this.park(w.branch)) {
      void vscode.window.showInformationMessage(`Questions for ${w.branch} are ready: switch back to answer them.`)
      await this.refresh()
      return false
    }
    await this.refresh()
    if (res.cancelled) return false
    if (res.error) { void vscode.window.showWarningMessage(`Code Notes: Claude couldn't write the questions: ${res.error}`); return false }
    const after = this.st?.check?.questions.length ?? 0
    if (after <= before) {
      // NOTHING / UNCOMMITTED / PROBLEM: the script's own words.
      const why = /(SMALL|NOTHING|UNCOMMITTED|PROBLEM):?\s*([^\n]+)/.exec(res.text)?.[2] ?? res.text.trim().split('\n')[0] ?? 'no questions were written'
      void vscode.window.showInformationMessage(`No questions: ${why}`)
      return false
    }
    this.host.log.info(`understanding check: ${after - before} questions written in ${clock(Date.now() - w.started)}${res.costUsd ? `, $${res.costUsd.toFixed(3)}` : ''}`)
    // Only the first question opens: its code and its thread. The list is in the Check view.
    await this.openNext()
    if (!topUp) void this.offerAttributes()
    return true
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
      fs.renameSync(src, path.join(repo, CACHE, `${this.U.slugOf(branch)}.json`))
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

  /** On the first check: collapse the check files in merge request diffs (GitLab and GitHub read .gitattributes). */
  private async offerAttributes(): Promise<void> {
    const file = path.join(this.repo!, '.gitattributes')
    let text = ''
    try { text = fs.readFileSync(file, 'utf8') } catch { /* none yet */ }
    if (text.includes('understanding/*.json') || this.host.memento.get(ATTR_KEY)) return
    await this.host.memento.update(ATTR_KEY, true)
    const pick = await vscode.window.showInformationMessage('Collapse check files in merge request diffs?', 'Add to .gitattributes', 'No')
    if (pick !== 'Add to .gitattributes') return
    fs.writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${ATTR_LINE}\n`)
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

  /** A question's thread, in the code's group. */
  async open(id: string): Promise<void> {
    const n = this.noteOf(id)
    if (n) await this.host.reveal(n, this.host.codeColumn())
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

  private onView(m: { type: string; id?: string }): void {
    if (m.type === 'open' && m.id) void this.open(m.id)
    else if (m.type === 'start') void this.write(false)
    else if (m.type === 'topUp') void this.write(true)
    else if (m.type === 'scm') void openScm()
    else if (m.type === 'commitPush') void this.commitPush()
    else if (m.type === 'ready') this.post()
  }

  /** Commit & push: the check file (and .gitattributes when its line is new) in one commit, then the push. */
  async commitPush(): Promise<void> {
    if (!this.repo || !this.st || this.pushing) return
    const files = [this.st.file]
    const attr = await gitOut(this.repo, ['status', '--porcelain', '--', '.gitattributes'], true)
    if (attr) { try { if (fs.readFileSync(path.join(this.repo, '.gitattributes'), 'utf8').includes(ATTR_LINE)) files.push('.gitattributes') } catch { /* gone */ } }
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
      out.push({ author: a.by?.name ?? check.answeredBy?.name ?? this.host.me(), role: 'human', body: a.answer, ...(a.at ? { at: a.at } : {}) })
      if (a.verdict) out.push({ author: AUTHOR, role: 'agent', body: gradeBody(a, { restatement: explained }), ...(a.gradedAt ? { at: a.gradedAt } : {}) })
      if (a.verdict === 'explained') explained = true
    }
    return out
  }

  /** Every question has its thread; answers and grades written elsewhere (the CLI, another window) are added. */
  private async syncThreads(check: Check): Promise<void> {
    for (const q of check.questions) {
      const want = this.messagesOf(q, check)
      const n = this.noteOf(q.id)
      if (!n) { await this.createNote(q, want); continue }
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
        extra: { check: { file: this.st!.file, q: q.id } },
      },
    }
    if (await this.host.store.save(n)) await this.host.changed(n, true)
  }

  // ---------- answering and grading ----------

  isCheck(n: Note): boolean { return isCheck(n) }
  /** A check thread of another branch's check: not shown (its file and lines belong to that branch). */
  offBranch(n: Note): boolean { const l = linkOf(n); return !!l && !!this.st && l.file !== this.st.file }
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
    if (!q) { await this.host.addReply(n, body); return }
    const state = this.U.stateOf(q)
    // Passed: a remark, not graded. Explained: a restatement, graded against the explanation.
    if (state === 'pass' || state === 'restated') { await this.host.addReply(n, body); return }
    if (this.grading.has(q.id)) return
    // The thread first: a refresh between the two then finds the answer there already (no second copy).
    if (!(await this.host.addReply(n, body))) return
    this.U.addAttempt(check, q, body, this.U.gitIdentity(this.repo))
    this.save(abs, check)
    await this.grade(q.id)
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
    const prompt = this.U.graderPrompt({ q, answer: last.answer, ...mode, diff: this.U.diffForGrader(diff, q.file), code: this.U.codeWindow(repo, q), canRead: true })
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
      // The file may have changed while Claude worked: read it again, grade the same answer.
      check = this.U.readCheck(abs)
      q = check.questions.find((x) => x.id === id)
      const a = q?.attempts?.slice().reverse().find((x) => x.answer === last.answer && !x.verdict)
      if (!q || !a) return
      Object.assign(a, v, { gradedAt: this.host.now() })
      a.hash = this.U.attemptHash(q, a)
      // One concern per question, kept on it (its flag survives a later grade).
      if (v.concern) q.concern = { text: v.concern, flagged: q.concern?.flagged ?? false, at: a.gradedAt }
      this.save(abs, check)
      this.host.log.info(`understanding check: ${id} ${v.verdict}${v.concern ? ' (concern)' : ''}${res.costUsd ? `, $${res.costUsd.toFixed(3)}` : ''}`)
      await this.refresh() // the grade reaches the thread through syncThreads
      // A pass: on to the next question, if the person is still on this one (the passed thread stays open).
      if ((v.verdict === 'pass' || v.verdict === 'restated') && !v.concern && n && this.host.revealed() === n.data.id && this.hasOpen()) await this.step(1)
    } finally { this.post(); this.host.refresh() }
  }

  /** A thread's passing state for commentsOf: checking, why it couldn't be checked, a concern about the code. */
  threadStatus(n: Note): { checking?: boolean; error?: string; concern?: { text: string; flagged: boolean; suspect: boolean } } | undefined {
    const l = linkOf(n)
    if (!l) return undefined
    if (this.grading.has(l.q)) return { checking: true }
    const e = this.gradeErrors.get(n.data.id)
    if (e) return { error: e }
    const q = this.st?.check?.questions.find((x) => x.id === l.q)
    const c = q && concernOf(q)
    return c ? { concern: c } : undefined
  }
  qidOf(n: Note): string | undefined { return linkOf(n)?.q }
  /** The question behind a check thread (for Ask Claude about it). */
  questionOf(n: Note): Question | undefined { const l = linkOf(n); return l ? this.st?.check?.questions.find((x) => x.id === l.q) : undefined }

  /** What to do about a concern: Fix now (Ask Claude, a new note), Add TODO (a comment above the lines), Flag for review. */
  async concern(n: Note, action: 'fix' | 'todo' | 'flag'): Promise<void> {
    const q = this.questionOf(n)
    const c = q && concernOf(q)
    if (!q || !c || !this.repo) return
    const start = n.data.range.start, end = n.data.range.end
    if (action === 'fix') {
      await this.host.askAbout(n.data.file, start, end, c.suspect ? `Is this a bug? ${q.text} If it is, fix it.` : `Fix this: ${c.text}`, { checkFix: q.id })
      return
    }
    if (action === 'todo') {
      const uri = vscode.Uri.joinPath(this.folder!.uri, n.data.file)
      const doc = await vscode.workspace.openTextDocument(uri)
      const line = doc.lineAt(Math.max(0, start - 1))
      const indent = line.text.slice(0, line.firstNonWhitespaceCharacterIndex)
      const mark = commentMark(n.data.file)
      const edit = new vscode.WorkspaceEdit()
      edit.insert(uri, new vscode.Position(line.lineNumber, 0), `${indent}${mark[0]} TODO: ${c.suspect ? q.text : c.text}${mark[1]}\n`)
      await vscode.workspace.applyEdit(edit)
      await doc.save()
    }
    // Flag for reviewer: on the merge request (toggles); a TODO in the code takes the place of the flag.
    const abs = this.abs!
    const check = this.U.readCheck(abs)
    const fq = check.questions.find((x) => x.id === q.id)
    if (!fq) return
    const text = c.suspect ? q.text : c.text
    fq.concern = { ...(fq.concern ?? { text }), text: fq.concern?.text ?? text, flagged: action === 'flag' ? !c.flagged : false }
    this.save(abs, check)
    await this.refresh()
    this.host.refresh()
  }

  /** The check as a row of the journeys list (journeyList.ts). */
  listItem(): import('./journeyList').ListItem | undefined {
    const c = this.st?.check, s = this.st?.summary
    if (!c || !s || !this.st) return undefined
    return { key: `check:${this.st.file}`, kind: 'check', title: `Check · ${this.st.branch}`, question: 'Questions about this branch\'s change', summary: '',
      ...(c.createdAt ? { createdAt: c.createdAt } : {}), files: c.questions.map((q) => q.file), stepTitles: c.questions.map((q) => q.text), steps: c.questions.length,
      stale: 0, isNew: false, resume: 0, progress: `${s.done}/${s.total} done`, open: this.st.state.phase !== 'done' }
  }

  /** For the integration test. */
  snapshot() { return { status: this.st && { ...this.st, check: undefined }, words: this.words, item: this.item.text, itemWarn: !!this.item.backgroundColor, view: this.current(), panel: this.view.state(), grading: [...this.grading.keys()], errors: [...this.gradeErrors.values()] } }
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

  constructor(private extUri: vscode.Uri, private log: vscode.LogOutputChannel, private onMessage: (m: { type: string; id?: string }) => void) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.wv = view
    this.ready = false
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extUri, 'media')] }
    view.webview.html = this.html(view.webview)
    view.webview.onDidReceiveMessage((m: { type: string; id?: string; rows?: number; overflow?: string[]; message?: string; height?: number }) => {
      if (m.type === 'ready') { this.ready = true; this.post(); for (const q of this.queue.splice(0)) void view.webview.postMessage(q) }
      else if (m.type === 'rendered') this.reported = { ...this.reported, rows: m.rows, overflow: m.overflow, height: m.height }
      else if (m.type === 'error') { this.reported.errors.push(String(m.message)); this.log.error(`check view: ${m.message}`) }
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
<link rel="stylesheet" href="${uri('check.css')}"></head>
<body><div id="app"></div><script nonce="${nonce}" src="${uri('check.js')}"></script></body></html>`
  }
}
