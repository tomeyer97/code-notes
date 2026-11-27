// Matching words against journeys: the Journeys list's search (`matchScore`, journeyList.ts) and "which journey
// answers this question" (`scoreJourney`, write/rank.ts) — one place for both, no vscode API (unit-tested in
// test/match.test.ts).
//
// The two read words by different rules (WordRules below), on purpose so far: the search runs as you type, so a
// partial word must hit ("retr" finds "retries") and an identifier typed is one word; a question is a sentence, so its
// filler ("how does … work in the app") drops out and synonyms count. Giving both the same rules changes what is
// found (measured on 16 real journeys: the top answer to 4-12 of ~300 questions, and the list's results for 3-7
// searches), so that is a product decision, not a clean-up. What they share is written once: the stop-words both
// drop (BASE_STOP) and the loop that weighs a word's best hit over a journey's fields (bestWeight).
import { SYNONYMS } from './synonyms'

/** How a scorer splits text into words, which words say nothing, and how a word is cut to its stem. */
interface WordRules { words: (s: string) => string[]; stop: Set<string>; stem: (w: string) => string }

/** Words neither kind of text says anything about the code with. */
const BASE_STOP = [
  'a an the and or of to in on at by for from with into as so',
  'is are was be do does did can could should would will get gets',
  'how what when where why which who this that it its we our you your i my me their there',
]

const stopWords = (...lines: string[]) => new Set(lines.join(' ').split(' '))

/** The list's stem: "retried", "retries", "retrying" and "retry" meet; so do "charges", "charged" and "charge". Words
 *  of 3 letters or less are kept. */
export function searchStem(w: string): string {
  if (w.length <= 3) return w
  const y = w.replace(/(ies|ied)$/, 'y').replace(/(ying)$/, 'y')
  return y.replace(/(ing|ed|es|s|e)$/, '')
}

/** A question's stem: -ing, -ed, -es or -s goes when 4 letters are left ("environments" → "environment", "bus"). */
export function questionStem(w: string): string {
  return w.replace(/(?:ing|ed|es|s)$/, (end) => (w.length - end.length >= 4 ? '' : end))
}

/** The list's search: words keep `_` (an identifier); stems also meet across -y/-ies ("retry", "retries"). */
const SEARCH: WordRules = {
  words: (s) => s.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean),
  /** Also the words a sentence typed as a search is made of ("how are charges retried": charges, retried). */
  stop: stopWords(...BASE_STOP,
    'but about were been being done whom whose these those they them here',
    'shall may might must has have had got if then than not no yes any some all each every'),
  stem: searchStem,
}

/** A question: words split at `_` too; stems keep at least 4 letters. */
const QUESTION: WordRules = {
  words: (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(Boolean),
  /** Also the words of "how does … work?" and "explain the whole app". */
  stop: stopWords(...BASE_STOP,
    'doing go goes us work works explain happen happens whole application app code flow most'),
  stem: questionStem,
}

/** A field of a journey a scorer looks in: its words, and how much a hit there weighs. */
type Field = [words: string[], weight: number]

/**
 * The best weight a word of the query gets over `fields`: a field's weight times how well one of its words hits
 * (`hit`: 0 for no hit). `found` is told every word that hit. Both scorers below are this and their own rules.
 */
function bestWeight(fields: Field[], hit: (word: string) => number, found?: (word: string) => void): number {
  let best = 0
  for (const [ws, weight] of fields) {
    for (const w of ws) {
      const k = hit(w)
      if (!k) continue
      best = Math.max(best, weight * k)
      found?.(w)
    }
  }
  return best
}

// ---- The list's search ----

/** Light stem of the list's search. */
export const stem = SEARCH.stem

/** The words of a query that count: without the stop-words (unless that leaves none). */
export function queryWords(q: string): string[] {
  const ws = SEARCH.words(q)
  const kept = ws.filter((w) => !SEARCH.stop.has(w))
  return kept.length ? kept : ws
}

/** The list's search: a word matches a query token when it starts with it ("retr" → "retries"); tokens of 4+ letters
 *  also inside a word, or with the same stem. (A question's words: questionWordHit, below.) */
function searchWordHit(w: string, t: string): boolean {
  if (w.startsWith(t) || (t.length >= 4 && w.includes(t))) return true
  if (t.length < 4) return false
  const a = stem(w), b = stem(t)
  return a.length >= 3 && (a.startsWith(b) || (a.length >= 4 && b.startsWith(a)))
}

/** What the list's search looks in, and how much a hit there weighs. */
const SEARCH_WEIGHTS = { title: 6, question: 4, stepTitles: 2, summary: 1.5, files: 1 }
/** A word typed in full (not a prefix or a stem) weighs this much more. */
const WHOLE_WORD = 1.5

export interface SearchText { title: string; question: string; summary: string; stepTitles: string[]; files: string[] }

/**
 * How well an item matches the query (0: not at all): every token must be found in the title, question, summary,
 * step titles or file paths (`any`: at least one); title hits weigh most. Also returns the words that matched.
 */
export function matchScore(it: SearchText, query: string, any = false): { score: number; hits: string[] } {
  const tokens = queryWords(query)
  if (!tokens.length) return { score: 1, hits: [] }
  const w = SEARCH_WEIGHTS
  const fields: Field[] = [
    [SEARCH.words(it.title), w.title],
    [SEARCH.words(it.question), w.question],
    [SEARCH.words(it.stepTitles.join(' ')), w.stepTitles],
    [SEARCH.words(it.summary), w.summary],
    [SEARCH.words(it.files.join(' ')), w.files],
  ]
  let score = 0
  const hits = new Set<string>()
  for (const t of tokens) {
    const best = bestWeight(fields, (x) => (searchWordHit(x, t) ? (x === t ? WHOLE_WORD : 1) : 0), (x) => hits.add(x))
    if (!best && !any) return { score: 0, hits: [] }
    score += best
  }
  return { score, hits: [...hits] }
}

// ---- Which journey answers a question ----

/** Words that say nothing about which journey ("how does … work?"). */
export const STOP = QUESTION.stop

/** The telling words of a question, stemmed. */
export function tellingWords(q: string): string[] {
  return [...new Set(QUESTION.words(q).filter((w) => !QUESTION.stop.has(w)).map(QUESTION.stem))]
}

/** A word and its synonyms (stemmed). */
function variants(w: string): string[] {
  const out = new Set([w])
  for (const g of SYNONYMS) if (g.some((x) => QUESTION.stem(x) === w)) for (const x of g) out.add(QUESTION.stem(x))
  return [...out]
}

/** A question's word: the same word, or one starts the other (both of 4+ letters). (The list's search: searchWordHit.) */
function questionWordHit(v: string, h: string): boolean {
  return h === v || (v.length >= 4 && h.startsWith(v)) || (h.length >= 4 && v.startsWith(h))
}

/** Where a question's word is found, and how much that weighs. */
const QUESTION_WEIGHTS = { head: 3, summary: 2, steps: 1 }
/** A synonym counts a little less than the word itself. */
const SYNONYM = 0.8
/** A question of more than 2 telling words answers when this share of them matched. */
const ANSWERS_SHARE = 0.6

export interface JourneyText { title: string; question: string; summary: string; steps: string[] }

/**
 * How well a journey answers a question: `matched` telling words (of `total`), `weight` (title/question 3, summary 2,
 * step titles 1; a synonym counts a little less), `answers`: most of the words matched (all of 1-2 words, else 60 %).
 */
export function scoreJourney(j: JourneyText, question: string): { matched: number; total: number; weight: number; answers: boolean } {
  const qs = tellingWords(question)
  const stemmed = (ws: string[]) => ws.map(QUESTION.stem)
  const w = QUESTION_WEIGHTS
  const fields: Field[] = [
    [stemmed([...QUESTION.words(j.title), ...QUESTION.words(j.question)]), w.head],
    [stemmed(QUESTION.words(j.summary)), w.summary],
    [stemmed(j.steps.flatMap(QUESTION.words)), w.steps],
  ]
  let matched = 0, weight = 0
  for (const q of qs) {
    const best = Math.max(...variants(q).map((v) => bestWeight(fields, (h) => (questionWordHit(v, h) ? (v === q ? 1 : SYNONYM) : 0))))
    if (best) { matched++; weight += best }
  }
  const total = qs.length
  const need = total <= 2 ? total : Math.ceil(total * ANSWERS_SHARE)
  return { matched, total, weight, answers: total > 0 && matched >= need }
}
