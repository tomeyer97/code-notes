// The model of the journey lists (journeyList.ts) as this window feeds it: the journeys, the active file and the
// function under the cursor, the sort and the panel home's query.

import * as vscode from 'vscode'
import { journeys, state } from '../app'
import { blockAt } from '../codeBlocks'
import { blocksOf } from '../symbolBlocks'
import { buildList, ListItem, ListKind, ListModel, Sort } from '../journeyList'
import { LoadedJourney, posKey } from '../journeys/steps'
import { isNewJourney } from '../seen'
import { relPath } from '../notes/location'
import { tourState, walk } from '../tour/instances'
import { docLines } from '../wfs'
import { refreshing } from '../write/refreshJourney'

export const SORT_KEY = 'codeNotes.journeySort'

export const listSort = (): Sort => state.get<Sort>(SORT_KEY) ?? 'area'

/** The active editor's file, relative to its folder. */
export function activeRel(): string | undefined {
  const e = vscode.window.activeTextEditor
  const f = e && vscode.workspace.getWorkspaceFolder(e.document.uri)
  return e && f && e.document.uri.scheme === 'file' ? relPath(f, e.document.uri) : undefined
}

/** Journeys only: a branch's understanding check lives in the Check view, not in these lists. */
export function listItems(): ListItem[] {
  const pos = walk.positions()
  return journeys.all().map((lj) => {
    const walking = lj.key === tourState.key && tourState.step > 0
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
      resume: walking ? tourState.step : walk.resumeAt(lj),
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

/** What the lists depend on besides the journeys: the function under the cursor in the active editor (1-based; "In
 *  this file" ranks by it), "In this file" in full (sidebar and panel), the last model the sidebar drew (rows' area and
 *  age for journeyItem), and the panel home's own search, chips and sort (the sidebar searches with a picker). */
export const listState: {
  cursorSpan?: { start: number; end: number }
  hereAll: boolean
  last?: ListModel
  homeQuery: { query: string; kind: ListKind | 'all'; area: string; searchSort?: Sort | 'best' }
} = { hereAll: false, homeQuery: { query: '', kind: 'all', area: '' } }

/** The function (1-based lines) around the cursor in the active editor: "In this file" ranks by it. */
export async function updateCursorSpan(): Promise<void> {
  const e = vscode.window.activeTextEditor
  if (!e || e.document.uri.scheme !== 'file') { listState.cursorSpan = undefined; return }
  const line = e.selection.active.line
  // The whole function around the cursor: every line of it ranks the same.
  const b = blockAt(line, (await blocksOf(e.document)).blocks)
  listState.cursorSpan = b ? { start: b.start + 1, end: b.end + 1 } : { start: line + 1, end: line + 1 }
}

/** The editor or the caret moved: the cursor's function is found again a moment later (once the moves stop), and
 *  `changed` is told when the file or the function is another one (always for another editor). */
let followTimer: NodeJS.Timeout | undefined
let followedSpan = ''

/** How long the cursor must rest before the lists follow it: after a new editor, after a caret move. */
const FOLLOW_EDITOR_MS = 50
const FOLLOW_CARET_MS = 300

export function followCursor(editorChanged: boolean, changed: (editorChanged: boolean) => void): void {
  clearTimeout(followTimer)
  followTimer = setTimeout(async () => {
    await updateCursorSpan()
    const span = `${activeRel()}|${listState.cursorSpan?.start}-${listState.cursorSpan?.end}`
    if (span === followedSpan && !editorChanged) return
    followedSpan = span
    changed(editorChanged)
  }, editorChanged ? FOLLOW_EDITOR_MS : FOLLOW_CARET_MS)
}

export function listModel(o: { query?: string; kind?: ListKind | 'all'; area?: string; searchSort?: Sort | 'best' } = {}): ListModel {
  return buildList(listItems(), { activeFile: activeRel(), activeSpan: listState.cursorSpan, hereAll: listState.hereAll, sort: listSort(), ...o })
}

/** Steps whose code can't be found now (the picker says so). */
export const staleCount = (lj: LoadedJourney) => lj.at.filter((a) => a.stale).length

/** The numbers of those steps (1-based). */
export const staleSteps = (lj: LoadedJourney) => lj.at.flatMap((a, i) => (a.stale ? [i + 1] : []))
