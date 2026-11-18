// The journey panel beside the code: room for both (80 columns of code at least), the width the reader chose, and
// files kept out of the panel's group.

import * as vscode from 'vscode'
import { gstate, KEY, log, mapPanel } from '../app'
import { MAP_VIEW } from '../journeys/mapPanel'
import { panelShare } from '../panelWidth'
import { walk } from './tour'

/** The panel's width as the reader left it (a share of the editor area), every journey. */
const PANEL_SHARE_KEY = 'codeNotes.panelShare'

/** When the extension last set the layout (a resize right after is ours, not the reader's). */
let layoutSetAt = 0

type Layout = { orientation: number; groups: { size?: number }[] }

/** Code and the panel side by side, the panel's index, and the editor area's width (px), when that is the layout. */
async function sideBySide(): Promise<{ layout: Layout; panel: number; total: number } | undefined> {
  const groups = vscode.window.tabGroups.all
  const mapCol = mapPanel.viewColumn
  if (groups.length !== 2 || mapCol === undefined) return undefined
  const panel = groups.findIndex((g) => g.viewColumn === mapCol)
  if (panel < 0 || !groups[1 - panel].tabs.length) return undefined
  const layout = await vscode.commands.executeCommand<Layout>('vscode.getEditorLayout').then((x) => x, () => undefined)
  if (!layout || layout.orientation !== 0 || layout.groups.length !== 2) return undefined
  const total = layout.groups.reduce((a, g) => a + (g.size ?? 0), 0)
  return total > 10 ? { layout, panel, total } : undefined
}

/** The panel's share of an editor area `total` px wide (0: no room beside 80 columns of code). */
function shareFor(total: number): number {
  const ed = vscode.workspace.getConfiguration('editor')
  return panelShare(total, { fontSize: ed.get<number>('fontSize') ?? 14, minimap: ed.get<boolean>('minimap.enabled') ?? true, remembered: gstate.get<number>(PANEL_SHARE_KEY) })
}

/** The editor area's width (px), from the layout as it is now; undefined when it can't be told (groups above each other). */
async function editorAreaWidth(): Promise<number | undefined> {
  const layout = await vscode.commands.executeCommand<Layout>('vscode.getEditorLayout').then((x) => x, () => undefined)
  if (!layout?.groups.length || (layout.groups.length > 1 && layout.orientation !== 0)) return undefined
  const total = layout.groups.reduce((a, g) => a + (g.size ?? 0), 0)
  return total > 10 ? total : undefined
}

/** Room for the panel beside the code (80 columns of it), in the editor area as it is now. */
export async function panelFits(): Promise<boolean> {
  const total = await editorAreaWidth()
  return total === undefined || shareFor(total) > 0
}

/**
 * A walk beside the code: the panel at the reader's width (else 35 %, at most 40 %), never squeezing the code below
 * 80 columns; a window too narrow for both walks with the step card in the editor only (no panel).
 */
export async function codeGetsMoreRoom(): Promise<void> {
  const s = await sideBySide()
  if (!s) return
  const share = shareFor(s.total)
  if (!share) { cardOnly(); return }
  const want = s.layout.groups.map((_, i) => (i === s.panel ? share : 1 - share))
  const now = (s.layout.groups[s.panel].size ?? 0) / s.total
  if (Math.abs(now - share) < 0.02) return
  layoutSetAt = Date.now()
  await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: want.map((size) => ({ size })) }).then(undefined, (e) => log.warn(`layout: ${e}`))
}

/** The panel was resized: by the reader (not just after we set it), so that width is kept for next time. */
export async function rememberPanelWidth(): Promise<void> {
  if (Date.now() - layoutSetAt < 1500) return
  const s = await sideBySide()
  if (s) void gstate.update(PANEL_SHARE_KEY, Math.round(((s.layout.groups[s.panel].size ?? 0) / s.total) * 1000) / 1000)
}

/**
 * a file opened in the journey panel's group (Ctrl+P or a link after a click in the panel) moves to the code
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
  const sel = vscode.window.visibleTextEditors.find((e) => e.viewColumn === mapCol && e.document.uri.toString() === uri.toString())?.selection
  const live = vscode.window.tabGroups.all.find((g) => g.viewColumn === mapCol)?.tabs.find((x) => x.input instanceof vscode.TabInputText && x.input.uri.toString() === uri.toString())
  if (!live || live.isDirty) return
  await vscode.window.tabGroups.close(live, true)
  const ed = await vscode.window.showTextDocument(uri, { viewColumn: walk.codeColumn(), preview: live.isPreview, preserveFocus: false })
  if (sel) { ed.selection = sel; ed.revealRange(sel, vscode.TextEditorRevealType.InCenterIfOutsideViewport) }
}

/** The walk goes on with the step card in the editor; the panel (if open) closes. Said once per walk. */
export function cardOnly(): void {
  if (mapPanel.journey) mapPanel.close()
  log.info('journey panel: no room beside 80 columns of code; the step card only')
  vscode.window.setStatusBarMessage(`$(info) Narrow window: the step card only (${KEY} V: the map)`, 6000)
}
