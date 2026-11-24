import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageModule } from './pageModule'

// media/journey-layout.js runs in the webview; its pure parts are bundled here as the page bundles them.
const { verb } = pageModule('media/journey-layout.js')

test('an arrow label is its first clause without timings', () => {
  const cases: [string, string][] = [
    ['polls every 3 s, max 10 min', 'polls'],
    ['retries after up to 10 min', 'retries'],
    ['waits 30 s then reads the row', 'waits then reads the row'],
    ['times out within 5 seconds', 'times out'],
    ['reads (cached for 1 h)', 'reads'],
    ['marks it cancelling; the worker sees it', 'marks it cancelling'],
    ['watches in 2.5 ms steps', 'watches'],
    ['sends the 3 items', 'sends the 3 items'],
  ]
  for (const [label, want] of cases) assert.equal(verb(label), want, label)
})
