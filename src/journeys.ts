import * as vscode from 'vscode'
import { Journey, parseJourney } from './journeyModel'
import { anchor, staleKind } from './anchor'
import { AnyAnchor, Found, compactOf, findCompact, isCompact, toCompact } from './compact'
import { folderName, journeysFolderName, notesDir } from './store'
import { gitRenames } from './gitRenames'

// Journeys (format v2, docs/journey-format.md): <repo>/journeys/<slug>.json (codeNotes.journeys.folder: committed,
// shared) and, as before, <notes folder>/journeys/<slug>.json (personal); steps embedded. A step is not a note. Its lines are found again in memory (anchor.ts) as the code changes; the journey file is never written.

/**
 * Where a step's code is now: 1-based lines; `stale`: its code can't be found (changed, deleted, or the file is gone);
 * `file`: where the file went when it was renamed; unset: the step's own `file`.
 */
export interface StepAt { start: number; end: number; stale: boolean; file?: string
  /** Stale: its code is gone from here (`removed`, the card goes to the top of the file, nothing is lit), or it
   *  was edited (`was` → `now`, a diff on the card like a stale note's:). */
  removed?: boolean; was?: string; now?: string }
/** The file a step's code is in now. */
export const fileOf = (lj: LoadedJourney, n: number) => lj.at[n - 1]?.file ?? lj.j.steps[n - 1].file
/** `readError`: the file on disk can't be read now; this is the last good version. */
export interface LoadedJourney { key: string; folder: vscode.WorkspaceFolder; uri: vscode.Uri; j: Journey; at: StepAt[]; readError?: string }

const decoder = new TextDecoder()
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const RENAMED_KEY = 'codeNotes.journeyRenames'
const CONTEXT_LINES = 2

/** A journey's identity across reloads and file renames within a folder: folder + id. */
export const posKey = (lj: LoadedJourney) => `${lj.folder.uri.toString()}|${lj.j.id}`

export class Journeys implements vscode.Disposable {
  /** By journey file URI. */
  readonly list = new Map<string, LoadedJourney>()
  private readonly changed = new vscode.EventEmitter<void>()
  readonly onDidChange = this.changed.event
  /** Steps moved or went stale (no journey file changed). */
  private readonly moved = new vscode.EventEmitter<LoadedJourney>()
  readonly onDidMoveSteps = this.moved.event
  private watchers: vscode.Disposable[] = []
  private pending = new Map<string, ReturnType<typeof setTimeout>>()
  /** Anchors taken from the code for steps written without one (in memory only). */
  private captured = new Map<string, AnyAnchor>()

  /** The last readable text of each journey file (by URI): Restore after a delete. */
  readonly lastGood = new Map<string, string>()
  /** Journey files that were never readable, by URI: a dimmed row in the list says why. */
  readonly invalid = new Map<string, { folder: vscode.WorkspaceFolder; uri: vscode.Uri; why: string }>()

  constructor(private log: vscode.LogOutputChannel, private state?: vscode.Memento) {}

  /** Files steps followed through a rename, kept across reloads (the journey file is never written): key -> new path. */
  private renamed(): Record<string, string> { return this.state?.get<Record<string, string>>(RENAMED_KEY) ?? {} }
  /** Per file, not per journey or step: every journey with a step in that file follows the same rename. */
  private renameKey(lj: LoadedJourney, n: number): string { return `${lj.folder.uri.toString()}|${lj.j.steps[n - 1].file}` }

  /** Renames git knows (as `journey.py check` finds them: committed since the journey's commit, staged, uncommitted), cached briefly. */
  private gitCache = new Map<string, { at: number; map: Promise<Map<string, string>> }>()
  gitRenames(folder: vscode.WorkspaceFolder, since?: string): Promise<Map<string, string>> {
    const k = `${folder.uri.toString()}|${since ?? ''}`
    const c = this.gitCache.get(k)
    if (c && Date.now() - c.at < 3000) return c.map
    const map = gitRenames(folder.uri.fsPath, since)
    this.gitCache.set(k, { at: Date.now(), map })
    return map
  }
  /** Where git says `file` went (following a chain of renames); undefined: no rename known. */
  private async renamedByGit(lj: LoadedJourney, file: string): Promise<string | undefined> {
    const m = await this.gitRenames(lj.folder, lj.j.commit)
    let f = file
    const seen = new Set([f])
    while (m.has(f)) { f = m.get(f)!; if (seen.has(f)) break; seen.add(f) }
    return f !== file ? f : undefined
  }

  all(): LoadedJourney[] { return [...this.list.values()].sort((a, b) => a.j.title.localeCompare(b.j.title)) }
  byPos(key: string | undefined): LoadedJourney | undefined { return key ? this.all().find((x) => posKey(x) === key) : undefined }

  async load(): Promise<void> {
    this.list.clear()
    this.invalid.clear()
    for (const w of this.watchers) w.dispose()
    this.watchers = []
    const old: string[] = []
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      // The repo's journeys first: a personal copy with the same id (the old place) is not listed twice.
      const dirs = [...new Set([journeysFolderName(), `${folderName()}/journeys`])]
      for (const rel of dirs) {
        const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, `${rel}/*.json`))
        const reread = (u: vscode.Uri) => this.read(folder, u).then((v1) => { if (v1) this.logOld([v1]); this.changed.fire() }, (e) => this.log.error(`journey ${u.fsPath}: ${e}`))
        w.onDidCreate(reread)
        w.onDidChange(reread)
        w.onDidDelete((u) => { const a = this.list.delete(u.toString()), b = this.invalid.delete(u.toString()); if (a || b) this.changed.fire() })
        // The journeys folder (or the notes folder) moved or deleted as a whole: no event per file comes.
        const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
        const d = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, parent ? `{${parent},${rel}}` : rel), true, true, false)
        d.onDidDelete(() => void this.prune())
        this.watchers.push(w, d)
      }
      for (const rel of dirs) {
        const dir = vscode.Uri.joinPath(folder.uri, rel)
        let entries: [string, vscode.FileType][] = []
        try { entries = await vscode.workspace.fs.readDirectory(dir) } catch { continue }
        for (const [name, type] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
          if (type !== vscode.FileType.File || !name.endsWith('.json')) continue
          const v1 = await this.read(folder, vscode.Uri.joinPath(dir, name))
          if (v1) old.push(v1)
        }
      }
    }
    this.logOld(old)
    this.changed.fire()
  }

  /** Drops journeys whose files are gone (moved away with their folder:). */
  private async prune(): Promise<void> {
    let gone = false
    for (const m of [this.list, this.invalid] as Map<string, { uri: vscode.Uri }>[]) for (const [k, x] of [...m]) {
      try { await vscode.workspace.fs.stat(x.uri) } catch { m.delete(k); gone = true }
    }
    if (gone) this.changed.fire()
  }

  private logOld(names: string[]): void {
    if (names.length) this.log.info(`journeys in the old format (v1, steps as notes) not shown: ${names.join(', ')}; migrate them to v2`)
  }

  /** Reads one journey file; returns its name when it is in the old format (logged by the caller, once). */
  private async read(folder: vscode.WorkspaceFolder, uri: vscode.Uri): Promise<string | undefined> {
    let raw: string
    try { raw = decoder.decode(await vscode.workspace.fs.readFile(uri)) } catch { this.list.delete(uri.toString()); this.invalid.delete(uri.toString()); return undefined }
    const name = uri.path.split('/').pop()!.replace(/\.json$/, '')
    const j = parseJourney(raw, name)
    if (typeof j !== 'string') { this.lastGood.set(uri.toString(), raw); this.invalid.delete(uri.toString()) }
    if (typeof j === 'string') {
      const prev = this.list.get(uri.toString())
      // Never readable: one dimmed row in the list says so; the parser's words are its tooltip.
      if (!prev) this.invalid.set(uri.toString(), { folder, uri, why: j.startsWith('format v') ? 'Old format (v1): migrate it with journey.py migrate.' : `Can't read it: ${j}.` })
      if (j.startsWith('format v')) { this.list.delete(uri.toString()); return name }
      // Half-written, most likely: keep the last good version, and say so on the map.
      this.log.warn(`journey ${uri.fsPath}: skipped: ${j}`)
      // One plain line for readers; the parser's words are in the Output panel.
      if (prev) prev.readError = "Can't read this journey's file; showing its last good version."
      return undefined
    }
    // The same journey in the repo's folder and in the notes folder (copied, or not yet moved): the repo's one wins.
    const legacy = this.isLegacy(folder, uri)
    const twin = [...this.list.values()].find((x) => x.key !== uri.toString() && x.folder.uri.toString() === folder.uri.toString() && x.j.id === j.id)
    if (twin) {
      if (legacy && !this.isLegacy(folder, twin.uri)) { this.log.info(`journey ${j.id}: ${uri.fsPath} not listed: ${twin.uri.fsPath} has the same id`); this.list.delete(uri.toString()); return undefined }
      if (!legacy && this.isLegacy(folder, twin.uri)) { this.log.info(`journey ${j.id}: ${twin.uri.fsPath} not listed: ${uri.fsPath} has the same id`); this.list.delete(twin.key) }
    }
    const prev = this.list.get(uri.toString())
    const lj: LoadedJourney = { key: uri.toString(), folder, uri, j, at: j.steps.map((s) => ({ ...s.range, stale: false })) }
    // The same steps as before (an unrelated edit to the file): keep where they were found.
    if (prev) j.steps.forEach((s, i) => {
      const k = prev.j.steps.findIndex((p) => p.id === s.id)
      const p = prev.j.steps[k]
      if (p && p.file === s.file && p.range.start === s.range.start && JSON.stringify(p.anchor) === JSON.stringify(s.anchor)) lj.at[i] = prev.at[k]
    })
    // Steps that followed a renamed file before a reload: still there.
    const ren = this.renamed()
    j.steps.forEach((s, i) => { const f = ren[this.renameKey(lj, i + 1)]; if (f && !lj.at[i].file && f !== s.file) lj.at[i] = { ...lj.at[i], file: f } })
    this.list.set(uri.toString(), lj)
    await this.locate(lj)
    return undefined
  }

  /** A journey file in the notes folder (the old place), not the repo's journeys folder. */
  private isLegacy(folder: vscode.WorkspaceFolder, uri: vscode.Uri): boolean {
    const repo = vscode.Uri.joinPath(folder.uri, journeysFolderName()).path.replace(/\/?$/, '/')
    return !uri.path.startsWith(repo)
  }

  /** The file's lines now: an open editor (unsaved edits count), else the disk. */
  private async lines(uri: vscode.Uri): Promise<string[] | undefined> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString() && !d.isClosed)
    if (open) return Array.from({ length: open.lineCount }, (_, i) => open.lineAt(i).text)
    try { return decoder.decode(await vscode.workspace.fs.readFile(uri)).split(/\r?\n/) } catch { return undefined }
  }

  /** Finds the steps' code again (all of them, or some). True if any moved or changed staleness. */
  async locate(lj: LoadedJourney, only?: (n: number) => boolean, given?: { file: string; lines: string[] }): Promise<boolean> {
    let changed = false
    const cache = new Map<string, string[] | undefined>()
    for (const s of lj.j.steps) {
      if (only && !only(s.n)) continue
      const was = lj.at[s.n - 1]
      const file = was.file ?? s.file
      let lines = given && given.file === file ? given.lines : cache.get(file)
      if (!lines && !cache.has(file)) { lines = await this.lines(vscode.Uri.joinPath(lj.folder.uri, file)); cache.set(file, lines) }
      // The file is gone: git may know where it went (`git mv`), for every journey alike.
      let gitFile: string | undefined
      if (!lines && (gitFile = await this.renamedByGit(lj, file))) {
        const ls = await this.lines(vscode.Uri.joinPath(lj.folder.uri, gitFile))
        if (ls) { lines = ls; cache.set(gitFile, ls); this.log.info(`journey ${lj.j.id} step ${s.n}: ${file} was renamed to ${gitFile} (git)`) } else gitFile = undefined
      }
      let now: StepAt
      if (!lines) now = { ...was, stale: true }
      else {
        const ck = `${lj.key}|${s.id}|${s.file}:${s.range.start}`
        let a: AnyAnchor | undefined = s.anchor ?? this.captured.get(ck)
        if (!a || (!isCompact(a) && !a.text && !a.before && !a.after)) {
          // Written without an anchor: take it from the code at its range, once, in memory (compact; a step on blank
          // lines keeps the lines around it).
          const st = Math.max(0, Math.min(s.range.start, lines.length) - 1), en = Math.max(st, Math.min(s.range.end, lines.length) - 1)
          a = compactOf(lines, st, en) ?? { text: lines.slice(st, en + 1).join('\n'), before: lines.slice(Math.max(0, st - CONTEXT_LINES), st).join('\n'), after: lines.slice(en + 1, en + 1 + CONTEXT_LINES).join('\n') }
          this.captured.set(ck, a)
        }
        const nf = gitFile ?? was.file
        const fileField = nf && nf !== s.file ? { file: nf } : {}
        const c = toCompact(a)
        if (c) {
          // v3 (or v2 read as v3): fresh, changed (shown at its new place), or gone (nothing lit, card in the map).
          const f = findCompact(lines, c, was.start - 1)
          if (f.state === 'gone') {
            const last = Math.max(1, lines.length)
            const start = Math.min(Math.max(1, was.start), last)
            now = { start, end: Math.min(Math.max(start, was.end), last), stale: true, removed: true, ...fileField }
          } else {
            now = { start: f.loc.start + 1, end: f.loc.end + 1, stale: f.state === 'changed', ...fileField }
            if (f.state === 'changed') Object.assign(now, { was: isCompact(a) ? '' : a.text, now: lines.slice(f.loc.start, f.loc.end + 1).join('\n') })
          }
        } else {
          // A v2 step on blank lines: only its context to go by (anchor.ts).
          const v2 = a as { text: string; before: string; after: string }
          const r = anchor(lines, v2.text, v2.before, v2.after, { start: was.start - 1, end: was.end - 1 })
          now = { start: r.loc.start + 1, end: r.loc.end + 1, stale: r.stale, ...fileField }
          if (r.stale) Object.assign(now, staleKind(lines, v2, r.loc))
          // It may stay where it is, never move to look-alike code.
          if (!r.stale && r.loc.start !== was.start - 1) now = { ...was, stale: true }
        }
      }
      if (now.start !== was.start || now.end !== was.end || now.stale !== was.stale || now.removed !== was.removed || now.now !== was.now || now.file !== was.file) {
        if (now.stale !== was.stale) this.log.info(`journey ${lj.j.id} step ${s.n}: ${now.stale ? 'stale (its code changed or is gone)' : 'found again'} · ${file}`)
        lj.at[s.n - 1] = now
        changed = true
      }
    }
    return changed
  }

  /** What the step's code looked like: from the journey file, or taken from the code when the file had none. */
  anchorOf(lj: LoadedJourney, n: number): AnyAnchor | undefined {
    const s = lj.j.steps[n - 1]
    return s.anchor ?? this.captured.get(`${lj.key}|${s.id}|${s.file}:${s.range.start}`)
  }

  /** Where step `n`'s code is in `lines` (another file's, e.g. one just created): fresh, changed or gone. */
  findIn(lj: LoadedJourney, n: number, lines: string[]): Found {
    const a = this.anchorOf(lj, n)
    const c = a && toCompact(a)
    return c ? findCompact(lines, c, lj.at[n - 1].start - 1) : { state: 'gone' }
  }

  /** The step's code is in another file now (renamed): follow it, in memory. */
  async moveStep(lj: LoadedJourney, n: number, file: string): Promise<void> {
    lj.at[n - 1] = { ...lj.at[n - 1], file: file === lj.j.steps[n - 1].file ? undefined : file }
    if (lj.at[n - 1].file === undefined) delete lj.at[n - 1].file
    this.log.info(`journey ${lj.j.id} step ${n}: its file moved to ${file}`)
    const ren = { ...this.renamed() }
    if (lj.at[n - 1].file) ren[this.renameKey(lj, n)] = file; else delete ren[this.renameKey(lj, n)]
    await this.state?.update(RENAMED_KEY, ren)
    await this.locate(lj, (k) => k === n)
    this.moved.fire(lj)
  }

  /** Renamed files (old -> new path) the journey's steps followed: refs to the old path say where it went. */
  renames(lj: LoadedJourney): Map<string, string> {
    const out = new Map<string, string>()
    lj.j.steps.forEach((s, i) => { const f = lj.at[i].file; if (f) out.set(s.file, f) })
    return out
  }

  /** An edited document: re-find the steps in it, a moment after typing stops. */
  onDocument(doc: vscode.TextDocument): void {
    for (const lj of this.list.values()) {
      const base = lj.folder.uri.path.replace(/\/?$/, '/')
      if (doc.uri.scheme !== 'file' || !doc.uri.path.startsWith(base)) continue
      const rel = doc.uri.path.slice(base.length)
      if (!lj.j.steps.some((s) => fileOf(lj, s.n) === rel)) continue
      const k = `${lj.key}|${rel}`
      clearTimeout(this.pending.get(k))
      this.pending.set(k, setTimeout(() => {
        this.pending.delete(k)
        if (this.list.get(lj.key) !== lj) return
        const lines = Array.from({ length: doc.lineCount }, (_, i) => doc.lineAt(i).text)
        void this.locate(lj, (n) => fileOf(lj, n) === rel, { file: rel, lines }).then((c) => { if (c) this.moved.fire(lj) })
      }, 250))
    }
  }

  dispose(): void {
    for (const w of this.watchers) w.dispose()
    for (const t of this.pending.values()) clearTimeout(t)
    this.changed.dispose()
    this.moved.dispose()
  }
}

export type MapMessage = { type: 'ready' } | { type: 'openPath'; path: string } | { type: 'end' } | { type: 'step'; n: number } | { type: 'view'; node: string } | { type: 'rendered'; boxes: number }
  | { type: 'error'; message?: string; text?: string } | { type: 'legend'; hidden: boolean } | { type: 'tutorial'; action: 'bar' | 'card' | 'skip' | 'done'; card?: number; inside?: boolean; editor?: false | 'card' | 'links' }
  | { type: 'ref'; i: number } | { type: 'ask'; update?: boolean } | { type: 'details'; open: boolean } | { type: 'authors' }
  | { type: 'restore' } | { type: 'close' } | { type: 'openFile' } | { type: 'pick' } | { type: 'finish' } | { type: 'question'; id: string }
  | { type: 'home'; on?: boolean } | { type: 'walk'; key: string } | { type: 'mapWidth'; w: number } | { type: 'beat'; n: number; i: number } | { type: 'closed' }
/** What the map needs about the tour: the step shown (0: none), stale steps, where it was left (to resume), the legend. */
export interface TourInfo {
  current: number; marks: Record<number, string>; resume: number; legendHidden: boolean; problems: string[]
  /** The map column's width in a wide panel, dragged by the reader (0.21.1); unset: the default. */
  mapWidth?: number
  /** Rule breaks only an author can fix: a count and a link to the Output channel, not shown to readers. */
  authors?: number
  /** The chord prefix to show in hints; offer the tutorial bar. */
  key: string; tutorial: boolean
  /** Every journey, for the panel's home list (0.21): title, steps, where it was left. */
  list?: { key: string; title: string; question: string; steps: number; resume: number; here?: boolean; start?: boolean }[]
  /** The walk was just finished: the panel says Done, the summary, and offers the list. */
  done?: boolean
  /** Files the steps followed through a rename (old -> new path): box paths say where the code went. */
  moved: Record<string, string>
  /** The step card, when it lives in the map ("panel"). */
  card?: object
  /** One muted line under the question: "Written by AI · 2 days ago · 3 commits behind"; `changed` stale steps. */
  prov?: { text: string; tip: string; changed: number }
  /** Steps someone asked about. */
  asked?: Record<number, { id: string; state: 'q' | 'a'; unread: boolean }>
}

export const MAP_VIEW = 'codeNotes.journey'

/** The map of one journey at a time, in a webview beside the editor. */
export class MapPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined
  private shown: LoadedJourney | undefined
  private lastTour = ''
  private subs: vscode.Disposable[] = []
  /** Boxes in the last render (for the integration test: the webview really draws). */
  rendered = -1
  /** The box the map last centred on ('': the whole map), as the webview reported it (for the integration test). */
  focus = ''
  private ready = false
  private queue: unknown[] = []

  constructor(private extensionUri: vscode.Uri, private log: vscode.LogOutputChannel, private onMessage: (lj: LoadedJourney, m: MapMessage) => void,
    private tourOf: (lj: LoadedJourney) => TourInfo, private state: vscode.Memento) {}

  get journey(): LoadedJourney | undefined { return this.panel ? this.shown : undefined }
  /** The tab's title (for the integration test). */
  get tabTitle(): string | undefined { return this.panel?.title }
  /** The map is on screen (not a hidden tab). */
  get visible(): boolean { return !!this.panel?.visible }
  /** The map's group, while it is open (visible or not). */
  get viewColumn(): vscode.ViewColumn | undefined { return this.panel?.viewColumn }

  /** The Journeys list is shown in place of the journey (the tab says "Journeys"). */
  private home = false
  private title(): string { return this.home ? 'Journeys' : this.shown?.j.title ?? 'Journeys' }

  /** The panel with its Journeys list (a request without a question); `lj` is the journey behind it. */
  private homeAsked = false
  showHome(lj: LoadedJourney): void {
    this.show(lj)
    this.home = true
    this.homeAsked = true
    this.panel!.title = this.title()
    this.send({ type: 'home' })
  }

  show(lj: LoadedJourney, preserveFocus = false, codeCol?: vscode.ViewColumn): void {
    const switched = this.shown?.key !== lj.key
    this.home = false
    this.shown = lj
    if (!this.panel) {
      // The map keeps its side: the group it was last in, else beside the editor; never among the tour's code
      // (closing it merged the groups, so that group now holds the code).
      const last = this.state.get<number>('codeNotes.mapColumn')
      // Nothing to read beside it (the Welcome page, no editor): the map takes the group, not a 480px split.
      const alone = !vscode.window.visibleTextEditors.length && codeCol === undefined
      const col = alone ? vscode.ViewColumn.Active : last !== undefined && last !== codeCol ? last : vscode.ViewColumn.Beside
      this.ready = false
      this.adopt(vscode.window.createWebviewPanel(MAP_VIEW, lj.j.title, { viewColumn: col, preserveFocus }, this.options()))
    } else {
      this.panel.reveal(this.panel.viewColumn, preserveFocus)
      if (switched) this.post(true)
    }
    this.panel!.title = this.title()
  }

  private options(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    const roots = [vscode.Uri.joinPath(this.extensionUri, 'media'), vscode.Uri.joinPath(this.extensionUri, 'out', 'src'), vscode.Uri.joinPath(this.extensionUri, 'out', 'vendor')]
    // Ctrl+F finds words in the map and the storyline.
    return { enableScripts: true, enableFindWidget: true, localResourceRoots: roots, retainContextWhenHidden: true }
  }

  /** Panels whose page is set: the HTML is set once per panel (setting it again while it loads made VS Code's
   * own webview host read a null body, "reading 'classList'"); everything after goes by postMessage. */
  private paged = new WeakSet<vscode.WebviewPanel>()

  /** A restored panel before the journeys are read: the question and the step it was on, not a blank page. */
  placeholder(panel: vscode.WebviewPanel, st: { q?: string; cur?: number; n?: number } | undefined): void {
    panel.webview.options = this.options()
    panel.webview.html = this.html(panel.webview, st?.q ? `${st.q} · ${st.cur ? `Restoring step ${st.cur}/${st.n}…` : 'Loading…'}` : undefined)
    this.paged.add(panel)
  }

  /** A panel to draw in: a new one, or one VS Code restored after a reload. */
  adopt(panel: vscode.WebviewPanel, lj?: LoadedJourney): void {
    if (lj) this.shown = lj
    this.ready = false
    this.panel = panel
    const paged = this.paged.has(panel)
    if (!paged) {
      panel.webview.html = this.html(panel.webview, this.shown ? `${this.shown.j.question} · Loading…` : undefined)
      this.paged.add(panel)
    }
    if (this.shown) panel.title = this.title()
    const remember = () => { if (panel.viewColumn) void this.state.update('codeNotes.mapColumn', panel.viewColumn) }
    remember()
    this.subs.push(panel.webview.onDidReceiveMessage((m: MapMessage) => {
      if (m?.type === 'ready') {
        this.ready = true
        this.lastTour = ''
        this.post(true)
        for (const q of this.queue.splice(0)) void panel.webview.postMessage(q)
      }
      else if (m?.type === 'rendered') this.rendered = m.boxes
      else if (m?.type === 'error') this.log.error(`journey map: ${m.text ?? m.message}`) // the webview's errors
      else if (m?.type === 'legend') void this.state.update('codeNotes.legendHidden', m.hidden)
      // Only the reader's own click on "‹ Journeys" ends the walk (the list the extension opens does not).
      else if (m?.type === 'home' && m.on !== undefined) { this.home = m.on; panel.title = this.title(); if (m.on && this.shown && !this.homeAsked) this.onMessage(this.shown, m); this.homeAsked = false }
      else {
        if (m?.type === 'view') this.focus = m.node
        else if (this.shown) this.onMessage(this.shown, m)
      }
    }), panel.onDidChangeViewState(remember), panel.onDidDispose(() => {
      // The panel closed mid-animation: its beat's line is no longer lit.
      if (this.shown) this.onMessage(this.shown, { type: 'closed' })
      this.panel = undefined; this.rendered = -1; this.lastTour = ''; this.ready = false; this.queue = []
      for (const s of this.subs) s.dispose()
      this.subs = []
    }))
    // A page set before we listened (a restored panel): its 'ready' may have gone already; it answers this with another.
    if (paged) void panel.webview.postMessage({ type: 'hello' })
  }

  /** A message for the webview itself (tutorial, tests): sent once it is ready. */
  send(m: unknown): void {
    if (!this.panel) return
    if (this.ready) void this.panel.webview.postMessage(m)
    else this.queue.push(m)
  }

  close(): void { this.panel?.dispose() }
  /** The keyboard back in the panel. */
  takeFocus(): void { this.panel?.reveal(this.panel.viewColumn, false) }

  /** The journey shown was deleted: the map says so, without Start. */
  markDeleted(key: string): void {
    if (!this.panel || this.shown?.key !== key) return
    this.lastTour = ''
    this.send({ type: 'deleted', file: this.shown.uri.path.split('/').pop() })
  }

  /** The journey file changed (or another one is shown): send it all again; otherwise only the tour position. */
  update(lj?: LoadedJourney): void {
    if (!this.panel || !this.shown) return
    if (lj && lj.key === this.shown.key) { this.shown = lj; this.panel.title = this.title(); this.post(true); return }
    this.post(false)
  }

  private post(all: boolean): void {
    if (!this.panel || !this.shown) return
    const t = this.tourOf(this.shown)
    const sig = JSON.stringify(t)
    if (!all && sig === this.lastTour) return
    this.lastTour = sig
    void this.panel.webview.postMessage(all ? { type: 'journey', journey: this.shown.j, ...t } : { type: 'tour', ...t })
  }

  private html(w: vscode.Webview, loading?: string): string {
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('')
    const uri = (...p: string[]) => w.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...p))
    return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; font-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri('media', 'journey-map.css')}">
<link rel="stylesheet" href="${uri('media', 'journey-scene.css')}">
</head><body><div id="app"><p class="loading">${loading ? esc(loading) : 'Loading the map…'}</p></div>
<script nonce="${nonce}">var exports = {}</script>
<script nonce="${nonce}" src="${uri('out', 'src', 'journeyModel.js')}"></script>
<script nonce="${nonce}" src="${uri('out', 'vendor', 'elk.bundled.js')}"></script>
<script nonce="${nonce}" src="${uri('media', 'journey-graph.js')}"></script>
<script nonce="${nonce}" src="${uri('media', 'journey-scene.js')}"></script>
<script nonce="${nonce}" src="${uri('media', 'journey-map.js')}"></script></body></html>`
  }

  dispose(): void { this.panel?.dispose() }
}

