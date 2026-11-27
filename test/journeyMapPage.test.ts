// The journey panel's pure parts (media/map/, media/placement.js): its markdown, the podcast's chapters by storyline
// row, what goes where at a width, and the "covers least" search. The page itself: test/journey-map/shoot.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageModule } from './pageModule'

type Rect = { left: number; top: number; right: number; bottom: number }
const { md, inline, mdBlock } = pageModule<{ md(s: string): string; inline(s: string): string; mdBlock(s: string): string }>('media/map/markdown.js')
const { chapterAt, rowsOf } = pageModule<{ chapterAt(ep: unknown, t: number): { i: number; part: string; key: string }; rowsOf(ep: unknown): any }>('media/map/episode.js')
const { layout } = pageModule<{ layout(o: Record<string, unknown>): { wide: boolean; hasMap: boolean; anim: boolean; shown: boolean } }>('media/map/layout.js')
const { placeLeastCovering } = pageModule<{ placeLeastCovering<C extends Rect>(cs: C[], obstacles: (Rect & { weight?: number })[], o?: { cost?: (c: C) => number; stopWhenClear?: boolean }): C | undefined }>('media/placement.js')

test('markdown: escaped first, then `code` and **bold** (each one pass: bold inside code too)', () => {
  assert.equal(md('a <b> & "c"'), 'a &lt;b&gt; &amp; &quot;c&quot;')
  assert.equal(md('`x` and **y**'), '<code>x</code> and <b>y</b>')
  assert.equal(md('`a**b**c`'), '<code>a<b>b</b>c</code>')
  assert.equal(md('**a `b` c**'), '<b>a <code>b</code> c</b>')
})

test('markdown: the links a step card posts back, and ~~gone~~', () => {
  assert.equal(inline('see [a.go:1](ref:0)'), 'see <button class="ref link" data-i="0">a.go:1</button>')
  assert.equal(inline('[why?](note:n-1.2)'), '<button class="noteq link" data-id="n-1.2">why?</button>')
  assert.equal(inline('[Ask](ask:update)'), '<button class="askupd link">Ask</button>')
  assert.equal(inline('~~b.go:2~~ (file gone)'), '<s>b.go:2</s> (file gone)')
  // A link's text is escaped like the rest; a link elsewhere stays text.
  assert.equal(inline('[<x>](ref:2) [y](https://e)'), '<button class="ref link" data-i="2">&lt;x&gt;</button> [y](https://e)')
})

test('markdown blocks: paragraphs, line breaks, lists, rules, fenced code (a diff coloured)', () => {
  assert.equal(mdBlock('one\ntwo\n\nthree'), '<p>one<br>two</p><p>three</p>')
  assert.equal(mdBlock('- a\n* **b**'), '<ul><li>a</li><li><b>b</b></li></ul>')
  assert.equal(mdBlock('a\n\n---\n\nb'), '<p>a</p><hr><p>b</p>')
  assert.equal(mdBlock('```diff\n-old <a>\n+new\n same\n```'),
    '<pre class="code"><span class="del">-old &lt;a&gt;</span>\n<span class="ins">+new</span>\n<span class=""> same</span></pre>')
  // A fence's blank lines don't split it into paragraphs; its text is not marked up.
  assert.equal(mdBlock('```\nx\n\n**y**\n```'), '<pre class="code"><span class="">x</span>\n<span class=""></span>\n<span class="">**y**</span></pre>')
})

const episode = {
  chapters: [
    { start: 0, end: 10 }, // intro
    { start: 10, end: 20, step: 1 },
    { start: 20, end: 25 }, // a map part after step 1
    { start: 25, end: 30, step: 2 },
    { start: 30, end: 33, step: 1 }, // step 1 again
    { start: 33, end: 40 }, // recap
  ],
  segments: [
    { start: 0, end: 10, text: 'hi' },
    { start: 10, end: 20, text: 'one' },
    { start: 19.9995, end: 25, text: 'map' },
    { start: 25, end: 30, text: 'two' },
    { start: 30, end: 33, text: 'one again' },
    { start: 33, end: 40, text: 'bye' },
  ],
}

test('chapterAt: the chapter of a time, its part of the map and its storyline row', () => {
  assert.deepEqual(chapterAt(episode, 0), { i: 0, part: 'intro', key: 'intro' })
  assert.deepEqual(chapterAt(episode, 12), { i: 1, part: 'map', key: 's1' })
  assert.deepEqual(chapterAt(episode, 22), { i: 2, part: 'map', key: 'map2' })
  assert.deepEqual(chapterAt(episode, 31), { i: 4, part: 'map', key: 's1' })
  assert.deepEqual(chapterAt(episode, 99), { i: 5, part: 'recap', key: 'recap' })
  assert.deepEqual(chapterAt({ chapters: [], segments: [] }, 3), { i: 0, part: 'intro', key: '' })
  assert.deepEqual(chapterAt(undefined, 3), { i: 0, part: 'intro', key: '' })
})

test('rowsOf: a step said twice is one row; map parts after the step they follow; the intro and the recap', () => {
  const rows = rowsOf(episode)
  assert.equal(rows.intro.key, 'intro')
  assert.equal(rows.recap.key, 'recap')
  assert.deepEqual(rows.steps.get(1).segs.map((s: { text: string }) => s.text), ['one', 'one again'])
  assert.equal(rows.steps.get(1).end, 33)
  // A segment a hair before its chapter's start belongs to it.
  assert.deepEqual(rows.after.get(1).map((m: { key: string; segs: { text: string }[] }) => [m.key, m.segs.map((s) => s.text)]), [['map2', ['map']]])
  assert.equal(rowsOf({ chapters: [], segments: [] }), undefined)
  assert.equal(rowsOf(undefined), undefined)
})

const at = (o: Record<string, unknown>) => layout({ panelW: 1200, animReady: false, tutorialUp: false, deleted: false, mapShut: false, hasSteps: true, boxOnly: false, ...o })

test('layout: the map beside the storyline when wide, above it (foldable) when narrow, none when too narrow', () => {
  assert.deepEqual(at({}), { wide: true, hasMap: true, anim: false, shown: true })
  assert.deepEqual(at({ panelW: 500 }), { wide: false, hasMap: true, anim: false, shown: true })
  assert.deepEqual(at({ panelW: 500, mapShut: true }), { wide: false, hasMap: true, anim: false, shown: false })
  // Folded by hand, but shown while the tutorial points at it or the journey has no steps.
  assert.equal(at({ panelW: 500, mapShut: true, tutorialUp: true }).shown, true)
  assert.equal(at({ panelW: 500, mapShut: true, hasSteps: false }).shown, true)
  assert.deepEqual(at({ panelW: 200 }), { wide: false, hasMap: false, anim: false, shown: false })
  assert.equal(at({ panelW: 200, tutorialUp: true }).shown, true)
})

test('layout: the animation in place of the map, beside the storyline only when both fit; never under the tutorial', () => {
  assert.deepEqual(at({ animReady: true }), { wide: true, hasMap: true, anim: true, shown: true })
  assert.deepEqual(at({ animReady: true, panelW: 600 }), { wide: false, hasMap: true, anim: true, shown: true })
  assert.equal(at({ animReady: true, panelW: 600, mapShut: true }).shown, true)
  assert.equal(at({ animReady: true, tutorialUp: true }).anim, false)
  assert.equal(at({ animReady: true, deleted: true }).anim, false)
})

test('layout: while an episode plays, the box alone (the animation when it is on)', () => {
  assert.deepEqual(at({ boxOnly: true }), { wide: false, hasMap: true, anim: false, shown: true })
  assert.deepEqual(at({ boxOnly: true, animReady: true, mapShut: true }), { wide: false, hasMap: true, anim: true, shown: true })
  assert.deepEqual(at({ boxOnly: true, panelW: 200 }), { wide: false, hasMap: false, anim: false, shown: false })
})

const box = (left: number, top: number, w = 10, h = 10) => ({ left, top, right: left + w, bottom: top + h })

test('placeLeastCovering: the candidate covering least (weighted), the first on a tie, its own cost added', () => {
  const a = box(0, 0), b = box(20, 0), c = box(40, 0)
  const obstacles = [{ ...box(0, 0, 25, 10) }, { ...box(40, 0), weight: 0.1 }]
  assert.equal(placeLeastCovering([a, b, c], obstacles), c)
  assert.equal(placeLeastCovering([a, b, c], obstacles, { cost: (x) => (x === c ? 1000 : 0) }), b)
  assert.equal(placeLeastCovering([a, b], []), a)
  assert.equal(placeLeastCovering([], obstacles), undefined)
})

test('placeLeastCovering: with stopWhenClear, the first candidate that covers nothing ends the search', () => {
  const tried: Rect[] = []
  const cs = [box(0, 0), box(50, 0), box(60, 0)]
  const best = placeLeastCovering(cs, [box(0, 0)], { cost: (x) => { tried.push(x); return x === cs[1] ? 5 : 0 }, stopWhenClear: true })
  assert.equal(best, cs[1])
  assert.equal(tried.length, 2)
})
