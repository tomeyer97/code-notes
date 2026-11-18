import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codeWidth, panelShare } from '../src/panelWidth'

test('the code\'s 80 columns count the gutter, the scrollbar and the minimap', () => {
  // Measured in VS Code at 14 px: a 733 px editor (gutter 83 px, minimap on) showed 66 columns.
  const cols = (w: number) => { let c = 0; while (codeWidth(c + 1, 14) <= w) c++; return c }
  assert.ok(Math.abs(cols(733) - 66) <= 1, `${cols(733)}`)
  assert.ok(codeWidth(80, 14) > 840 && codeWidth(80, 14) < 880, `${codeWidth(80, 14)}`)
  assert.ok(codeWidth(80, 14, false) < codeWidth(80, 14))
})

test('the panel: 35 % by default, never squeezing the code under 80 columns', () => {
  assert.equal(panelShare(1600, { fontSize: 14 }), 0.35)
  // A wide editor area: the code keeps its 80 columns beside the panel.
  const s = panelShare(1200, { fontSize: 14 })
  assert.ok(s > 0 && 1200 * (1 - s) >= codeWidth(80, 14) - 1, `${s}`)
  // 1090 px (a 1440 px window with the sidebar) and a 1280 px window: too narrow for both, no panel.
  assert.equal(panelShare(1090, { fontSize: 14 }), 0)
  assert.equal(panelShare(930, { fontSize: 14 }), 0)
  // Without the minimap the code needs less.
  assert.ok(panelShare(1090, { fontSize: 14, minimap: false }) > 0)
})

test('the reader\'s width is kept (also above 40 %), within the code\'s 80 columns', () => {
  assert.equal(panelShare(2000, { fontSize: 14, remembered: 0.5 }), 0.5)
  assert.equal(panelShare(2000, { fontSize: 14, remembered: 0.25 }), 0.25)
  assert.ok(panelShare(1300, { fontSize: 14, remembered: 0.6 }) < 0.4)
})
