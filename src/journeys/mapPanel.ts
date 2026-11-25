import * as vscode from 'vscode'
import type { FromMap, ToMap, TourInfo } from '../protocol/map'
import type { PodcastEpisode, PodcastHostState, PodcastUnavailable } from '../protocol/podcast'
import { PAGES_DIR, pageScript, webviewPage } from '../webview/page'
import { escapeHtml } from '../core/escape'
import { WebviewChannel } from '../webview/channel'
import { fileName } from '../platform/jsonFolder'
import { LoadedJourney } from './steps'
import { journeysFolderName } from './journeys'
import { folderName } from '../notes/notesFolder'
import { fireAndForget } from '../platform/run'
import { STATE, StateStore } from '../platform/state'

// The journey panel: one journey's map and storyline (or the Journeys list) in a webview beside the editor. Its
// messages both ways are src/protocol/map.ts; the panel keeps its own (ready, rendered, …) and gives the rest to its
// controller (`onMessage`: panel/controller.ts, where each feature registers its handlers).

/** What the podcast player gives the panel (src/podcast/player.ts registers it: MapPanel.setPodcast). */
export interface PanelPodcast {
  /** The journey's podcast for the panel's bar: undefined when it has none. `toUri`: a file as the webview loads it. */
  episodeFor(lj: LoadedJourney, toUri: (u: vscode.Uri) => string): PodcastEpisode | PodcastUnavailable | undefined
  /** Where the audio of `lj` is (the panel's player draws it): sent right after the episode. */
  stateFor(lj: LoadedJourney): PodcastHostState | undefined
  /** The panel came on screen, went off it (a tab in front of it, its group hidden) or closed. */
  viewChanged(): void
}

export const MAP_VIEW = 'codeNotes.journey'
/** How long opening a journey waits for the window to place a new panel (it says within a moment). */
const PLACED_WAIT_MS = 3000

/**
 * The group a new map opens in: the whole group when there is nothing to read beside it (`alone`); else the one it
 * was last in, unless that now holds the tour's code (`codeCol`); else beside the editor.
 */
function mapColumn(alone: boolean, last: number | undefined, codeCol: vscode.ViewColumn | undefined): vscode.ViewColumn {
  if (alone) return vscode.ViewColumn.Active
  if (last !== undefined && last !== codeCol) return last
  return vscode.ViewColumn.Beside
}

/** What the integration tests read of the page, as it reported it (never read by the extension itself). */
class PanelProbe {
  /** Boxes in the last render (the webview really draws); -1: no panel. */
  rendered = -1
  /** The storyline as drawn last: step rows, question rows, the current question, what is cut. */
  story: { steps: number; stops: string[]; cur?: string; overflow: string[]; width: number } | undefined
  /** The box the map last centred on ('': the whole map). */
  focus = ''
}

/** One open panel: made when a panel is adopted, dropped when it closes (so "open" is this one field). */
interface PanelSession {
  readonly panel: vscode.WebviewPanel
  readonly subs: vscode.Disposable[]
  /** What the page was last sent, per part (the home list apart: it is sent only when it changed). */
  sent: { walk: string; home: string }
  /** It is closing (what it tells the extension then must not read the closed panel: VS Code throws). */
  closing: boolean
}

/** The map of one journey at a time, in a webview beside the editor. */
export class MapPanel implements vscode.Disposable {
  private session: PanelSession | undefined
  private shown: LoadedJourney | undefined
  private readonly probe = new PanelProbe()
  /** The page's messages: what it is sent waits until it is ready. */
  private channel: WebviewChannel<FromMap, ToMap>
  /** The podcast player's side of the panel (setPodcast), if one is registered. */
  private podcast: PanelPodcast | undefined
  private readonly layoutEvents = new vscode.EventEmitter<void>()
  private readonly activateEvents = new vscode.EventEmitter<void>()
  private readonly viewEvents = new vscode.EventEmitter<void>()
  /** The editor groups may have changed size (the panel drawn, groups opened or closed): the layout notes the widths
   *  to keep. */
  readonly onDidChangeLayout = this.layoutEvents.event
  /** The panel became the active editor (VS Code may have widened it: the layout undoes that). */
  readonly onDidActivate = this.activateEvents.event
  /** The panel came on screen, went off it (a tab in front of it, its group hidden) or closed. */
  readonly onDidChangeView = this.viewEvents.event
  private readonly slots = new Map<string, vscode.Disposable>()

  /** Older way to hear onDidChangeLayout (one listener: setting it again replaces it). */
  set layoutChanged(f: (() => void) | undefined) { this.slot('layout', this.onDidChangeLayout, f) }
  /** Older way to hear onDidActivate (one listener: setting it again replaces it). */
  set activated(f: (() => void) | undefined) { this.slot('activate', this.onDidActivate, f) }
  private slot(name: string, event: vscode.Event<void>, f: (() => void) | undefined): void {
    this.slots.get(name)?.dispose()
    this.slots.delete(name)
    if (f) this.slots.set(name, event(f))
  }

  /** The podcast player draws its bar in the panel and hears when the panel comes and goes, until disposed. */
  setPodcast(p: PanelPodcast): vscode.Disposable {
    this.podcast = p
    return new vscode.Disposable(() => { if (this.podcast === p) this.podcast = undefined })
  }

  constructor(private extensionUri: vscode.Uri, log: vscode.LogOutputChannel, private onMessage: (lj: LoadedJourney, m: FromMap) => void,
    private tourOf: (lj: LoadedJourney) => TourInfo, private stored: StateStore) {
    this.channel = new WebviewChannel('journey map', log, { onReady: () => this.onReady() })
  }

  private get panel(): vscode.WebviewPanel | undefined { return this.session?.panel }

  get journey(): LoadedJourney | undefined { return this.panel ? this.shown : undefined }

  /** What the integration tests read of the panel: what it shows and where, as the page reported it. */
  snapshot() {
    const { story, rendered, focus } = this.probe
    return { story, map: this.journey?.j.id, mapTitle: this.tabTitle, mapBoxes: rendered, mapFocus: focus, mapColumn: this.viewColumn }
  }
  /** The tab's title (for the integration test). */
  get tabTitle(): string | undefined { return this.panel?.title }
  /** The map is on screen (not a hidden tab). Not while it closes (asked from its own `closed`: VS Code throws then). */
  get visible(): boolean { return !!this.session && !this.session.closing && this.session.panel.visible }
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
      this.adopt(vscode.window.createWebviewPanel(MAP_VIEW, lj.j.title, { viewColumn: col, preserveFocus }, this.options()))
    } else {
      this.panel.reveal(this.panel.viewColumn, preserveFocus)
      if (switched) this.post(true)
    }
    this.panel!.title = this.title()
    this.viewChanged()
  }

  private viewChanged(): void {
    this.podcast?.viewChanged()
    this.viewEvents.fire()
  }

  private options(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    const roots = [vscode.Uri.joinPath(this.extensionUri, 'media'), vscode.Uri.joinPath(this.extensionUri, ...PAGES_DIR), vscode.Uri.joinPath(this.extensionUri, 'out', 'vendor')]
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
    const remember = () => { if (panel.viewColumn) fireAndForget(this.stored.set(STATE.mapColumn, panel.viewColumn), 'mapPanel: store mapColumn') }
    remember()
    this.session = {
      panel,
      sent: { walk: '', home: '' },
      closing: false,
      subs: [
        this.channel.attach(panel.webview, (m) => this.receive(panel, m)),
        panel.onDidChangeViewState((e) => { remember(); this.viewChanged(); if (e.webviewPanel.active) this.activateEvents.fire() }),
        panel.onDidDispose(() => this.disposed(panel)),
        vscode.window.tabGroups.onDidChangeTabGroups((e) => { if (e.opened.length || e.closed.length) this.layoutEvents.fire() }),
      ],
    }
    // A page set before we listened (a restored panel): its 'ready' may have gone already; it answers this with another.
    if (paged) this.channel.sendNow({ type: 'hello' })
  }

  /** A message from the webview: what the panel keeps itself here; the rest goes to the extension (`onMessage`). */
  private receive(panel: vscode.WebviewPanel, m: FromMap): void {
    const handled = this.handleOwn(panel, m)
    if (!handled && this.shown) this.onMessage(this.shown, m)
  }

  /** The messages the panel handles itself; false: the extension's (`home` without `on` is the extension's too). */
  private handleOwn(panel: vscode.WebviewPanel, m: FromMap): boolean {
    switch (m?.type) {
      case 'ready': // the channel ran onReady
        return true
      case 'rendered':
        this.probe.rendered = m.boxes
        return true
      case 'story':
        this.probe.story = { steps: m.steps, stops: m.stops, cur: m.cur, overflow: m.overflow, width: m.width }
        return true
      case 'error': // the webview's errors: the channel logged it
        return true
      case 'legend':
        fireAndForget(this.stored.set(STATE.legendHidden, m.hidden), 'mapPanel: store legendHidden')
        return true
      case 'view':
        this.probe.focus = m.node
        return true
      case 'home':
        if (m.on === undefined) return false
        this.onHome(panel, m.on)
        return true
      default:
        return false
    }
  }

  /** The page is ready: the journey to it (the queue follows). */
  private onReady(): void {
    this.layoutEvents.fire()
    this.post(true)
  }

  /** The list shown or left. Only the reader's own click on "‹ Journeys" ends the walk (the list the extension opens does not). */
  private onHome(panel: vscode.WebviewPanel, on: boolean): void {
    this.home = on
    panel.title = this.title()
    if (on && this.shown && !this.homeAsked) this.onMessage(this.shown, { type: 'home', on })
    this.homeAsked = false
  }

  private disposed(panel: vscode.WebviewPanel): void {
    const s = this.session
    if (s?.panel !== panel) return
    // The panel closed mid-animation: its beat's line is no longer lit.
    s.closing = true
    try {
      if (this.shown) this.onMessage(this.shown, { type: 'closed' })
    } finally {
      this.session = undefined
      this.probe.rendered = -1
      this.channel.detach()
      for (const d of s.subs) d.dispose()
    }
    this.viewChanged()
  }

  /** A message for the webview itself (tutorial, tests): sent once it is ready. */
  send(m: ToMap): void {
    if (this.panel) this.channel.send(m)
  }

  /**
   * Resolves once the window has said which group the panel is in. A panel made beside the editor or in the active
   * group has no column in the extension host until then, and code shown meanwhile could not keep off its group.
   */
  placed(): Promise<void> {
    const p = this.panel
    if (!p || p.viewColumn !== undefined) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); subs.forEach((x) => x.dispose()); resolve() }
      const subs = [p.onDidChangeViewState(() => { if (p.viewColumn !== undefined) done() }), p.onDidDispose(done)]
      const t = setTimeout(done, PLACED_WAIT_MS)
    })
  }

  close(): void { this.panel?.dispose() }
  /** The keyboard back in the panel. */
  takeFocus(): void { this.panel?.reveal(this.panel.viewColumn, false) }

  /** The journey shown was deleted: the map says so, without Start. */
  markDeleted(key: string): void {
    if (!this.session || this.shown?.key !== key) return
    this.session.sent = { walk: '', home: '' }
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

  /** The journey (`all`) or where the walk is, to the page. The home list goes only when it changed (the page keeps
   *  the last one); the rest only when something in it did. */
  private post(all: boolean): void {
    const s = this.session
    if (!s || !this.shown) return
    const { list, home, ...rest } = this.tourOf(this.shown)
    const sent = { walk: JSON.stringify(rest), home: JSON.stringify([list, home]) }
    const homeChanged = all || sent.home !== s.sent.home
    if (!all && !homeChanged && sent.walk === s.sent.walk) return
    s.sent = sent
    const homePart = homeChanged ? { list, home } : {}
    this.channel.sendNow(all ? { type: 'journey', journey: this.shown.j, ...rest, ...homePart } : { type: 'tour', ...rest, ...homePart })
    if (all) this.sendPodcast()
  }

  /** The shown journey's podcast to the bar (none: the bar goes). */
  sendPodcast(): void {
    const panel = this.panel
    if (!panel || !this.shown || !this.channel.ready) return
    const episode = this.podcast?.episodeFor(this.shown, (u) => panel.webview.asWebviewUri(u).toString())
    this.channel.sendNow({ type: 'podcast', episode })
    const st = episode ? this.podcast?.stateFor(this.shown) : undefined
    if (st) this.channel.sendNow({ type: 'podcastState', ...st })
  }

  private html(w: vscode.Webview, loading?: string): string {
    const file = (...p: string[]) => vscode.Uri.joinPath(this.extensionUri, ...p)
    return webviewPage(w, {
      css: [file('media', 'common.css'), file('media', 'journey-map.css'), file('media', 'journey-home.css'), file('media', 'journey-scene.css'), file('media', 'journey-podcast.css')],
      body: `<div id="app"><p class="loading">${loading ? escapeHtml(loading) : 'Loading the map…'}</p></div>`,
      // ELK (the map's layout) first: the bundle uses it as window.ELK.
      scripts: [file('out', 'vendor', 'elk.bundled.js'), pageScript(this.extensionUri, 'map')],
      allow: { media: true },
    })
  }

  dispose(): void {
    this.panel?.dispose()
    for (const d of [...this.slots.values(), this.layoutEvents, this.activateEvents, this.viewEvents]) d.dispose()
  }
}

