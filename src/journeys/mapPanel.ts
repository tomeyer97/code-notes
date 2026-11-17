import * as vscode from 'vscode'
import type { ListKind, Sort } from '../journeyList'
import { escapeHtml, webviewPage } from '../webview/page'
import { LoadedJourney } from './steps'

// The journey panel: one journey's map and storyline (or the Journeys list) in a webview beside the editor, and the
// messages between it and media/journey-map.js.

/** What the webview (media/journey-map.js) sends. */
export type MapMessage =
  | { type: 'ready' }
  | { type: 'openPath'; path: string }
  | { type: 'end' }
  | { type: 'step'; n: number }
  | { type: 'view'; node: string }
  | { type: 'rendered'; boxes: number }
  | { type: 'error'; message?: string; text?: string }
  | { type: 'legend'; hidden: boolean }
  | { type: 'tutorial'; action: 'bar' | 'card' | 'skip' | 'done'; card?: number; inside?: boolean; editor?: false | 'card' | 'links' }
  | { type: 'ref'; i: number }
  | { type: 'ask'; update?: boolean }
  | { type: 'details'; open: boolean }
  | { type: 'authors' }
  | { type: 'restore' }
  | { type: 'close' }
  | { type: 'openFile' }
  | { type: 'pick' }
  | { type: 'finish' }
  | { type: 'question'; id: string }
  | { type: 'checkpoint'; id: string }
  | { type: 'nextStop' }
  | { type: 'story'; steps: number; stops: string[]; cur?: string; overflow: string[]; width: number }
  | { type: 'home'; on?: boolean }
  | { type: 'walk'; key: string }
  | { type: 'list'; query?: string; kind?: ListKind | 'all'; area?: string; sort?: Sort; searchSort?: Sort | 'best' }
  | { type: 'preview'; key: string }
  | { type: 'refresh'; key: string }
  | { type: 'hereAll' }
  | { type: 'panelWidth'; w: number }
  | { type: 'mapWidth'; w: number }
  | { type: 'beat'; n: number; i: number }
  | { type: 'closed' }

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
  /** The home's list model (journeyList.ts): sections, rows, chips, with the home's own search. */
  home?: object
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
  /** A check's tour: its questions, each a row after the step that shows its answer; `cur`: the walk is at it. */
  stops?: { id: string; n: number; step: number; text: string; state: string; cur?: boolean }[]
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
  /** The storyline as drawn last (integration test): step rows, question rows, the current question, what is cut. */
  story: { steps: number; stops: string[]; cur?: string; overflow: string[]; width: number } | undefined
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
    this.subs.push(
      panel.webview.onDidReceiveMessage((m: MapMessage) => this.receive(panel, m)),
      panel.onDidChangeViewState(remember),
      panel.onDidDispose(() => this.disposed()),
    )
    // A page set before we listened (a restored panel): its 'ready' may have gone already; it answers this with another.
    if (paged) void panel.webview.postMessage({ type: 'hello' })
  }

  /** A message from the webview: what the panel keeps itself here; the rest goes to the extension (`onMessage`). */
  private receive(panel: vscode.WebviewPanel, m: MapMessage): void {
    switch (m?.type) {
      case 'ready': this.onReady(panel); return
      case 'rendered': this.rendered = m.boxes; return
      case 'story': this.story = { steps: m.steps, stops: m.stops, cur: m.cur, overflow: m.overflow, width: m.width }; return
      case 'error': this.log.error(`journey map: ${m.text ?? m.message}`); return // the webview's errors
      case 'legend': void this.state.update('codeNotes.legendHidden', m.hidden); return
      case 'view': this.focus = m.node; return
      case 'home': if (m.on !== undefined) { this.onHome(panel, m.on); return } break
    }
    if (this.shown) this.onMessage(this.shown, m)
  }

  private onReady(panel: vscode.WebviewPanel): void {
    this.ready = true
    this.lastTour = ''
    this.post(true)
    for (const q of this.queue.splice(0)) void panel.webview.postMessage(q)
  }

  /** The list shown or left. Only the reader's own click on "‹ Journeys" ends the walk (the list the extension opens does not). */
  private onHome(panel: vscode.WebviewPanel, on: boolean): void {
    this.home = on
    panel.title = this.title()
    if (on && this.shown && !this.homeAsked) this.onMessage(this.shown, { type: 'home', on })
    this.homeAsked = false
  }

  private disposed(): void {
    // The panel closed mid-animation: its beat's line is no longer lit.
    if (this.shown) this.onMessage(this.shown, { type: 'closed' })
    this.panel = undefined; this.rendered = -1; this.lastTour = ''; this.ready = false; this.queue = []
    for (const s of this.subs) s.dispose()
    this.subs = []
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
    const file = (...p: string[]) => vscode.Uri.joinPath(this.extensionUri, ...p)
    return webviewPage(w, {
      css: [file('media', 'common.css'), file('media', 'journey-map.css'), file('media', 'journey-scene.css')],
      body: `<div id="app"><p class="loading">${loading ? escapeHtml(loading) : 'Loading the map…'}</p></div>`,
      // journeyModel.js is a CommonJS module loaded as a plain script.
      inline: 'var exports = {}',
      scripts: [
        file('out', 'src', 'journeyModel.js'), file('out', 'vendor', 'elk.bundled.js'), file('media', 'common.js'), file('media', 'journey-layout.js'),
        file('media', 'journey-graph.js'), file('media', 'journey-scene.js'), file('media', 'journey-home.js'), file('media', 'journey-map.js'),
      ],
    })
  }

  dispose(): void { this.panel?.dispose() }
}

