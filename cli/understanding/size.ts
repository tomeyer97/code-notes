// How big a change is, and what that asks for: the number of questions and tour steps, the names a removal took
// away and where they still appear, how long a check takes.
import { DEFAULTS, DIR } from './constants'
import { gitOk } from './git'
import { linesOf } from './diff'
import type { Check, Config, Question } from './types'

/** What kind of change it is (changeKind). */
type ChangeKind = 'docs' | 'removal' | 'code'
/** A change's size as changeKind reads it: codeStat's or a check's `diffStat`. */
type SizeOf = { docsOnly?: boolean; added: number; removed: number }
/** Where a name still appears (searchNames). */
type Evidence = { name: string; hits: { file: string; line: number }[] }

/**
 * How many questions a change gets, by its size in code lines: 1 under 20, 2 under 60, 3 under 150, 4 under 300, else 5.
 * Config `questions` bounds it: `{ "min": 3, "max": 5 }`, or a number for always that many.
 */
export function questionsFor(lines: number, cfg: Config = DEFAULTS): number {
  const n = lines < 20 ? 1 : lines < 60 ? 2 : lines < 150 ? 3 : lines < 300 ? 4 : 5
  const { min = 1, max = 5 } = cfg.questions ?? {}
  return Math.max(1, Math.min(max, Math.max(min, n)))
}

/** How many questions a top-up adds for `lines` new code lines: 1, or 2 when the change grew a lot. */
export const topUpQuestions = (lines: number): number => (lines < 80 ? 1 : 2)

/**
 * What kind of change it is, for its size rules: `docs` (only documentation), `removal` (only removes code), else
 * `code`. `st`: codeStat's shape (`docsOnly`, `added`, `removed`).
 */
export function changeKind(st: SizeOf | undefined): ChangeKind {
  return st?.docsOnly ? 'docs' : st && st.added === 0 && st.removed > 0 ? 'removal' : 'code'
}

/** How many questions a change gets: one for documentation or a removal, else by its size (questionsFor). */
export function questionsForChange(st: SizeOf, cfg: Config = DEFAULTS): number {
  return changeKind(st) === 'code' ? questionsFor(linesOf(st), cfg) : 1
}

/**
 * How many steps a check's tour has, `[min, max]`: 2-3 for documentation, a removal or a change under 10 code lines;
 * 2-4 under 20; 4-7 under 60; else 6-10. A tour of documentation may have none (its text describes no code).
 */
export function tourSize(kind: string, lines: number): [number, number] {
  if (kind === 'docs' || kind === 'removal' || lines < 10) return [2, 3]
  return lines < 20 ? [2, 4] : lines < 60 ? [4, 7] : [6, 10]
}

/** A check's kind (changeKind), from the file: its questions say docs; its recorded size says a removal. */
export function checkKind(check: Check | undefined): ChangeKind {
  const qs = check?.questions ?? []
  if (qs.length && qs.every((q: Question & { docs?: boolean }) => q.docs)) return 'docs'
  return changeKind(check?.diffStat)
}

const NOT_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'case', 'default', 'return', 'function', 'else', 'new', 'typeof', 'await', 'async', 'export', 'import', 'from', 'const', 'let', 'var', 'this', 'true', 'false', 'null', 'undefined', 'self', 'super', 'constructor', 'module', 'exports', 'require'])
/**
 * The names a removal took away (functions, classes, constants, keys), from its removed code lines: at most 5, in
 * order. Pragmatic: definitions by their usual shape in common languages.
 */
export function removedNames(lines: { sign: string; text: string }[]): string[] {
  const out: string[] = []
  const shapes = [
    /\b(?:function\*?|class|def|fn|interface|type|enum|struct|trait|sub)\s+([A-Za-z_$][\w$]*)/,
    /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
    /\b(?:const|let|var|val)\s+([A-Za-z_$][\w$]*)/,
    /^(?:(?:export|public|private|protected|static|async)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/,
    /^["']?([A-Za-z_$][\w$]*)["']?\s*:\s*\S/,
    /^([A-Za-z_]\w*)\s*=[^=]/,
  ]
  for (const x of lines) {
    if (x.sign !== '-') continue
    for (const re of shapes) {
      const m = re.exec(x.text)
      if (!m) continue
      if (m[1].length >= 3 && !NOT_NAMES.has(m[1]) && !out.includes(m[1])) out.push(m[1])
      break
    }
  }
  return out.slice(0, 5)
}

/**
 * Where each name still appears in the repository at commit `at` (whole words; the check's own files left out):
 * `[{ name, hits: [{ file, line }] }]`. The evidence a removal's question starts from.
 */
export function searchNames(repo: string, at: string, names: string[]): Evidence[] {
  return names.map((name) => {
    const out = gitOk(repo, ['grep', '-n', '-I', '-w', '-F', '-e', name, at, '--', '.', `:!${DIR}`, ':!.code-notes']) ?? ''
    const hits = out.split('\n').map((l) => /^[^:]+:(.+?):(\d+):/.exec(l)).filter(Boolean).map((m) => ({ file: m![1], line: Number(m![2]) }))
    return { name, hits }
  })
}

/** One search result in words: "refundReport: 0 hits", "SAVE15: 1 hit (src/use.js:2)". */
export const evidenceText = (e: Evidence): string => `${e.name}: ${e.hits.length} hit${e.hits.length === 1 ? '' : 's'}${e.hits.length ? ` (${e.hits.slice(0, 3).map((h) => `${h.file}:${h.line}`).join(', ')}${e.hits.length > 3 ? `, +${e.hits.length - 3} more` : ''})` : ''}`


/** How long a check takes, honestly, by its number of questions: "3 questions, ~2 min". */
export const minutesFor = (n: number): number => Math.max(1, Math.round(n * 0.6))
export const sizeText = (n: number): string => `${n} question${n === 1 ? '' : 's'}, ~${minutesFor(n)} min`
/** The same for the merge request and the CI log: "about 2 min" (GitLab reads "~2" as a label). */
export const sizeWords = (n: number): string => sizeText(n).replace('~', 'about ')
