import { test } from 'node:test'
import assert from 'node:assert/strict'
import { panelShare } from '../src/layout'

test('the panel: 35 % by default, never squeezing the code under ~80 characters', () => {
  assert.equal(panelShare(1600, { fontSize: 14 }), 0.35)
  // 1090 px (a 1440 px window with the sidebar): the code keeps 80 characters.
  const s = panelShare(1090, { fontSize: 14 })
  assert.ok(s > 0 && 1090 * (1 - s) >= 80 * 14 * 0.6 + 60 - 1, `${s}`)
  // Too narrow for both: no panel.
  assert.equal(panelShare(900, { fontSize: 14 }), 0)
})

test('the reader\'s width is kept (also above 40 %), within the code\'s 80 characters', () => {
  assert.equal(panelShare(2000, { fontSize: 14, remembered: 0.5 }), 0.5)
  assert.equal(panelShare(2000, { fontSize: 14, remembered: 0.25 }), 0.25)
  assert.ok(panelShare(1100, { fontSize: 14, remembered: 0.6 }) < 0.4)
})
