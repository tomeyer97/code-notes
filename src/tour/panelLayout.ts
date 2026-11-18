// The journey panel beside the code: room for both (80 columns of code at least), the width the reader chose, and
// files kept out of the panel's group.

import * as vscode from 'vscode'
import { gstate, KEY, log, mapPanel } from '../app'
import { MAP_VIEW } from '../journeys/mapPanel'
import { panelShare } from '../panelWidth'
import { walk } from './instances'

/** The panel's width as the reader left it (a share of the editor area), every journey. */
const PANEL_SHARE_KEY = 'codeNotes.panelShare'

/** When the extension last set the layout (a resize right after is ours, not the reader's). */
let layoutSetAt = 0

type Layout = { orientation: number; groups: { size?: number }[] }

/** The editor layout and the editor area's width (px: the groups' sizes summed); undefined when VS Code doesn't say
 *  (or says 10 px or less: not laid out yet). */
async function readEditorLayout(): Promise<{ layout: Layout; total: number } | undefined> {
  const layout = await vscode.commands.executeCommand<Layout>('vscode.getEditorLayout').then((x) => x, () => undefined)
  if (!layout) return undefined
  const total = layout.groups.reduce((a, g) => a + (g.size ?? 0), 0)
  return total > 10 ? { layout, total } : undefined
}

/** Code and the panel side by side, the panel's index, and the editor area's width (px), when that is the layout. */
async function sideBySide(): Promise<{ layout: Layout; panel: number; total: number } | undefined> {
  const groups = vscode.window.tabGroups.all
  const mapCol = mapPanel.viewColumn
  if (groups.length !== 2 || mapCol === undefined) return undefined
  const panel = groups.findIndex((g) => g.viewColumn === mapCol)
  if (panel < 0 || !groups[1 - panel].tabs.length) return undefined
  const read = await readEditorLayout()
  if (!read || read.layout.orientation !== 0 || read.layout.groups.length !== 2) return undefined
  return { ...read, panel }
}

/** The panel's share of an editor area `total` px wide (0: no room beside 80 columns of code). */
function shareFor(total: number): number {
  const ed = vscode.workspace.getConfiguration('editor')
  const fontSize = ed.get<number>('fontSize') ?? 14
  const minimap = ed.get<boolean>('minimap.enabled') ?? true
  return panelShare(total, { fontSize, minimap, remembered: gstate.get<number>(PANEL_SHARE_KEY) })
}

/** The editor area's width (px), from the layout as it is now; undefined when it can't be told (groups above each other). */
async function editorAreaWidth(): Promise<number | undefined> {
  const read = await readEditorLayout()
  if (!read || (read.layout.groups.length > 1 && read.layout.orientation !== 0)) return undefined
  return read.total
}

/** Room for the panel beside the code (80 columns of it), in the editor area as it is now. */
export async function panelFits(): Promise<boolean> {
  const total = await editorAreaWidth()
  return total === undefined || shareFor(total) > 0
}

/**
 * A walk beside the code: the panel at the reader's width (else 35 %, at most 40 %), never squeezing the code below
 * 80 columns. A panel that is open is never closed from here (a reload, a row clicked again): too little room keeps
 * the layout as it is; only opening a journey decides "the step card only" (openMapIfRoom). The layout never changes
 * on its own mid-walk (F15, F51, F112, F128).
 */
export async function codeGetsMoreRoom(): Promise<void> {
  const s = await sideBySide()
  if (!s) return
  const share = shareFor(s.total)
  if (!share) { log.info('journey panel: no room beside 80 columns of code; the layout stays as it is'); return }
  const want = s.layout.groups.map((_, i) => (i === s.panel ? share : 1 - share))
  const now = (s.layout.groups[s.panel].size ?? 0) / s.total
  if (Math.abs(now - share) < 0.02) return
  layoutSetAt = Date.now()
  const layout = { orientation: 0, groups: want.map((size) => ({ size })) }
  await vscode.commands.executeCommand('vscode.setEditorLayout', layout).then(undefined, (e) => log.warn(`layout: ${e}`))
}

/** VS Code's minimum width of an editor group (px). A group activated while exactly this wide is expanded by VS Code
 *  to an even share of the editor area (EditorPart doRestoreGroup): focusing a panel dragged or squeezed to its
 *  minimum (Ctrl+3, a click in it, ‹ Journeys, a row of the Journeys view) flipped it from ~220 to ~580 px mid-episode
 *  (F112, F127, F128). */
const GROUP_MIN_PX = 220
/** A panel grown by more than this (px) on being activated was grown by VS Code, not dragged. */
const EXPANDED_PX = 100

/** The groups' widths (px) as last seen settled (side by side only). */
let known: number[] | undefined

async function flatWidths(): Promise<{ sizes: number[]; total: number } | undefined> {
  const read = await readEditorLayout()
  if (!read || read.layout.orientation !== 0 || read.layout.groups.some((g) => (g as { groups?: unknown[] }).groups?.length)) return undefined
  return { sizes: read.layout.groups.map((g) => g.size ?? 0), total: read.total }
}

/** The layout as it is now is the one to keep (the reader dragged, groups opened or closed, the extension set it). */
export async function noteLayout(): Promise<void> {
  known = (await flatWidths())?.sizes
}

/**
 * The panel was activated (focused, clicked, revealed). If VS Code expanded it from its minimum width just now, the
 * widths it had come back: the layout changes only when the reader changes it.
 */
export async function keepWidthOnFocus(): Promise<void> {
  const mapCol = mapPanel.viewColumn
  const before = known
  const now = await flatWidths()
  if (mapCol === undefined || !now) return
  const i = mapCol - 1
  const expanded = !!before && before.length === now.sizes.length && before[i] <= GROUP_MIN_PX + 0.5 && now.sizes[i] > before[i] + EXPANDED_PX
  if (!expanded) { known = now.sizes; return }
  layoutSetAt = Date.now()
  log.info('journey panel: kept at its width (VS Code widened it when it was focused at its minimum)')
  const total = before!.reduce((x, y) => x + y, 0)
  // VS Code keeps an expanded group expanded through a new layout until the widths are evened: evened, then set.
  await vscode.commands.executeCommand('workbench.action.evenEditorWidths').then(undefined, () => undefined)
  await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: before!.map((w) => ({ size: w / total })) }).then(undefined, (e) => log.warn(`layout: ${e}`))
}

/** The panel was resized: by the reader (not just after we set it), so that width is kept for next time. */
export async function rememberPanelWidth(): Promise<void> {
  // Dragged, or set by the extension: the width to keep (an expansion by VS Code on focus is undone first).
  if (Date.now() - layoutSetAt < 1500) { await noteLayout(); return }
  await keepWidthOnFocus()
  const s = await sideBySide()
  if (!s) return
  const share = (s.layout.groups[s.panel].size ?? 0) / s.total
  void gstate.update(PANEL_SHARE_KEY, Math.round(share * 1000) / 1000)
}

/**
 * A file opened in the journey panel's group (Ctrl+P or a link after a click in the panel) moves to the code
 * group, at the same place, so it never covers the journey. Not a group lock: VS Code locks only the active group, and
 * the lock stays on that group after the panel leaves it (then the code's group refused files).
 */
export async function keepOffMap(t: vscode.Tab): Promise<void> {
  const mapCol = mapPanel.viewColumn
  if (mapCol === undefined || t.group.viewColumn !== mapCol || !(t.input instanceof vscode.TabInputText)) return
  if (!t.group.tabs.some((x) => x.input instanceof vscode.TabInputWebview && x.input.viewType.endsWith(MAP_VIEW))) return
  const uri = t.input.uri
  // Where Quick Open put the caret (file:line), once its editor is known.
  await new Promise((r) => setTimeout(r, 30))
  const isFile = (u: vscode.Uri) => u.toString() === uri.toString()
  const sel = vscode.window.visibleTextEditors.find((e) => e.viewColumn === mapCol && isFile(e.document.uri))?.selection
  const mapGroup = vscode.window.tabGroups.all.find((g) => g.viewColumn === mapCol)
  const live = mapGroup?.tabs.find((x) => x.input instanceof vscode.TabInputText && isFile(x.input.uri))
  if (!live || live.isDirty) return
  await vscode.window.tabGroups.close(live, true)
  const ed = await vscode.window.showTextDocument(uri, { viewColumn: walk.codeColumn(), preview: live.isPreview, preserveFocus: false })
  if (!sel) return
  ed.selection = sel
  ed.revealRange(sel, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
}

/** The panel needs this many px for its map's boxes (journey-splitter.js MAPMIN, with the panel's padding). */
const MAP_ROOM_PX = 300

/**
 * The map asked for (Ctrl+' V) in a panel too narrow for its boxes: the panel gets the room, taken from the widest
 * other group beside it (side by side only). Asked for, so the layout may change; never otherwise.
 */
export async function roomForMap(): Promise<void> {
  const mapCol = mapPanel.viewColumn
  const read = await readEditorLayout()
  if (mapCol === undefined || !read || read.layout.orientation !== 0 || read.layout.groups.some((g) => (g as { groups?: unknown[] }).groups?.length)) return
  const sizes = read.layout.groups.map((g) => g.size ?? 0)
  const i = mapCol - 1
  if (i < 0 || i >= sizes.length || sizes[i] >= MAP_ROOM_PX) return
  const from = sizes.map((w, k) => (k === i ? -1 : w)).reduce((best, w, k, a) => (w > a[best] ? k : best), i === 0 ? 1 : 0)
  const give = Math.min(MAP_ROOM_PX - sizes[i], sizes[from] - MAP_ROOM_PX)
  if (give <= 0) return
  sizes[i] += give
  sizes[from] -= give
  layoutSetAt = Date.now()
  const layout = { orientation: 0, groups: sizes.map((w) => ({ size: w / read.total })) }
  await vscode.commands.executeCommand('vscode.setEditorLayout', layout).then(undefined, (e) => log.warn(`layout: ${e}`))
  await noteLayout()
}

/** The walk goes on with the step card in the editor; the panel (if open) closes. Said once per walk. */
export function cardOnly(): void {
  if (mapPanel.journey) mapPanel.close()
  log.info('journey panel: no room beside 80 columns of code; the step card only')
  vscode.window.setStatusBarMessage(`$(info) Narrow window: the step card only (${KEY} V: the map)`, 6000)
}
