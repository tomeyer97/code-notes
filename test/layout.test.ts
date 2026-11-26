import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  codeWidth, DEFAULT_SHARE, expandedOnFocus, GROUP_MIN_PX, grownSince, isFlatRow, layoutOfWidths, LISTENING_MAX_PX, LISTENING_MIN_PX,
  LISTENING_SHARE, listeningShare, MAP_ROOM_PX, MAX_SHARE, MEASURED_EDITOR, panelShare, widestOther, withRoomForMap,
} from '../src/core/panelWidth'
import { codeRoomMove } from '../src/journeys/panel/codeRoom'

// What is measured (MEASURED_EDITOR, in src) against what the width model computes from it.

test('the code\'s 80 columns count the gutter, the scrollbar and the minimap', () => {
  const { fontSize, widthPx, gutterPx, columns } = MEASURED_EDITOR
  const cols = (w: number) => { let c = 0; while (codeWidth(c + 1, fontSize) <= w) c++; return c }
  // The model reproduces the measurement (within a column).
  assert.ok(Math.abs(cols(widthPx) - columns) <= 1, `${cols(widthPx)}`)
  // 80 columns: the measured gutter and 80 of the measured columns' width (the rest of the editor), within 2.5 %.
  const measured80 = gutterPx + ((widthPx - gutterPx) / columns) * 80
  assert.ok(Math.abs(codeWidth(80, fontSize) - measured80) / measured80 < 0.025, `${codeWidth(80, fontSize)} vs ${measured80}`)
  assert.ok(codeWidth(80, fontSize, false) < codeWidth(80, fontSize))
})

test('the panel: 35 % by default, never squeezing the code under 80 columns', () => {
  const need = codeWidth(80, 14)
  assert.equal(panelShare(1600, { fontSize: 14 }), DEFAULT_SHARE)
  // Just room enough: still the default.
  const roomy = Math.ceil(need / (1 - DEFAULT_SHARE)) + 10
  assert.equal(panelShare(roomy, { fontSize: 14 }), DEFAULT_SHARE)
  // Less: the code keeps its 80 columns beside the panel.
  const s = panelShare(1200, { fontSize: 14 })
  assert.ok(s > 0 && s < DEFAULT_SHARE && 1200 * (1 - s) >= need - 1, `${s}`)
  // 1090 px (a 1440 px window with the sidebar) and a 1280 px window: too narrow for both, no panel.
  assert.equal(panelShare(1090, { fontSize: 14 }), 0)
  assert.equal(panelShare(930, { fontSize: 14 }), 0)
  // Without the minimap the code needs less.
  assert.ok(panelShare(1090, { fontSize: 14, minimap: false }) > 0)
})

test('a step beside an open panel: the code keeps 80 columns (the panel narrower, else the step card alone)', () => {
  const needPx = codeWidth(80, 14)
  const move = (total: number, panelPx: number, readerChose = false) =>
    codeRoomMove({ codePx: total - panelPx, needPx, share: panelShare(total, { fontSize: 14 }), readerChose })
  // A 1440 px window with the sidebar (~1090 px of editors), the panel at 40 %: no room for both, the card alone.
  assert.equal(move(1090, 436), 'cardOnly')
  // A wider window, the panel squeezing the code: the panel gets the share that leaves the code its columns.
  const wider = move(1300, 600)
  assert.ok(typeof wider === 'object' && 1300 * (1 - wider.share) >= needPx - 1, JSON.stringify(wider))
  // The code has its columns (a pixel short is rounding): nothing changes.
  assert.equal(move(1600, 1600 - needPx), 'keep')
  assert.equal(move(1600, 1600 - needPx + 1), 'keep')
  // The reader asked for the map's room: theirs to keep.
  assert.equal(move(1090, 436, true), 'keep')
})

test('the reader\'s width is kept (also above 40 %), within the code\'s 80 columns', () => {
  assert.equal(panelShare(2000, { fontSize: 14, remembered: 0.5 }), 0.5)
  assert.equal(panelShare(2000, { fontSize: 14, remembered: 0.25 }), 0.25)
  assert.ok(panelShare(1300, { fontSize: 14, remembered: 0.6 }) < MAX_SHARE)
  // A share dragged shut or over everything: the default.
  assert.equal(panelShare(2000, { fontSize: 14, remembered: 0.05 }), DEFAULT_SHARE)
  assert.equal(panelShare(2000, { fontSize: 14, remembered: 0.95 }), DEFAULT_SHARE)
})

test('while an episode is on the panel is 360–420 px wide, never more than half the editor area', () => {
  const px = (total: number) => Math.round(listeningShare(total) * total)
  // At the minimum, in between (the share), at the maximum, and half of a narrow area.
  assert.ok(Math.abs(px(1000) - LISTENING_MIN_PX) <= 1)
  const between = Math.round((LISTENING_MIN_PX + LISTENING_MAX_PX) / 2 / LISTENING_SHARE)
  assert.ok(Math.abs(px(between) - between * LISTENING_SHARE) <= 1)
  assert.ok(Math.abs(px(2400) - LISTENING_MAX_PX) <= 2)
  assert.ok(Math.abs(px(600) - 300) <= 1)
  assert.equal(listeningShare(0), 0)
})

test('a flat row of groups: side by side, none split', () => {
  assert.ok(isFlatRow({ orientation: 0, groups: [{ size: 1 }, { size: 2 }] }))
  assert.ok(!isFlatRow({ orientation: 1, groups: [{ size: 1 }, { size: 2 }] }))
  assert.ok(!isFlatRow({ orientation: 0, groups: [{ size: 1 }, { groups: [{ size: 1 }, { size: 1 }] }] }))
  assert.ok(isFlatRow({ orientation: 0, groups: [{ size: 1 }, { groups: [] }] }))
})

test('the widest other group, and room for the map taken from it', () => {
  assert.equal(widestOther([500, 200, 700], 2), 0)
  assert.equal(widestOther([500, 900, 700], 0), 1)
  assert.equal(widestOther([600, 600, 100], 2), 0, 'the first of equals')
  assert.equal(widestOther([300], 0), -1)
  assert.deepEqual(withRoomForMap([900, 200], 1), [900 - (MAP_ROOM_PX - 200), MAP_ROOM_PX])
  assert.equal(withRoomForMap([900, 400], 1), undefined, 'room enough already')
  assert.deepEqual(withRoomForMap([250, 350, 200], 2), [250, 300, 250], 'the other keeps the map\'s room itself')
  assert.equal(withRoomForMap([280, 200], 1), undefined, 'nothing to give')
  assert.equal(withRoomForMap([200], 0), undefined, 'no other group')
})

test('VS Code\'s expansion on focus: from its minimum, by more than a drag', () => {
  assert.ok(expandedOnFocus([900, GROUP_MIN_PX], [540, 580], 1))
  assert.ok(!expandedOnFocus([800, 320], [540, 580], 1), 'not at the minimum')
  assert.ok(!expandedOnFocus([900, GROUP_MIN_PX], [880, 240], 1), 'a small drag')
  assert.ok(!expandedOnFocus(undefined, [540, 580], 1))
  assert.ok(!expandedOnFocus([900, GROUP_MIN_PX, 300], [540, 580], 1), 'another layout')
  assert.ok(grownSince([900, 200], [700, 400], 1))
  assert.ok(!grownSince([900, 200], [850, 250], 1))
})

test('widths as layout shares', () => {
  assert.deepEqual(layoutOfWidths([300, 100]), { orientation: 0, groups: [{ size: 0.75 }, { size: 0.25 }] })
})
