// A document's code blocks (functions, classes) from its symbols, else from its text (codeBlocks.ts holds the pure
// part), cached per document version. Used by the code lenses and the Journeys view's "In this file" ranking.

import * as vscode from 'vscode'
import { Block, blocksFromSymbols, blocksFromText, Sym } from './codeBlocks'
import { docLines } from './documents'

/** The blocks per document. Symbols not ready yet (a language server still starting) are not kept for long: the
 *  text's blocks stand in, and the symbols are asked for again after SYMBOLS_RETRY_MS. */
const blockCache = new Map<string, { version: number; blocks: Block[]; fromText?: boolean; at: number }>()

const SYM_KIND: Partial<Record<vscode.SymbolKind, Sym['kind']>> = {
  [vscode.SymbolKind.Function]: 'fn', [vscode.SymbolKind.Method]: 'fn', [vscode.SymbolKind.Constructor]: 'fn',
  [vscode.SymbolKind.Class]: 'class', [vscode.SymbolKind.Interface]: 'class', [vscode.SymbolKind.Struct]: 'class',
  [vscode.SymbolKind.Variable]: 'var', [vscode.SymbolKind.Constant]: 'var',
}

/** Symbols not found last time (no language support, or not ready yet): asked for again after this long, not on
 *  every caret move (each ask goes to the window and back). */
const SYMBOLS_RETRY_MS = 10_000

/** Documents whose blocks are kept. */
const CACHED_DOCS = 30

type AnySymbol = vscode.DocumentSymbol | vscode.SymbolInformation

/** VS Code's symbols as codeBlocks.ts reads them. */
function symsOf(list: AnySymbol[]): Sym[] {
  return list.map((x) => {
    const r = 'range' in x ? x.range : x.location.range
    return { kind: SYM_KIND[x.kind] ?? 'other', start: r.start.line, end: r.end.line, children: 'children' in x ? symsOf(x.children) : [] }
  })
}

/** The document's blocks; `fromText`: from its text (its symbols were not there). */
export async function blocksOf(doc: vscode.TextDocument): Promise<{ blocks: Block[]; fromText: boolean }> {
  const k = doc.uri.toString()
  const c = blockCache.get(k)
  const fresh = c && c.version === doc.version && (!c.fromText || Date.now() - c.at < SYMBOLS_RETRY_MS)
  if (fresh) return { blocks: c.blocks, fromText: !!c.fromText }
  const got = await vscode.commands.executeCommand<AnySymbol[]>('vscode.executeDocumentSymbolProvider', doc.uri).then((x) => x ?? [], () => [])
  const syms = Array.isArray(got) ? symsOf(got) : []
  if (!syms.length) {
    const blocks = blocksFromText(docLines(doc))
    blockCache.set(k, { version: doc.version, blocks, fromText: true, at: Date.now() })
    return { blocks, fromText: true }
  }
  const blocks = blocksFromSymbols(syms)
  blockCache.set(k, { version: doc.version, blocks, at: Date.now() })
  if (blockCache.size > CACHED_DOCS) blockCache.delete(blockCache.keys().next().value!)
  return { blocks, fromText: false }
}
