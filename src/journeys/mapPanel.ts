import * as vscode from 'vscode'
import type { ListKind, ListModel, Sort } from '../core/list/journeyList'
import type { StepCard } from '../tour/card'
import { escapeHtml, webviewPage } from '../webview/page'
import { fileName } from '../platform/jsonFolder'
import { LoadedJourney } from './steps'
import { journeysFolderName } from './journeys'
import { folderName } from '../notes/store'
import { fireAndForget } from '../platform/run'
import { STATE, StateStore } from '../platform/state'

// The journey panel: one journey's map and storyline (or the Journeys list) in a webview beside the editor, and the
// messages between it and media/journey-map.js.

/**
 * What the webview sends: the names media/journey-map.js's header lists under "Out" (journey-map.js, journey-home.js
 * and journey-scene.js post them). JS can't import this type: a name added on one side goes in the other's list too.
 * Two more: `close` and `pick` have handlers (tour/mapMessages.ts) but no page posts them today; `closed` is this panel's own
 * (disposed()).
 *
 * Handled here (MapPanel.receive): ready, rendered, story, error, legend, view, and home with `on`. Every other
 * message is handled in src/tour/mapMessages.ts (MAP_MESSAGES); `tutorial` in src/tour/tutorial.ts.
 */
export type MapMessage =
  // The page itself: drawn, its errors, what it shows (tests read these).
  | { type: 'ready' }
  | { type: 'rendered'; boxes: number }
  | { type: 'story'; steps: number; stops: string[]; cur?: string; overflow: string[]; width: number }
  | { type: 'view'; node: string }
  | { type: 'error'; message?: string; text?: string }
  | { type: 'closed' }

  // Walking a journey: steps, their links and refs, the end.
  | { type: 'step'; n: number }
  | { type: 'end' }
  | { type: 'finish' }
  | { type: 'openPath'; path: string }
  | { type: 'openFile' }
  | { type: 'ref'; i: number }
  | { type: 'details'; open: boolean }
  | { type: 'beat'; n: number; i: number; user?: boolean }
  // The panel's listening player (media/journey-podcast.js; a remote of the Listen view's audio, or the host itself
  // after a ▶ here: src/podcast/player.ts): what it asks of the audio; "Show why" on a podcast with problems
  // (src/core/format/podcast/validate.ts); the end's Walk it yourself / Next journey; a click or key here (its audio may play);
  // as the host, where the audio is.
  | { type: 'podcastAsk'; of?: string; action: string; at?: number; until?: number; to?: number; by?: number; dir?: number; rate?: number; muted?: boolean }
  | { type: 'podcastWhy' }
  | { type: 'podcastEnd'; of?: string; action: 'walk' | 'next' }
  | { type: 'podcastUnlocked' }
  | { type: 'podcastTime'; t: number; playing: boolean; rate?: number; seek?: boolean; of?: string }
  | { type: 'podcastState'; of: string; [k: string]: unknown }
  | { type: 'podcastError'; message: string; of?: string }
  | { type: 'podcastMeta'; duration: number; of?: string }
  | { type: 'ask'; update?: boolean }
  | { type: 'restore' }
  | { type: 'authors' }
  | { type: 'close' }
  | { type: 'pick' }

  // A check's tour: its questions on the storyline.
  | { type: 'question'; id: string }
  | { type: 'checkpoint'; id: string }
  | { type: 'nextStop' }

  // The tutorial.
  | { type: 'tutorial'; action: 'bar' | 'card' | 'skip' | 'done'; card?: number; inside?: boolean; editor?: false | 'card' | 'links' }

  // The Journeys list (the panel's home).
  | { type: 'home'; on?: boolean }
  | { type: 'walk'; key: string }
  | { type: 'list'; query?: string; kind?: ListKind | 'all'; area?: string; sort?: Sort; searchSort?: Sort | 'best' }
  | { type: 'preview'; key: string }
  | { type: 'refresh'; key: string }
  | { type: 'hereAll' }

  // Layout: the legend, the panel's and the map's widths.
  | { type: 'legend'; hidden: boolean }
  | { type: 'panelWidth'; w: number }
  | { type: 'mapWidth'; w: number }

/** A row of the panel's own short journey list (TourInfo.list). */
export interface PanelListRow { key: string; title: string; question: string; steps: number; resume: number; here?: boolean; start?: boolean }

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
  list?: PanelListRow[]
  /** The home's list model (journeyList.ts): sections, rows, chips, with the home's own search. */
  home?: ListModel
  /** The walk was just finished: the panel says Done, the summary, and offers the list. */
  done?: boolean
  /** Files the steps followed through a rename (old -> new path): box paths say where the code went. */
  moved: Record<string, string>
  /** The step card, when it lives in the map ("panel"). */
  card?: ReturnType<StepCard['panelCard']>
  /** One muted line under the question: "Written by AI · 2 days ago · 3 commits behind"; `changed` stale steps. */
  prov?: { text: string; tip: string; changed: number }
  /** Steps someone asked about. */
  asked?: Record<number, { id: string; state: 'q' | 'a'; unread: boolean }>
  /** A check's tour: its questions, each a row after the step that shows its answer; `cur`: the walk is at it. */
  stops?: { id: string; n: number; step: number; text: string; state: string; cur?: boolean }[]
}

export const MAP_VIEW = 'codeNotes.journey'

/**
 * The group a new map opens in: the whole group when there is nothing to read beside it (`alone`); else the one it
 * was last in, unless that now holds the tour's code (`codeCol`); else beside the editor.
 */
function mapColumn(alone: boolean, last: number | undefined, codeCol: vscode.ViewColumn | undefined): vscode.ViewColumn {
  if (alone) return vscode.ViewColumn.Active
  if (last !== undefined && last !== codeCol) return last
  return vscode.ViewColumn.Beside
}

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
  /** The journey's podcast for the panel's bar (src/podcast/player.ts): undefined when it has none. `toUri`: a file
   *  as the webview loads it. */
  podcastFor: ((lj: LoadedJourney, toUri: (u: vscode.Uri) => string) => unknown) | undefined
  /** Where the audio of `lj` is (the panel's player draws it): sent right after the episode. */
  podcastStateFor: ((lj: LoadedJourney) => object | undefined) | undefined
  /** The editor groups may have changed size (the panel drawn, groups opened or closed): tour/panelLayout.ts checks
   *  notes the widths to keep (noteLayout). */
  layoutChanged: (() => void) | undefined
  /** The panel became the active editor: tour/panelLayout.ts undoes VS Code widening it (keepWidthOnFocus). */
  activated: (() => void) | undefined
  /** The panel came on screen, went off it (a tab in front of it, its group hidden) or closed. */
  viewChanged: (() => void) | undefined

  constructor(private extensionUri: vscode.Uri, private log: vscode.LogOutputChannel, private onMessage: (lj: LoadedJourney, m: MapMessage) => void,
    private tourOf: (lj: LoadedJourney) => TourInfo, private stored: StateStore) {}

  get journey(): LoadedJourney | undefined { return this.panel ? this.shown : undefined }
  /** The tab's title (for the integration test). */
  get tabTitle(): string | undefined { return this.panel?.title }
  /** The map is on screen (not a hidden tab). Not while it closes (asked from its own `closed`: VS Code throws then). */
  get visible(): boolean { return !!this.panel && !this.closing && this.panel.visible }
  /** The panel is closing (disposed(): what it tells the extension then must not read the closed panel). */
  private closing = false
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
      const last = this.stored.get(STATE.mapColumn)
      // Nothing to read beside it (the Welcome page, no editor): the map takes the group, not a 480px split.
      const alone = !vscode.window.visibleTextEditors.length && codeCol === undefined
      const col = mapColumn(alone, last, codeCol)
      this.ready = false
      this.adopt(vscode.window.createWebviewPanel(MAP_VIEW, lj.j.title, { viewColumn: col, preserveFocus }, this.options()))
    } else {
      this.panel.reveal(this.panel.viewColumn, preserveFocus)
      if (switched) this.post(true)
    }
    this.panel!.title = this.title()
    this.viewChanged?.()
  }

  private options(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    const roots = [vscode.Uri.joinPath(this.extensionUri, 'media'), vscode.Uri.joinPath(this.extensionUri, 'out', 'src'), vscode.Uri.joinPath(this.extensionUri, 'out', 'vendor')]
    // A podcast's audio: next to its journey, in the journeys folders (and below them).
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      for (const rel of new Set([journeysFolderName(), `${folderName()}/journeys`])) roots.push(vscode.Uri.joinPath(f.uri, rel))
    }
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
    // Drawn first: a panel already closed throws here, and is never taken as the map.
    const paged = this.paged.has(panel)
    if (!paged) panel.webview.html = this.html(panel.webview, this.shown ? `${this.shown.j.question} · Loading…` : undefined)
    if (this.shown) panel.title = this.title()
    this.paged.add(panel)
    this.ready = false
    this.panel = panel
    const remember = () => { if (panel.viewColumn) fireAndForget(this.stored.set(STATE.mapColumn, panel.viewColumn), 'mapPanel: store mapColumn') }
    remember()
    this.subs.push(
      panel.webview.onDidReceiveMessage((m: MapMessage) => this.receive(panel, m)),
      panel.onDidChangeViewState((e) => { remember(); this.viewChanged?.(); if (e.webviewPanel.active) this.activated?.() }),
      panel.onDidDispose(() => this.disposed()),
      vscode.window.tabGroups.onDidChangeTabGroups((e) => { if (e.opened.length || e.closed.length) this.layoutChanged?.() }),
    )
    // A page set before we listened (a restored panel): its 'ready' may have gone already; it answers this with another.
    if (paged) fireAndForget(panel.webview.postMessage({ type: 'hello' }), 'mapPanel: panel.webview.postMessage')
  }

  /** A message from the webview: what the panel keeps itself here; the rest goes to the extension (`onMessage`). */
  private receive(panel: vscode.WebviewPanel, m: MapMessage): void {
    const handled = this.handleOwn(panel, m)
    if (!handled && this.shown) this.onMessage(this.shown, m)
  }

  /** The messages the panel handles itself; false: the extension's (`home` without `on` is the extension's too). */
  private handleOwn(panel: vscode.WebviewPanel, m: MapMessage): boolean {
    switch (m?.type) {
      case 'ready':
        this.onReady(panel)
        return true
      case 'rendered':
        this.rendered = m.boxes
        return true
      case 'story':
        this.story = { steps: m.steps, stops: m.stops, cur: m.cur, overflow: m.overflow, width: m.width }
        return true
      case 'error': // the webview's errors
        this.log.error(`journey map: ${m.text ?? m.message}`)
        return true
      case 'legend':
        fireAndForget(this.stored.set(STATE.legendHidden, m.hidden), 'mapPanel: store legendHidden')
        return true
      case 'view':
        this.focus = m.node
        return true
      case 'home':
        if (m.on === undefined) return false
        this.onHome(panel, m.on)
        return true
      default:
        return false
    }
  }

  private onReady(panel: vscode.WebviewPanel): void {
    this.ready = true
    this.layoutChanged?.()
    this.lastTour = ''
    this.post(true)
    for (const q of this.queue.splice(0)) fireAndForget(panel.webview.postMessage(q), 'mapPanel: panel.webview.postMessage')
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
    this.closing = true
    try {
      if (this.shown) this.onMessage(this.shown, { type: 'closed' })
    } finally { this.closing = false }
    this.panel = undefined
    this.rendered = -1
    this.lastTour = ''
    this.ready = false
    this.queue = []
    for (const s of this.subs) s.dispose()
    this.subs = []
    this.viewChanged?.()
  }

  /** A message for the webview itself (tutorial, tests): sent once it is ready. */
  send(m: unknown): void {
    if (!this.panel) return
    if (this.ready) fireAndForget(this.panel.webview.postMessage(m), 'mapPanel: panel.webview.postMessage')
    else this.queue.push(m)
  }

  close(): void { this.panel?.dispose() }
  /** The keyboard back in the panel. */
  takeFocus(): void { this.panel?.reveal(this.panel.viewColumn, false) }

  /** The journey shown was deleted: the map says so, without Start. */
  markDeleted(key: string): void {
    if (!this.panel || this.shown?.key !== key) return
    this.lastTour = ''
    this.send({ type: 'deleted', file: fileName(this.shown.uri) })
  }

  /** The journey file changed (or another one is shown): send it all again; otherwise only the tour position. */
  update(lj?: LoadedJourney): void {
    if (!this.panel || !this.shown) return
    if (lj && lj.key === this.shown.key) {
      this.shown = lj
      this.panel.title = this.title()
      this.post(true)
      return
    }
    this.post(false)
  }

  private post(all: boolean): void {
    if (!this.panel || !this.shown) return
    const t = this.tourOf(this.shown)
    const sig = JSON.stringify(t)
    if (!all && sig === this.lastTour) return
    this.lastTour = sig
    fireAndForget(this.panel.webview.postMessage(all ? { type: 'journey', journey: this.shown.j, ...t } : { type: 'tour', ...t }), 'mapPanel: panel.webview.postMessage')
    if (all) this.sendPodcast()
  }

  /** The shown journey's podcast to the bar (none: the bar goes). */
  sendPodcast(): void {
    const panel = this.panel
    if (!panel || !this.shown || !this.ready) return
    const episode = this.podcastFor?.(this.shown, (u) => panel.webview.asWebviewUri(u).toString())
    fireAndForget(panel.webview.postMessage({ type: 'podcast', episode }), 'mapPanel: panel.webview.postMessage')
    const st = episode ? this.podcastStateFor?.(this.shown) : undefined
    if (st) fireAndForget(panel.webview.postMessage({ type: 'podcastState', ...st }), 'mapPanel: panel.webview.postMessage')
  }

  private html(w: vscode.Webview, loading?: string): string {
    const file = (...p: string[]) => vscode.Uri.joinPath(this.extensionUri, ...p)
    return webviewPage(w, {
      css: [file('media', 'common.css'), file('media', 'journey-map.css'), file('media', 'journey-home.css'), file('media', 'journey-scene.css'), file('media', 'journey-podcast.css')],
      body: `<div id="app"><p class="loading">${loading ? escapeHtml(loading) : 'Loading the map…'}</p></div>`,
      // In this order: each of media/ needs the ones before it (its header says which).
      scripts: [
        file('out', 'vendor', 'elk.bundled.js'),
        ...[
          'common', 'journey-layout', 'journey-farnames', 'journey-graph', 'code-paint', 'journey-scene', 'journey-scene-app',
          'journey-home', 'journey-splitter', 'journey-tutorial', 'journey-podcast', 'journey-map',
        ].map((name) => file('media', `${name}.js`)),
      ],
      allow: { media: true },
    })
  }

  dispose(): void { this.panel?.dispose() }
}

