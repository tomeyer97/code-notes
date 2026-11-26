// A stale note's banner: the file is gone, it is shorter than the note's lines, or the code changed; with what the
// lines were and the buttons (Keep here, Move). No vscode here: unit-tested in test/threadText.test.ts.
import { Cmd } from '../platform/commands'
import { THREAD_LIMITS } from './limits'
import { verbatimText } from './text'
import type { Links } from './links'

/** The first lines, then "… n more". */
function shortLines(lines: readonly string[]): string[] {
  const max = THREAD_LIMITS.bannerLines
  return lines.length > max ? [...lines.slice(0, max), `… ${lines.length - max} more`] : [...lines]
}

/** Words, runs of spaces and single punctuation: what a changed word is made of. */
const TOKEN = /\s+|[\w$]+|[^\w\s]/g
/** Lines longer than this many tokens (each × the other's) are shown without the changed words picked out. */
const MAX_WORD_CELLS = 40_000

const isSpace = (token: string) => /^\s/.test(token)

/** The longest common subsequence table of two word lists: table[i][j] is the length for oldWords[i..] and newWords[j..]. */
function lcsTable(oldWords: string[], newWords: string[]): number[][] {
  const table: number[][] = Array.from({ length: oldWords.length + 1 }, () => new Array(newWords.length + 1).fill(0))
  for (let i = oldWords.length - 1; i >= 0; i--) {
    for (let j = newWords.length - 1; j >= 0; j--) {
      table[i][j] = oldWords[i] === newWords[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  return table
}

/** For each word of both lists: true when it is not part of their longest common subsequence (it changed). */
function unmatchedWords(oldWords: string[], newWords: string[], table: number[][]): { oldChanged: boolean[]; newChanged: boolean[] } {
  const oldChanged = oldWords.map(() => true), newChanged = newWords.map(() => true)
  let i = 0, j = 0
  while (i < oldWords.length && j < newWords.length) {
    if (oldWords[i] === newWords[j]) {
      oldChanged[i++] = false
      newChanged[j++] = false
    } else if (table[i + 1][j] >= table[i][j + 1]) i++
    else j++
  }
  return { oldChanged, newChanged }
}

/** For each token of the old and the new line: changed. Spaces are left out of the match (a shared space would pull
 *  the words apart); wrappedLine decides theirs. Lines too long to compare: nothing picked out. */
function changedTokens(oldTokens: string[], newTokens: string[]): { oldChanged: boolean[]; newChanged: boolean[] } {
  const wordIndexes = (tokens: string[]) => tokens.flatMap((t, k) => (isSpace(t) ? [] : [k]))
  const oldAt = wordIndexes(oldTokens), newAt = wordIndexes(newTokens)
  const oldChanged = oldTokens.map(() => false), newChanged = newTokens.map(() => false)
  if (oldAt.length * newAt.length > MAX_WORD_CELLS) return { oldChanged, newChanged }
  const oldWords = oldAt.map((k) => oldTokens[k]), newWords = newAt.map((k) => newTokens[k])
  const words = unmatchedWords(oldWords, newWords, lcsTable(oldWords, newWords))
  words.oldChanged.forEach((changed, w) => { oldChanged[oldAt[w]] = changed })
  words.newChanged.forEach((changed, w) => { newChanged[newAt[w]] = changed })
  return { oldChanged, newChanged }
}

/** A line of code as Markdown that wraps (a code block scrolls sideways): escaped text, the changed words as code. */
function wrappedLine(mark: string, tokens: string[], changed: boolean[]): string {
  // A space between two changed words is part of the change (one code span, not two).
  const inChange = changed.map((c, k) => (isSpace(tokens[k]) ? k > 0 && k < tokens.length - 1 && changed[k - 1] && changed[k + 1] : c))
  let out = ''
  for (let start = 0; start < tokens.length;) {
    let end = start
    while (end < tokens.length && inChange[end] === inChange[start]) end++
    const text = tokens.slice(start, end).join('')
    out += inChange[start] && !text.includes('`') ? `\`${text}\`` : verbatimText(text)
    start = end
  }
  return `${mark} ${out}`
}

const tokensOf = (line: string) => line.trim().match(TOKEN) ?? []
const plainLine = (mark: string, line: string) => (line.startsWith('… ') ? line : `${mark} ${verbatimText(line.trim())}`)
/** "−" is not Markdown; a "+" starting a line would be a list item. */
const DEL = '−', INS = '\\+'

/** The note's old code, shortened, one line under the other (wrapped). */
export const oldLines = (lines: readonly string[]) => shortLines(lines).map((l) => plainLine(DEL, l)).join('  \n')

/**
 * Only the lines that changed: − what was there, + what is there now, the changed words picked out (a one-word change
 * is visible, a 15-line note is not repeated). Lines wrap: a long line is never cut at the panel's edge.
 */
export function diffLines(del: readonly string[], ins: readonly string[]): string {
  const linesBefore = shortLines(del), linesNow = shortLines(ins)
  // Line k of the old code is compared word by word with line k of the new; the lines past the pairs are shown whole.
  const pairs = Math.min(del.length, ins.length, THREAD_LIMITS.bannerLines)
  const oldOut = linesBefore.map((line, k) => (k < pairs ? '' : plainLine(DEL, line)))
  const newOut = linesNow.map((line, k) => (k < pairs ? '' : plainLine(INS, line)))
  for (let k = 0; k < pairs; k++) {
    const oldTokens = tokensOf(linesBefore[k]), newTokens = tokensOf(linesNow[k])
    const changed = changedTokens(oldTokens, newTokens)
    oldOut[k] = wrappedLine(DEL, oldTokens, changed.oldChanged)
    newOut[k] = wrappedLine(INS, newTokens, changed.newChanged)
  }
  return [...oldOut, ...newOut].join('  \n')
}

export interface StaleFacts {
  id: string
  file: string
  /** A file or folder note (no lines). */
  wholeFile: boolean
  /** The file is gone. */
  missing: boolean
  /** The file is shorter than the note's lines: its length now. */
  pastEnd?: number
  /** What the lines were (oldLines or diffLines), or '' when there is nothing to show. */
  was: string
  /** The branch the note was written on, when it is not this one. */
  branch?: string
}

const gone = (f: StaleFacts) => `**\`${f.file}\` no longer exists.**`
/** Its own paragraph. */
const wasPart = (f: StaleFacts) => (f.was ? `\n\n${f.was}` : '')
const move = (f: StaleFacts, links: Links) => links.to('Move', Cmd.moveToSelection, f.id)

/** The file is gone: a file note just says so; a note on lines shows them and offers Move. */
export function goneBanner(f: StaleFacts, links: Links): string {
  return f.wholeFile ? gone(f) : `${gone(f)}${wasPart(f)}\n\n${move(f, links)}`
}

/** The file is shorter than the note's lines. */
export function shorterBanner(f: StaleFacts & { pastEnd: number }, links: Links): string {
  return `**The code changed since this note** (the file has ${f.pastEnd} lines now).\n\n${move(f, links)}`
}

/** The code changed: one wording, the branch only as a fact; Keep here · Move. */
export function changedBanner(f: StaleFacts, links: Links): string {
  const branch = f.branch ? ` (written on \`${f.branch}\`)` : ''
  return `**The code changed since this note**${branch}.${wasPart(f)}\n\n${links.to('Keep here', Cmd.acceptCode, f.id)} · ${move(f, links)}`
}

export function staleText(f: StaleFacts, links: Links): string {
  if (f.missing) return goneBanner(f, links)
  if (f.pastEnd !== undefined) return shorterBanner({ ...f, pastEnd: f.pastEnd }, links)
  return changedBanner(f, links)
}
