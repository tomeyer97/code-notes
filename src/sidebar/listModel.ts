// The model of the journey lists (journeyList.ts) as this window feeds it: the journeys, the active file and the
// function under the cursor, the sort and the panel home's query. Each piece of state has one owner (below); a change
// that both views show is announced (onDidChangeListState), so neither view knows about the other.

import * as vscode from 'vscode'
import { journeys, tour } from './ports'
import { stored } from '../platform/host'
import { blockAt } from '../core/codeBlocks'
import { blocksOf } from '../platform/symbolBlocks'
import { buildList, ListItem, ListKind, ListModel, Sort } from '../core/list/journeyList'
import { LoadedJourney, posKey } from '../journeys/steps'
import { isNewJourney } from '../notes/seen'
import { relPath } from '../platform/documents'
import { refreshing } from '../write/refreshJourney'
import { STATE } from '../platform/state'

export const listSort = (): Sort => stored().get(STATE.journeySort)

/** The active editor's file, relative to its folder. */
export function activeRel(): string | undefined {
  const e = vscode.window.activeTextEditor
  const f = e && vscode.workspace.getWorkspaceFolder(e.document.uri)
  return e && f && e.document.uri.scheme === 'file' ? relPath(f, e.document.uri) : undefined
}

/** Journeys only: a branch's understanding check lives in the Check view, not in these lists. */
export function listItems(): ListItem[] {
  const t = tour()
  const pos = t.positions()
  const { key: walked, step } = t.state
  return journeys().all().map((lj) => {
    const walking = lj.key === walked && step > 0
    return {
      key: lj.key,
      kind: 'journey' as const,
      title: lj.j.title,
      question: lj.j.question,
      summary: lj.j.summary,
      ...(lj.j.createdAt ? { createdAt: lj.j.createdAt } : {}),
      files: lj.j.steps.map((s, i) => lj.at[i]?.file ?? s.file),
      stepTitles: lj.j.steps.map((s) => s.title),
      steps: lj.j.steps.length,
      ranges: lj.at.map((a) => ({ start: a.start, end: a.end })),
      stale: staleCount(lj),
      staleSteps: staleSteps(lj),
      isNew: isNewJourney(lj),
      ...(refreshing.has(lj.key) ? { refreshing: true } : {}),
      resume: walking ? step : t.resumeAt(lj),
      ...(walking ? { walking: true } : {}),
      walkedAt: Date.parse(pos[posKey(lj)]?.at ?? '') || undefined,
      ...(lj.j.start ? { start: true } : {}),
    }
  })
}

/** "Step 4 changed; the rest still match" (the tooltip and the preview say which). */
export function staleLine(lj: LoadedJourney): string {
  const n = staleSteps(lj)
  if (!n.length) return ''
  const which = n.length === 1 ? `Step ${n[0]}` : `Steps ${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`
  return `⚠ ${which} changed since it was written${n.length < lj.j.steps.length ? '; the rest still match' : ''}`
}

/** The function (1-based lines) around the cursor in the active editor: "In this file" ranks by it. */
export interface CursorContext { span?: { start: number; end: number } }
/** "In this file" in full (the sidebar's "Show all", and the panel home's), until the editor changes. */
export interface HereState { hereAll: boolean }
/** The panel home's own search, chips and sort (the sidebar searches with a picker). */
export interface PanelHomeState { query: string; kind: ListKind | 'all'; area: string; searchSort?: Sort | 'best' }

/** Written by updateCursorSpan only. */
const cursor: CursorContext = {}
const here: HereState = { hereAll: false }
let panelHome: PanelHomeState = { query: '', kind: 'all', area: '' }

const changed = new vscode.EventEmitter<{ editorChanged: boolean }>()
/** What both views list changed (the cursor's function or file, "In this file" in full, the sort): each draws again. */
export const onDidChangeListState = changed.event

/** "In this file" in full, in both views. */
export function showAllHere(): void {
  here.hereAll = true
  changed.fire({ editorChanged: false })
}

/** Another editor: "In this file" is capped again (the cursor's move that follows redraws). */
export function capHere(): void { here.hereAll = false }

/** The sort was picked: both views draw again. */
export const sortChanged = () => changed.fire({ editorChanged: false })

/** The model the Journeys view drew last (journeysTree.ts gives it). */
let drawnModel: () => ListModel | undefined = () => undefined
export function useDrawnModel(f: () => ListModel | undefined): void { drawnModel = f }

/**
 * The state above as one object, for code that reads it so: the panel's controller (tour/mapMessages.ts: the home's
 * query, "Show all" without the sidebar's redraw) and the group rows (rowItems.ts: the groups drawn). New code uses
 * the typed state and functions above.
 */
export const listState = {
  get cursorSpan() { return cursor.span },
  get hereAll() { return here.hereAll },
  set hereAll(v: boolean) { here.hereAll = v },
  get last(): ListModel | undefined { return drawnModel() },
  get homeQuery(): PanelHomeState { return panelHome },
  set homeQuery(q: PanelHomeState) { panelHome = q },
}

/** The function (1-based lines) around the cursor in the active editor: "In this file" ranks by it. */
export async function updateCursorSpan(): Promise<void> {
  const e = vscode.window.activeTextEditor
  if (!e || e.document.uri.scheme !== 'file') { cursor.span = undefined; return }
  const line = e.selection.active.line
  // The whole function around the cursor: every line of it ranks the same.
  const b = blockAt(line, (await blocksOf(e.document)).blocks)
  cursor.span = b ? { start: b.start + 1, end: b.end + 1 } : { start: line + 1, end: line + 1 }
}

/** The editor or the caret moved: the cursor's function is found again a moment later (once the moves stop), and
 *  onDidChangeListState fires when the file or the function is another one (always for another editor). */
let followTimer: NodeJS.Timeout | undefined
let followedSpan = ''

/** How long the cursor must rest before the lists follow it: after a new editor, after a caret move. */
const FOLLOW_EDITOR_MS = 50
const FOLLOW_CARET_MS = 300

export function followCursor(editorChanged: boolean): void {
  clearTimeout(followTimer)
  followTimer = setTimeout(async () => {
    await updateCursorSpan()
    const span = `${activeRel()}|${cursor.span?.start}-${cursor.span?.end}`
    if (span === followedSpan && !editorChanged) return
    followedSpan = span
    changed.fire({ editorChanged })
  }, editorChanged ? FOLLOW_EDITOR_MS : FOLLOW_CARET_MS)
}

/** The lists' model now; `o`: the panel home's search, chips and sort. */
export function listModel(o: Partial<PanelHomeState> = {}): ListModel {
  const now = { activeFile: activeRel(), activeSpan: cursor.span, hereAll: here.hereAll, sort: listSort() }
  return buildList(listItems(), { ...now, ...o })
}

/** Steps whose code can't be found now (the picker says so). */
export const staleCount = (lj: LoadedJourney) => lj.at.filter((a) => a.stale).length

/** The numbers of those steps (1-based). */
export const staleSteps = (lj: LoadedJourney) => lj.at.flatMap((a, i) => (a.stale ? [i + 1] : []))
