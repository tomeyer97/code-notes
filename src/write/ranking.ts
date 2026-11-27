// Which journeys answer a question, ranked by its telling words (core/list/match.ts scores each). Pure: the pick and
// the confirm that show the result are write/rank.ts. No vscode API here (unit-tested in test/writeRanking.test.ts).
import { JourneyText, scoreJourney } from '../core/list/match'

/** A journey scoring at least this share of the best one's weight (same words matched) is offered beside it. */
export const CLOSE_ENOUGH = 0.85
/** At most this many journeys in the pick of those that answer. */
export const MAX_CHOICES = 4
/** The closest journeys shown above "Write" in the confirm. */
export const CLOSEST_SHOWN = 3

/** A journey as the ranking reads it: its texts, and whatever the caller wants back. */
export interface Rankable<T> { item: T; text: JourneyText }

type Score = ReturnType<typeof scoreJourney>

/** Lower case, punctuation as spaces: "How is it saved?" and "how is it saved" are the same. */
const flat = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** The journeys matching any telling word of `question`: most words matched, then the heaviest, first. */
export function rankJourneys<T>(all: Rankable<T>[], question: string): { item: T; s: Score }[] {
  return all
    .map((x) => ({ item: x.item, s: scoreJourney(x.text, question) }))
    .filter((v) => v.s.matched > 0)
    .sort((a, b) => b.s.matched - a.s.matched || b.s.weight - a.s.weight)
}

/**
 * The journeys that answer `question`: the one with the same question or title, else those matching most of its
 * words; more than one only when they are close to the best (then the person picks).
 */
export function matchJourneys<T>(all: Rankable<T>[], question: string): T[] {
  const q = flat(question)
  const same = all.find((x) => flat(x.text.question) === q || flat(x.text.title) === q)
  if (same) return [same.item]
  const ok = rankJourneys(all, question).filter((v) => v.s.answers)
  if (!ok.length) return []
  const top = ok[0].s
  const close = (s: Score) => s.matched === top.matched && s.weight >= top.weight * CLOSE_ENOUGH
  return ok.filter((v, i) => i === 0 || close(v.s)).slice(0, MAX_CHOICES).map((v) => v.item)
}
