// 35 journeys over several areas (the size of a real team's list), as list items (src/core/list/journeyList.ts ListItem), for
// the list's unit tests (test/journeyList.test.ts) and the Journeys home harness (test/journey-list/shoot.mjs, which
// loads the built out/test/fixtures/journeyList.js).
import type { ListItem } from '../../src/core/list/journeyList'

/** The topics of each area: one journey per topic, "How <topic> work". */
const AREAS: Record<string, string[]> = {
  api: ['orders', 'discounts', 'auth', 'search', 'uploads', 'webhooks', 'rate limits', 'sessions', 'exports', 'refunds'],
  worker: ['charging', 'emails', 'reports', 'cleanup', 'imports', 'thumbnails', 'reminders', 'retries of payouts'],
  web: ['checkout page', 'cart', 'login form', 'product page', 'admin table', 'search box', 'settings', 'invoices page', 'order history'],
  payments: ['card tokens', 'refund flow', 'disputes', 'currency rounding', 'payouts'],
  config: ['loading settings', 'feature flags', 'secrets'],
}
const DAY = 86_400_000

/** "Now" for the list's ages: 2026-11-16 12:00 UTC. */
export const NOW = Date.parse('2026-11-16T12:00:00Z')

/**
 * The 35 journeys. The i-th (from 1) varies with i: 4-10 steps; every 5th ends in api/store.js (every 10th with its
 * last two steps); every 8th is new, every 9th has a long title, every 11th has steps 2 and 4 stale, every 13th was
 * left at step 2. "How charging work" has a step about retries (what the search tests look for).
 */
export function items(now = NOW): ListItem[] {
  const out: ListItem[] = []
  let i = 0
  for (const [area, topics] of Object.entries(AREAS)) {
    for (const t of topics) {
      i++
      const steps = 4 + (i % 7)
      const inStore = (k: number) => k >= steps - (i % 10 === 0 ? 2 : 1) && i % 5 === 0
      const files = Array.from({ length: steps }, (_, k) => (inStore(k) ? `api/store.js` : `${area}/${t.replace(/\s+/g, '-')}.js`))
      const stepTitle = (k: number) => (t === 'charging' && k === 2 ? 'The worker retries a failed charge with the same key' : `Step ${k + 1} of ${t}`)
      const shift = (i % 3) * 40
      out.push({
        key: `k${i}`,
        kind: 'journey',
        title: `How ${t} work${i % 9 === 0 ? 's end to end with a rather long title for the narrow panel' : ''}`,
        question: `What happens when a customer uses ${t}?`,
        summary: `The path through ${area} for ${t}.`,
        createdAt: new Date(now - i * 3 * DAY).toISOString(),
        files,
        stepTitles: Array.from({ length: steps }, (_, k) => stepTitle(k)),
        steps,
        stale: i % 11 === 0 ? 2 : 0,
        ...(i % 11 === 0 ? { staleSteps: [2, 4] } : {}),
        ranges: Array.from({ length: steps }, (_, k) => ({ start: 10 + k * 12 + shift, end: 18 + k * 12 + shift })),
        isNew: i % 8 === 0,
        resume: i % 13 === 0 ? 2 : 0,
        walkedAt: i % 13 === 0 ? now - i * 1000 : undefined,
      })
    }
  }
  return out
}
