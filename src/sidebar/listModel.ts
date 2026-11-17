// The model of the journey lists (journeyList.ts) as this window feeds it: the journeys, the active file and the
// function under the cursor, the sort and the panel home's query.

import * as vscode from 'vscode'
import { state } from '../app'
import { Block, blockAt, blocksFromSymbols, blocksFromText, Sym } from '../codeBlocks'
import { buildList, ListItem, ListKind, ListModel, Sort } from '../journeyList'
import { LoadedJourney, posKey } from '../journeys'
import { isNewJourney } from '../seen'
import { relPath } from '../threads/anchoring'
import { tour, walk } from '../tour/tour'
import { docLines } from '../wfs'
import { refreshing } from '../write/refreshJourney'
import { journeyOrder } from './journeyRows'

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
  return journeyOrder().map((lj) => {
    const walking = lj.key === tour.key && tour.step > 0
    return {
      key: lj.key, kind: 'journey' as const, title: lj.j.title, question: lj.j.question, summary: lj.j.summary, ...(lj.j.createdAt ? { createdAt: lj.j.createdAt } : {}),
      files: lj.j.steps.map((s, i) => lj.at[i]?.file ?? s.file), stepTitles: lj.j.steps.map((s) => s.title), steps: lj.j.steps.length,
      ranges: lj.at.map((a) => ({ start: a.start, end: a.end })),
      stale: staleCount(lj), staleSteps: lj.at.flatMap((a, i) => (a.stale ? [i + 1] : [])),
      isNew: isNewJourney(lj), ...(refreshing.has(lj.key) ? { refreshing: true } : {}), resume: walking ? tour.step : walk.resumeAt(lj), ...(walking ? { walking: true } : {}),
      walkedAt: Date.parse(pos[posKey(lj)]?.at ?? '') || undefined, ...(lj.j.start ? { start: true } : {}),
    }
  })
}

/** "Step 4 changed; the rest still match" (the tooltip and the preview say which). */
export function staleLine(lj: LoadedJourney): string {
  const n = lj.at.flatMap((a, i) => (a.stale ? [i + 1] : []))
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

/** The functions of a document (codeBlocks.ts): its symbols, else its text. Symbols not ready yet (a language server
 *  still starting) are not cached: the text's blocks stand in and the symbols are asked for again next time. */
const blockCache = new Map<string, { version: number; blocks: Block[]; fromText?: boolean; at: number }>()

const SYM_KIND: Partial<Record<vscode.SymbolKind, Sym['kind']>> = {
  [vscode.SymbolKind.Function]: 'fn', [vscode.SymbolKind.Method]: 'fn', [vscode.SymbolKind.Constructor]: 'fn',
  [vscode.SymbolKind.Class]: 'class', [vscode.SymbolKind.Interface]: 'class', [vscode.SymbolKind.Struct]: 'class',
  [vscode.SymbolKind.Variable]: 'var', [vscode.SymbolKind.Constant]: 'var',
}

export async function blocksOf(doc: vscode.TextDocument): Promise<{ blocks: Block[]; fromText: boolean }> {
  const k = doc.uri.toString()
  const c = blockCache.get(k)
  // No symbols last time (no language support, or not ready yet): asked again after a while, not on every caret move
  // (each ask goes to the window and back).
  if (c && c.version === doc.version && (!c.fromText || Date.now() - c.at < 10_000)) return { blocks: c.blocks, fromText: !!c.fromText }
  const got = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>('vscode.executeDocumentSymbolProvider', doc.uri).then((x) => x ?? [], () => [])
  const conv = (l: (vscode.DocumentSymbol | vscode.SymbolInformation)[]): Sym[] => l.map((x) => {
    const r = 'range' in x ? x.range : x.location.range
    return { kind: SYM_KIND[x.kind] ?? 'other', start: r.start.line, end: r.end.line, children: 'children' in x ? conv(x.children) : [] }
  })
  const syms = Array.isArray(got) ? conv(got) : []
  if (!syms.length) {
    const blocks = blocksFromText(docLines(doc))
    blockCache.set(k, { version: doc.version, blocks, fromText: true, at: Date.now() })
    return { blocks, fromText: true }
  }
  const blocks = blocksFromSymbols(syms)
  blockCache.set(k, { version: doc.version, blocks, at: Date.now() })
  if (blockCache.size > 30) blockCache.delete(blockCache.keys().next().value!)
  return { blocks, fromText: false }
}

export async function updateCursorSpan(): Promise<void> {
  const e = vscode.window.activeTextEditor
  if (!e || e.document.uri.scheme !== 'file') { listState.cursorSpan = undefined; return }
  const line = e.selection.active.line
  // The whole function around the cursor: every line of it ranks the same.
  const b = blockAt(line, (await blocksOf(e.document)).blocks)
  listState.cursorSpan = b ? { start: b.start + 1, end: b.end + 1 } : { start: line + 1, end: line + 1 }
}

export function listModel(o: { query?: string; kind?: ListKind | 'all'; area?: string; searchSort?: Sort | 'best' } = {}): ListModel {
  return buildList(listItems(), { activeFile: activeRel(), activeSpan: listState.cursorSpan, hereAll: listState.hereAll, sort: listSort(), ...o })
}

/** Steps whose code can't be found now (the picker says so). */
export const staleCount = (lj: LoadedJourney) => lj.at.filter((a) => a.stale).length
