// The journey panel beside the code: room for both (80 columns of code at least), the width the reader chose, and
// files kept out of the panel's group. VS Code has no event for "the reader resized a group", so the panel tells a
// resize of its own from the reader's by when it last set the layout (justSetByUs).

import * as vscode from 'vscode'
import type { StateStore } from '../../platform/state'
import { STATE } from '../../platform/state'
import { OWN_MOVE_MS } from '../../platform/timings'
import { codeRoomMove } from './codeRoom'
import {
  codeWidth, EditorLayout, expandedOnFocus, groupWidths, grownSince, isFlatRow, layoutOfWidths, listeningShare, panelShare, withRoomForMap,
} from '../../core/panelWidth'

/** A layout change VS Code reports this soon after the panel set one is the panel's own (the same settling time as
 *  the extension's other own moves). */
export const OWN_LAYOUT_MS = OWN_MOVE_MS
/** Quick Open (Ctrl+P file:line) sets the caret of the file it opened just after the tab appears; there is no event
 *  for it, so the selection is read this much later. */
const QUICK_OPEN_CARET_MS = 30
/** A share this close to the one wanted is left alone (no layout churn for a few px). */
const SHARE_TOLERANCE = 0.02

/** What the layout needs of the panel and of the walk. */
export interface PanelLayoutDeps {
  /** The panel's group, while it is open. */
  viewColumn(): vscode.ViewColumn | undefined
  /** The panel shows a journey (it is open). */
  isOpen(): boolean
  close(): void
  /** The walk's code group. */
  codeColumn(): vscode.ViewColumn | undefined
  /** An episode is on: the panel holds the animation and the player (the podcast says, through the walk). */
  episodeOn(): boolean
  /** The chord prefix, for the hint when the panel is left out. */
  chordKey(): string
  /** The panel's webview type (a tab of it in a group is the panel). */
  viewType: string
  log: vscode.LogOutputChannel
  stored: StateStore
  now?: () => number
}

/** The layout around the journey panel: one per panel. */
export class PanelLayout {
  /** When the panel last set the layout (a resize right after is ours, not the reader's). */
  private setAt = 0
  /** The groups' widths (px) as last seen settled (side by side only). */
  private known: number[] | undefined
  /** The reader asked for the map's room (Ctrl+' V) while the panel is open: a step change keeps that layout, even
   *  with the code under 80 columns. A drag is not told from a window resize, so it doesn't count. */
  private readerChose = false
  private readonly now: () => number

  constructor(private readonly d: PanelLayoutDeps) {
    this.now = d.now ?? Date.now
  }

  private justSetByUs(): boolean { return this.now() - this.setAt < OWN_LAYOUT_MS }

  /** The editor layout and the editor area's width (px: the groups' sizes summed); undefined when VS Code doesn't say
   *  (or says 10 px or less: not laid out yet). */
  private async read(): Promise<{ layout: EditorLayout; total: number } | undefined> {
    const layout = await vscode.commands.executeCommand<EditorLayout>('vscode.getEditorLayout').then((x) => x, () => undefined)
    if (!layout) return undefined
    const total = groupWidths(layout).reduce((a, w) => a + w, 0)
    return total > 10 ? { layout, total } : undefined
  }

  /** The groups' widths (px), when they are one flat row. */
  private async flatWidths(): Promise<number[] | undefined> {
    const read = await this.read()
    return read && isFlatRow(read.layout) ? groupWidths(read.layout) : undefined
  }

  /** Sets the layout (marked as ours). */
  private async setLayout(layout: EditorLayout): Promise<void> {
    this.setAt = this.now()
    await vscode.commands.executeCommand('vscode.setEditorLayout', layout).then(undefined, (e) => this.d.log.warn(`layout: ${e}`))
  }

  /** Sets these widths (px). VS Code keeps an expanded group expanded through a new layout until the widths are
   *  evened: evened, then set. */
  private async applyWidths(sizes: number[]): Promise<void> {
    this.setAt = this.now()
    await vscode.commands.executeCommand('workbench.action.evenEditorWidths').then(undefined, () => undefined)
    await this.setLayout(layoutOfWidths(sizes))
  }

  /** Code and the panel side by side, the panel's index, and the editor area's width (px), when that is the layout. */
  private async sideBySide(): Promise<{ layout: EditorLayout; panel: number; total: number } | undefined> {
    const groups = vscode.window.tabGroups.all
    const mapCol = this.d.viewColumn()
    if (groups.length !== 2 || mapCol === undefined) return undefined
    const panel = groups.findIndex((g) => g.viewColumn === mapCol)
    if (panel < 0 || !groups[1 - panel].tabs.length) return undefined
    const read = await this.read()
    if (!read || read.layout.orientation !== 0 || read.layout.groups.length !== 2) return undefined
    return { ...read, panel }
  }

  /** The editor's font size and minimap (what 80 columns of code need). */
  private editorLook(): { fontSize: number; minimap: boolean } {
    const ed = vscode.workspace.getConfiguration('editor')
    return { fontSize: ed.get<number>('fontSize') ?? 14, minimap: ed.get<boolean>('minimap.enabled') ?? true }
  }

  /** The panel's share of an editor area `total` px wide (0: no room beside 80 columns of code). */
  private shareFor(total: number): number {
    return panelShare(total, { ...this.editorLook(), remembered: this.d.stored.get(STATE.panelShare) })
  }

  /** Room for the panel beside the code (80 columns of it), in the editor area as it is now. */
  async panelFits(): Promise<boolean> {
    const read = await this.read()
    // Groups above each other: the width can't be told, so the panel is taken to fit.
    if (!read || (read.layout.groups.length > 1 && read.layout.orientation !== 0)) return true
    return this.shareFor(read.total) > 0
  }

  /**
   * A walk beside the code: the panel at the reader's width (else 35 %, at most 40 %), never squeezing the code below
   * 80 columns. A panel that is open is never closed from here (a reload, a row clicked again): too little room keeps
   * the layout as it is; only opening a journey decides "the step card only" (cardOnly), and a step change that finds
   * the code under 80 columns (keepCodeRoom). While an episode is on, the panel is as wide as its animation and
   * player need (listeningShare) and the code gets the rest; it is not remembered as the reader's width.
   */
  async codeGetsMoreRoom(): Promise<void> {
    const s = await this.sideBySide()
    if (!s) return
    const share = this.d.episodeOn() ? listeningShare(s.total) : this.shareFor(s.total)
    if (!share) { this.d.log.info('journey panel: no room beside 80 columns of code; the layout stays as it is'); return }
    const now = (s.layout.groups[s.panel].size ?? 0) / s.total
    if (Math.abs(now - share) < SHARE_TOLERANCE) return
    await this.setLayout({ orientation: 0, groups: s.layout.groups.map((_, i) => ({ size: i === s.panel ? share : 1 - share })) })
  }

  /**
   * A step opened with the panel beside it: the code keeps its 80 columns. Squeezed under them (a panel opened by
   * Ctrl+' V or left open while the window narrowed), the panel shrinks to leave them, or closes: the step card alone.
   * The map's room asked for while the panel is open stays, and so does the listening width.
   */
  async keepCodeRoom(): Promise<void> {
    if (!this.d.isOpen()) { this.readerChose = false; return }
    if (this.d.episodeOn()) return
    const s = await this.sideBySide()
    if (!s) return
    const look = this.editorLook()
    const move = codeRoomMove({
      codePx: s.layout.groups[1 - s.panel].size ?? 0,
      needPx: codeWidth(80, look.fontSize, look.minimap),
      share: this.shareFor(s.total),
      readerChose: this.readerChose,
    })
    if (move === 'keep') return
    if (move === 'cardOnly') { this.cardOnly(); return }
    // Already at that share: VS Code's own rounding of the groups, not a squeeze.
    if (Math.abs((s.layout.groups[s.panel].size ?? 0) / s.total - move.share) < SHARE_TOLERANCE) return
    this.d.log.info('journey panel: the code was under 80 columns; the panel made narrower')
    await this.setLayout({ orientation: 0, groups: s.layout.groups.map((_, i) => ({ size: i === s.panel ? move.share : 1 - move.share })) })
  }

  /** The layout as it is now is the one to keep (the reader dragged, groups opened or closed, the extension set it). */
  async noteLayout(): Promise<void> {
    this.known = await this.flatWidths()
  }

  /**
   * The panel was activated (focused, clicked, revealed). If VS Code expanded it from its minimum width just now, the
   * widths it had come back: the layout changes only when the reader changes it.
   */
  async keepWidthOnFocus(): Promise<void> {
    const mapCol = this.d.viewColumn()
    const before = this.known
    const now = await this.flatWidths()
    if (mapCol === undefined || !now) return
    // Our own layout (Ctrl+' V's room, a walk's width), or not an expansion: that is the one to keep.
    if (this.justSetByUs() || !expandedOnFocus(before, now, mapCol - 1)) { this.known = now; return }
    this.d.log.info('journey panel: kept at its width (VS Code widened it when it was focused at its minimum)')
    await this.applyWidths(before)
  }

  /** The panel was resized: by the reader (not just after we set it), so that width is kept for next time. */
  async rememberPanelWidth(): Promise<void> {
    if (this.justSetByUs()) { await this.noteLayout(); return }
    // An expansion by VS Code on focus is undone first.
    await this.keepWidthOnFocus()
    const s = await this.sideBySide()
    if (!s) return
    const share = (s.layout.groups[s.panel].size ?? 0) / s.total
    await this.d.stored.set(STATE.panelShare, Math.round(share * 1000) / 1000)
  }

  /**
   * A file opened in the journey panel's group (Ctrl+P or a link after a click in the panel) moves to the code
   * group, at the same place, so it never covers the journey. Not a group lock: VS Code locks only the active group,
   * and the lock stays on that group after the panel leaves it (then the code's group refused files).
   */
  async keepOffMap(t: vscode.Tab): Promise<void> {
    const mapCol = this.d.viewColumn()
    if (mapCol === undefined || t.group.viewColumn !== mapCol || !(t.input instanceof vscode.TabInputText)) return
    const isPanel = (x: vscode.Tab) => x.input instanceof vscode.TabInputWebview && x.input.viewType.endsWith(this.d.viewType)
    if (!t.group.tabs.some(isPanel)) return
    const uri = t.input.uri
    const isFile = (u: vscode.Uri) => u.toString() === uri.toString()
    await new Promise((r) => setTimeout(r, QUICK_OPEN_CARET_MS))
    const sel = vscode.window.visibleTextEditors.find((e) => e.viewColumn === mapCol && isFile(e.document.uri))?.selection
    const mapGroup = vscode.window.tabGroups.all.find((g) => g.viewColumn === mapCol)
    const live = mapGroup?.tabs.find((x) => x.input instanceof vscode.TabInputText && isFile(x.input.uri))
    if (!live || live.isDirty) return
    await vscode.window.tabGroups.close(live, true)
    const shown = { viewColumn: this.d.codeColumn(), preview: live.isPreview, preserveFocus: false }
    const ed = await vscode.window.showTextDocument(uri, shown)
    if (!sel) {
      this.d.log.info(`journey panel: ${vscode.workspace.asRelativePath(uri)} moved to the code without its caret (not known after ${QUICK_OPEN_CARET_MS} ms)`)
      return
    }
    ed.selection = sel
    ed.revealRange(sel, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
  }

  /**
   * The map asked for (Ctrl+' V) in a panel too narrow for its boxes: the panel gets the room, taken from the widest
   * other group beside it (side by side only). Asked for, so the layout may change; never otherwise.
   */
  async roomForMap(): Promise<void> {
    const mapCol = this.d.viewColumn()
    const now = await this.flatWidths()
    if (mapCol === undefined || !now) return
    this.readerChose = true
    const i = mapCol - 1
    // Revealing the panel may just have had VS Code expand it (focused at its minimum): the widths before that count.
    const sizes = grownSince(this.known, now, i) ? [...this.known] : now
    const wider = withRoomForMap(sizes, i)
    if (!wider) return
    await this.applyWidths(wider)
    await this.noteLayout()
  }

  /** The walk goes on with the step card in the editor; the panel (if open) closes. Said once per walk. */
  cardOnly(): void {
    this.readerChose = false
    if (this.d.isOpen()) this.d.close()
    this.d.log.info('journey panel: no room beside 80 columns of code; the step card only')
    vscode.window.setStatusBarMessage(`$(info) Narrow window: the step card only (${this.d.chordKey()} V: the map)`, 6000)
  }
}
