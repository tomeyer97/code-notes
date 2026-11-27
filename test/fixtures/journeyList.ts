// 35 journeys over several areas (the size of a real team's list), as list items (src/core/list/journeyList.ts ListItem), for
// the list's unit tests (test/journeyList.test.ts) and the Journeys home harness (test/journey-list/shoot.mjs, which
// loads the built out/test/fixtures/journeyList.js).
//
// Most journeys are plain volume. The few the tests reason about are named below (NAMED): what is special about each
// is written there, and the tests assert on those names.
import type { ListItem } from '../../src/core/list/journeyList'

/** The topics of each area: one journey per topic, "How <topic> work", keyed k1..k35 in this order. */
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

/** The shared file some journeys end in, and how many of their last steps are there. */
export const STORE = 'api/store.js'
const IN_STORE: Record<string, number> = { k5: 1, k10: 2, k15: 1, k20: 2, k25: 1, k30: 2, k35: 1 }

/**
 * The journeys the tests reason about. Every journey kN has 4 + N % 7 steps, created N × 3 days before NOW (so k1 is
 * the newest), its steps' lines 12 apart from line 10 + (N % 3) × 40.
 */
export const NAMED = {
  /** k1, "How orders work": the newest, 5 steps. */
  newest: 'k1',
  /** k11 "How charging work": its step 3 is about retries (what the search tests look for). */
  retries: 'k11',
  /** In api/store.js: their last step (k10, k20, k30: their last two). */
  inStore: Object.keys(IN_STORE),
  /** Two steps in api/store.js (7, 11 and 6 steps). */
  twoInStore: ['k10', 'k20', 'k30'],
  /** k25's last step (its 8th) is at lines 134-142 of api/store.js: the cursor's function there. */
  atCursor: { key: 'k25', span: { start: 136, end: 136 } },
  /** Never opened. */
  isNew: ['k8', 'k16', 'k24', 'k32'],
  /** A long title (the narrow panel's wrapping). */
  longTitle: ['k9', 'k18', 'k27'],
  /** Steps 2 and 4 stale. */
  stale: ['k11', 'k22', 'k33'],
  /** Left at step 2, walked (k13 the more recently). */
  leftAtStep2: ['k13', 'k26'],
  /** The config area's journeys. */
  config: ['k33', 'k34', 'k35'],
}

/** The 35 journeys (`now`: the ages' "now"). */
export function items(now = NOW): ListItem[] {
  const out: ListItem[] = []
  let i = 0
  for (const [area, topics] of Object.entries(AREAS)) {
    for (const t of topics) {
      i++
      const key = `k${i}`
      const steps = 4 + (i % 7)
      const inStore = (k: number) => k >= steps - (IN_STORE[key] ?? 0)
      const files = Array.from({ length: steps }, (_, k) => (inStore(k) ? STORE : `${area}/${t.replace(/\s+/g, '-')}.js`))
      const stepTitle = (k: number) => (key === NAMED.retries && k === 2 ? 'The worker retries a failed charge with the same key' : `Step ${k + 1} of ${t}`)
      const shift = (i % 3) * 40
      const stale = NAMED.stale.includes(key)
      const left = NAMED.leftAtStep2.includes(key)
      out.push({
        key,
        kind: 'journey',
        title: `How ${t} work${NAMED.longTitle.includes(key) ? 's end to end with a rather long title for the narrow panel' : ''}`,
        question: `What happens when a customer uses ${t}?`,
        summary: `The path through ${area} for ${t}.`,
        createdAt: new Date(now - i * 3 * DAY).toISOString(),
        files,
        stepTitles: Array.from({ length: steps }, (_, k) => stepTitle(k)),
        steps,
        stale: stale ? 2 : 0,
        ...(stale ? { staleSteps: [2, 4] } : {}),
        ranges: Array.from({ length: steps }, (_, k) => ({ start: 10 + k * 12 + shift, end: 18 + k * 12 + shift })),
        isNew: NAMED.isNew.includes(key),
        resume: left ? 2 : 0,
        walkedAt: left ? now - i * 1000 : undefined,
      })
    }
  }
  return out
}
