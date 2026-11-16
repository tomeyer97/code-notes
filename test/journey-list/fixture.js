// ~40 journeys over several areas and a check, as list items (journeyList.ts ListItem), for the list's tests.
// CommonJS: the unit test (out/test) and the panel shoot (ESM) both load it.
const AREAS = { api: ['orders', 'discounts', 'auth', 'search', 'uploads', 'webhooks', 'rate limits', 'sessions', 'exports', 'refunds'],
  worker: ['charging', 'emails', 'reports', 'cleanup', 'imports', 'thumbnails', 'reminders', 'retries of payouts'],
  web: ['checkout page', 'cart', 'login form', 'product page', 'admin table', 'search box', 'settings', 'invoices page', 'order history'],
  payments: ['card tokens', 'refund flow', 'disputes', 'currency rounding', 'payouts'],
  config: ['loading settings', 'feature flags', 'secrets'] }
const DAY = 86_400_000
function items(now = Date.parse('2026-11-16T12:00:00Z')) {
  const out = []
  let i = 0
  for (const [area, topics] of Object.entries(AREAS)) for (const t of topics) {
    i++
    const steps = 4 + (i % 7)
    const files = Array.from({ length: steps }, (_, k) => (k === steps - 1 && i % 5 === 0 ? `api/store.js` : `${area}/${t.replace(/\s+/g, '-')}.js`))
    out.push({
      key: `k${i}`, kind: 'journey', title: `How ${t} work${i % 9 === 0 ? 's end to end with a rather long title for the narrow panel' : ''}`,
      question: `What happens when a customer uses ${t}?`, summary: `The path through ${area} for ${t}.`,
      createdAt: new Date(now - i * 3 * DAY).toISOString(), files,
      stepTitles: Array.from({ length: steps }, (_, k) => (t === 'charging' && k === 2 ? 'The worker retries a failed charge with the same key' : `Step ${k + 1} of ${t}`)),
      steps, stale: i % 11 === 0 ? 2 : 0, isNew: i % 8 === 0, resume: i % 13 === 0 ? 2 : 0, walkedAt: i % 13 === 0 ? now - i * 1000 : undefined,
    })
  }
  out.push({ key: 'check:understanding/feat-x.json', kind: 'check', title: 'Check · feat/retry-charges', question: 'Questions about this branch\'s change', summary: '', createdAt: new Date(now - DAY / 2).toISOString(),
    files: ['worker/charging.js', 'payments/client.js'], stepTitles: ['What is lost if the worker dies mid-replay?', 'Why no retry on a 4xx?'], steps: 2, stale: 0, isNew: false, resume: 0, progress: '1/2 ✓', open: true })
  return out
}
module.exports = { items, NOW: Date.parse('2026-11-16T12:00:00Z') }
