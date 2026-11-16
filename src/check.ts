// The understanding check in VS Code (docs/understanding-check.md): Claude writes 3-5 questions about the branch's
// change (skills/understanding-check), they show as note threads on their lines and as rows in a small panel; an
// answer in a thread is graded by Claude (read-only) and the reply lands in the same thread. The file
// understanding/<branch>.json is the source of truth; the threads are a view of it, kept in sync both ways.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFile } from 'child_process'
import { pathToFileURL } from 'url'
import { Ask, AskResult } from './claude'
import { findCompact } from './compact'
import { Note, NoteData, Store } from './store'
import { Check, CheckView, Cli, Question, Status, checkPhase, checkPrompt, checkView, gradeBody, questionBody, statusText } from './checkModel'
import { clock } from './writing'

/** What the check needs from the rest of the extension (extension.ts). */
export interface CheckHost {
  log: vscode.LogOutputChannel
  store: Store
  extUri: vscode.Uri
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
  refresh(): void
  /** The view column the code is shown in (never the panel's). */
  codeColumn(): vscode.ViewColumn | undefined
  /** The check's row in the journeys list changed. */
  listChanged?(): void
}

export const SESSION = (branch: string) => `Check · ${branch}`
const AUTHOR = 'Understanding check'
const SKILL = 'understanding-check'
const isCheck = (n: Note) => !!(n.data.extra as { check?: unknown } | undefined)?.check
const linkOf = (n: Note) => (n.data.extra as { check?: { file: string; q: string } } | undefined)?.check
const importFn = new Function('u', 'return import(u)') as (u: string) => Promise<unknown>

export class Understanding implements vscode.Disposable {
  private U!: Cli
  private item: vscode.StatusBarItem
  private panel: CheckPanel
  private subs: vscode.Disposable[] = []
  /** The workspace folder (its repository) the check is about: the first one. */
  private folder = vscode.workspace.workspaceFolders?.[0]
  st: Status | undefined
  private staged = false
  private writing: { started: number; phase: string; ask?: Ask } | undefined
  /** Questions being graded now (by id), and failures to grade (by note id: shown in the thread with Try again). */
  readonly grading = new Map<string, Ask | undefined>()
  readonly gradeErrors = new Map<string, string>()
  private timer: NodeJS.Timeout | undefined

  constructor(private host: CheckHost) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 48)
    this.item.command = 'codeNotes.checkUnderstanding'
    this.panel = new CheckPanel(host.extUri, host.log, (m) => this.onPanel(m))
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
    for (const glob of ['understanding/*.json', '.git/{HEAD,index}']) {
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
  /** Reads where the branch stands, then the status bar, the threads and the panel follow (one at a time). */
  refresh(): Promise<void> {
    this.chain = this.chain.then(() => this.doRefresh(), (e) => this.host.log.error(`understanding check: ${e}`))
    return this.chain
  }
  private async doRefresh(): Promise<void> {
    const repo = this.repo
    if (!repo || !this.U) return
    try { this.st = this.U.localStatus(repo) } catch (e) { this.st = undefined; this.host.log.info(`understanding check: no status (${(e as Error).message.split('\n')[0]})`) }
    this.staged = !!this.st?.exists && !!(await gitOut(repo, ['diff', '--cached', '--name-only', '--', this.st.file]))
    const t = statusText(this.st, this.cfg().maxDrift)
    if (t && !this.writing) { this.item.text = t.text; this.item.tooltip = t.tip; this.item.show() }
    else if (!this.writing) this.item.hide()
    if (this.st?.check) await this.syncThreads(this.st.check)
    this.post()
    this.host.listChanged?.()
  }

  private cfg() { return this.repo && this.U ? this.U.loadConfig(this.repo) : { maxDrift: 40, minChangedLines: 20, passRatio: 0.6, questions: { min: 3, max: 5 }, model: null } }

  view(): CheckView | undefined {
    if (!this.st) return undefined
    return checkView(this.st, { maxDrift: this.cfg().maxDrift, staged: this.staged, grading: new Set(this.grading.keys()), busy: this.writing ? `Writing questions · ${clock(Date.now() - this.writing.started)} · ${this.writing.phase}` : undefined })
  }
  private post(): void { const v = this.view(); if (v) this.panel.update(v) }

  // ---------- the command ----------

  /** Check my understanding: write the questions (or top them up), else show them. */
  async run(): Promise<void> {
    if (!this.repo) { void vscode.window.showInformationMessage('Open a folder (a git repository) to check your understanding of a change.'); return }
    await this.refresh()
    const st = this.st
    if (!st) { void vscode.window.showInformationMessage('Check my understanding needs a git repository with a branch to compare.'); return }
    if (st.errors) { void vscode.window.showWarningMessage(`Code Notes: ${st.next}`); return }
    if (st.exists && st.check) {
      const drift = st.drift && st.drift.lines > this.cfg().maxDrift
      if (drift) { this.show(); await this.write(true) } else await this.openNext()
      return
    }
    if (st.small) { void vscode.window.showInformationMessage(st.next); return }
    await this.write(false)
  }

  /** The skill: the repository's copy, the home folder's, else the one inside the extension. */
  private skill(): { dir: string; bundled: boolean } {
    const bundled = vscode.Uri.joinPath(this.host.extUri, 'skills', SKILL).fsPath
    const dir = [path.join(this.repo!, '.claude/skills', SKILL), path.join(os.homedir(), '.claude/skills', SKILL), bundled].find((d) => fs.existsSync(path.join(d, 'scripts', 'questions.mjs')))!
    return { dir, bundled: dir === bundled }
  }

  /** Claude writes the questions with the skill; then the panel and the first question open. */
  async write(topUp: boolean): Promise<boolean> {
    const repo = this.repo!, st = this.st!
    if (this.writing) { this.show(); return false }
    if (!this.host.allowed('write understanding-check questions')) return false
    const cli = this.host.cli()
    const { dir, bundled } = this.skill()
    const prompt = checkPrompt({ skill: dir, branch: st.branch, baseRef: st.baseRef ?? 'the default branch', base: st.base ?? 'main', topUp, bundled })
    if (!cli) {
      await vscode.env.clipboard.writeText(prompt)
      void vscode.window.showInformationMessage('Claude Code was not found: copied a prompt for your agent.')
      return false
    }
    const model = this.host.model()
    const w = (this.writing = { started: Date.now(), phase: 'starting' } as { started: number; phase: string; ask?: Ask })
    this.item.text = '$(sync~spin) Check'
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
    await this.refresh()
    if (res.cancelled) return false
    if (res.error) { void vscode.window.showWarningMessage(`Code Notes: Claude couldn't write the questions: ${res.error}`); return false }
    const after = this.st?.check?.questions.length ?? 0
    if (after <= before) {
      // SMALL / NOTHING / UNCOMMITTED: the script's own words.
      const why = /(SMALL|NOTHING|UNCOMMITTED|PROBLEM):?\s*([^\n]+)/.exec(res.text)?.[2] ?? res.text.trim().split('\n')[0] ?? 'no questions were written'
      void vscode.window.showInformationMessage(`No questions: ${why}`)
      return false
    }
    this.host.log.info(`understanding check: ${after - before} questions written in ${clock(Date.now() - w.started)}${res.costUsd ? `, $${res.costUsd.toFixed(3)}` : ''}`)
    await this.openNext()
    return true
  }

  show(): void { const v = this.view(); this.panel.show(v ?? { branch: this.st?.branch ?? '', file: this.st?.file ?? '', progress: '', rows: [], met: false }) }

  /** The first question still to answer (or try again), else the first one; the panel beside it. */
  async openNext(): Promise<void> {
    const c = this.st?.check
    if (!c) return
    const q = c.questions.find((x) => ['todo', 'retry'].includes(this.U.stateOf(x))) ?? c.questions[0]
    await this.open(q.id)
    this.show()
  }

  /** A question's thread, in the code's group: never the panel's. */
  async open(id: string): Promise<void> {
    const n = this.noteOf(id)
    if (!n) return
    const pc = this.panel.column
    const col = pc === undefined ? undefined : vscode.window.visibleTextEditors.find((e) => e.viewColumn !== undefined && e.viewColumn !== pc)?.viewColumn
      ?? (pc === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One)
    await this.host.reveal(n, col)
  }

  private onPanel(m: { type: string; id?: string }): void {
    if (m.type === 'open' && m.id) void this.open(m.id)
    else if (m.type === 'stage') void this.stage()
    else if (m.type === 'topUp') void this.write(true)
    else if (m.type === 'ready') this.post()
  }

  async stage(): Promise<void> {
    if (!this.repo || !this.st) return
    const out = await gitOut(this.repo, ['add', '--', this.st.file], true)
    if (out === undefined) void vscode.window.showWarningMessage(`Code Notes: couldn't stage ${this.st.file}.`)
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
    for (const a of q.attempts ?? []) {
      out.push({ author: a.by?.name ?? check.answeredBy?.name ?? this.host.me(), role: 'human', body: a.answer, ...(a.at ? { at: a.at } : {}) })
      if (a.verdict) out.push({ author: AUTHOR, role: 'agent', body: gradeBody(a), ...(a.gradedAt ? { at: a.gradedAt } : {}) })
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
      if ((st === 'pass' || st === 'explained') && n.data.status === 'open') { n.data.status = 'resolved'; (n.data.events ??= []).push({ type: 'resolved', by: AUTHOR, role: 'agent', at: this.host.now() }) }
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
    const done = ['pass', 'explained'].includes(this.U.stateOf(q))
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
    if (state === 'pass' || state === 'explained') { await this.host.addReply(n, body); return } // done: a remark, not graded
    if (this.grading.has(q.id)) return
    // The thread first: a refresh between the two then finds the answer there already (no second copy).
    if (!(await this.host.addReply(n, body))) return
    this.U.addAttempt(check, q, body, this.U.gitIdentity(this.repo))
    this.U.writeCheck(abs, this.U.stamp(check, this.U.loadConfig(this.repo)))
    await this.grade(q.id)
  }

  /** Grades a question's latest answer with Claude (read-only), writes the verdict, replies in the thread. */
  async grade(id: string): Promise<void> {
    const repo = this.repo
    if (!repo || !this.st?.exists || this.grading.has(id)) return
    const abs = this.abs!
    const n = this.noteOf(id)
    if (n) this.gradeErrors.delete(n.data.id)
    if (!this.host.allowed('grade answers')) return
    const cli = this.host.cli()
    const fail = (why: string) => { if (n) this.gradeErrors.set(n.data.id, why); this.host.log.error(`understanding check: ${id}: ${why}`) }
    if (!cli) { fail('Claude Code (the `claude` CLI) was not found.'); this.host.refresh(); return }
    let check = this.U.readCheck(abs)
    let q = check.questions.find((x) => x.id === id)
    const last = q?.attempts?.at(-1)
    if (!q || !last) return
    const attempt = (q.attempts ?? []).filter((x) => x !== last && x.verdict).length + 1
    let diff = ''
    try { diff = this.U.diffText(repo, check.base ?? check.head) } catch { /* no diff: the grader reads the code */ }
    const prompt = this.U.graderPrompt({ q, answer: last.answer, attempt, diff: this.U.diffForGrader(diff, q.file), code: this.U.codeWindow(repo, q), canRead: true })
    const ask = new Ask({ cli, cwd: repo, prompt, model: this.host.model() })
    this.grading.set(id, ask)
    this.post(); this.host.refresh()
    const res = await ask.done
    this.grading.delete(id)
    try {
      if (res.cancelled) return
      if (res.error) { fail(res.error); return }
      let v: { verdict: 'pass' | 'retry' | 'explained'; feedback: string; hint: string }
      try { v = this.U.parseVerdict(res.text, attempt) } catch (e) { fail((e as Error).message); return }
      // The file may have changed while Claude worked: read it again, grade the same answer.
      check = this.U.readCheck(abs)
      q = check.questions.find((x) => x.id === id)
      const a = q?.attempts?.slice().reverse().find((x) => x.answer === last.answer && !x.verdict)
      if (!q || !a) return
      Object.assign(a, v, { gradedAt: this.host.now() })
      a.hash = this.U.attemptHash(q, a)
      this.U.writeCheck(abs, this.U.stamp(check, this.U.loadConfig(repo)))
      this.host.log.info(`understanding check: ${id} ${v.verdict}${res.costUsd ? `, $${res.costUsd.toFixed(3)}` : ''}`)
      await this.refresh() // the grade reaches the thread through syncThreads
      const st = this.st?.summary
      if (st && v.verdict !== 'retry' && st.met && !st.todo && !st.ungraded && !this.grading.size) this.show()
    } finally { this.post(); this.host.refresh() }
  }

  /** A thread's passing state for commentsOf: "checking your answer", or why it couldn't be checked. */
  threadStatus(n: Note): { checking?: boolean; error?: string } | undefined {
    const l = linkOf(n)
    if (!l) return undefined
    if (this.grading.has(l.q)) return { checking: true }
    const e = this.gradeErrors.get(n.data.id)
    return e ? { error: e } : undefined
  }
  qidOf(n: Note): string | undefined { return linkOf(n)?.q }

  /** The check as a row of the journeys list (journeyList.ts). */
  listItem(): import('./journeyList').ListItem | undefined {
    const c = this.st?.check, s = this.st?.summary
    if (!c || !s || !this.st) return undefined
    return { key: `check:${this.st.file}`, kind: 'check', title: `Check · ${this.st.branch}`, question: 'Questions about this branch\'s change', summary: '',
      ...(c.createdAt ? { createdAt: c.createdAt } : {}), files: c.questions.map((q) => q.file), stepTitles: c.questions.map((q) => q.text), steps: c.questions.length,
      stale: 0, isNew: false, resume: 0, progress: `${s.passed}/${s.total} ✓`, open: !(s.met && !s.todo && !s.ungraded) }
  }

  /** For the integration test. */
  snapshot() { return { status: this.st && { ...this.st, check: undefined }, item: this.item.text, itemShown: !!this.item.text, view: this.view(), panel: this.panel.state(), grading: [...this.grading.keys()], errors: [...this.gradeErrors.values()] } }
  panelSend(m: unknown): void { this.panel.send(m) }

  dispose(): void { for (const s of this.subs) s.dispose(); this.item.dispose(); this.panel.dispose(); clearTimeout(this.timer) }
}

function gitOut(repo: string, args: string[], allowEmpty = false): Promise<string | undefined> {
  return new Promise((resolve) => execFile('git', args, { cwd: repo, timeout: 5000 }, (err, out) => resolve(err ? undefined : out.trim() || (allowEmpty ? '' : undefined))))
}

/** The check's panel: the questions as rows with their state, one line of progress, one next step. */
class CheckPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined
  private ready = false
  private last: CheckView | undefined
  private queue: unknown[] = []
  /** What the webview reported (integration test): rows drawn, layout problems, errors. */
  private reported: { rows?: number; overflow?: string[]; errors: string[] } = { errors: [] }

  constructor(private extUri: vscode.Uri, private log: vscode.LogOutputChannel, private onMessage: (m: { type: string; id?: string }) => void) {}

  show(v: CheckView): void {
    this.last = v
    if (!this.panel) {
      this.ready = false
      this.panel = vscode.window.createWebviewPanel('codeNotes.check', 'Check', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
        enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.extUri, 'media')],
      })
      this.panel.webview.html = this.html(this.panel.webview)
      this.panel.webview.onDidReceiveMessage((m: { type: string; id?: string; rows?: number; overflow?: string[]; message?: string }) => {
        if (m.type === 'ready') { this.ready = true; this.post(); for (const q of this.queue.splice(0)) void this.panel?.webview.postMessage(q) }
        else if (m.type === 'rendered') this.reported = { ...this.reported, rows: m.rows, overflow: m.overflow }
        else if (m.type === 'error') { this.reported.errors.push(String(m.message)); this.log.error(`check panel: ${m.message}`) }
        this.onMessage(m)
      })
      this.panel.onDidDispose(() => { this.panel = undefined; this.ready = false; this.queue = [] })
    } else this.panel.reveal(this.panel.viewColumn, true)
    this.post()
  }

  update(v: CheckView): void { this.last = v; this.post() }
  private post(): void {
    if (!this.panel || !this.ready || !this.last) return
    this.panel.title = `Check · ${this.last.progress || this.last.branch}`.replace(/ · $/, '')
    void this.panel.webview.postMessage({ type: 'check', view: this.last })
  }
  get column(): vscode.ViewColumn | undefined { return this.panel?.viewColumn }
  send(m: unknown): void { if (this.panel && this.ready) void this.panel.webview.postMessage(m); else this.queue.push(m) }
  state() { return { open: !!this.panel, title: this.panel?.title, ...this.reported } }

  private html(w: vscode.Webview): string {
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('')
    const uri = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'media', f))
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri('check.css')}"></head>
<body><div id="app"><p class="muted">Loading…</p></div><script nonce="${nonce}" src="${uri('check.js')}"></script></body></html>`
  }

  dispose(): void { this.panel?.dispose() }
}
