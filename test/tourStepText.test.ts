// What a step card's text says today (lead, details, references, the stale banner): pinned before stepText is rewritten.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'
import { Journey, JStep, parseJourney } from '../src/journeyModel'
import { parseBare, refFiles, StepRef, StepTextInput, TextJourney, staleText, stepText } from '../src/tour/stepText'
import type { StepAt } from '../src/journeys/steps'

/** Each link as `[label](file:line-end)`: what the card would link, in one string. */
const link = (r: StepRef) => `[${r.label}](${r.file}:${r.line}-${r.end})`
/** One step in `src/a.ts`, written at lines 10-20; `at`: where it is found now. */
function one(step: Partial<JStep>, at: Partial<StepAt> = {}): TextJourney {
  const s: JStep = { id: 's1', n: 1, title: 'T', node: 'n', file: 'src/a.ts', range: { start: 10, end: 20 }, lead: '', refs: [], ...step }
  return { folder: { uri: 'file:///w' }, j: { steps: [s] } as Journey, at: [{ start: 10, end: 20, stale: false, ...at }] }
}
const input = (o: Partial<StepTextInput> = {}): StepTextInput => ({ renames: new Map(), refGone: new Set(), refLines: new Map(), detailsOpen: false, ...o })
const text = (lj: TextJourney, o: Partial<StepTextInput> = {}) => stepText(lj, 1, link, input(o))

test('a ref into the step\'s own file moves with the step (delta); one into another file does not', () => {
  const t = text(one({ refs: ['src/a.ts:40', 'src/a.ts:40-42', 'lib/b.ts:7'] }, { start: 15, end: 25 }))
  assert.equal(t.refs, '[a.ts:45](src/a.ts:45-45) · [a.ts:45-47](src/a.ts:45-47) · [b.ts:7](lib/b.ts:7-7)')
  assert.equal(t.stale, false)
})

test('paths in the lead and in sentence refs become links reading the file name; shifted the same way', () => {
  const t = text(one({ lead: 'See src/a.ts:30 and `lib/b.ts:3`.', refs: ['Done in src/a.ts:40-42.', 'Also lib/b.ts#L7 here.', 'Hash src/a.ts#L40 here.'] }, { start: 15, end: 25 }))
  assert.equal(t.lead, 'See [a.ts:35](src/a.ts:35-35) and [b.ts:3](lib/b.ts:3-3).')
  assert.equal(t.refs, 'Done in [a.ts:45-47](src/a.ts:45-47).\n\nAlso [b.ts#L7](lib/b.ts:7-7) here.\n\nHash [a.ts#L40](src/a.ts:45-45) here.')
})

test('a renamed file: the link follows it and says "(moved)"', () => {
  const t = text(one({ refs: ['old/x.ts:5', 'Sentence old/x.ts:5-6 ok.'] }), { renames: new Map([['old/x.ts', 'new/y.ts']]) })
  assert.equal(t.refs, '[y.ts:5 (moved)](new/y.ts:5-5)\n\nSentence [y.ts:5-6 (moved)](new/y.ts:5-6) ok.')
  // The step's own file renamed: same file, so no delta and no own-range dedupe by the old name's lines past it.
  const own = text(one({ refs: ['src/a.ts:40'] }, { file: 'src/z.ts' }), { renames: new Map([['src/a.ts', 'src/z.ts']]) })
  assert.equal(own.refs, '[z.ts:40 (moved)](src/z.ts:40-40)')
})

test('a file that is gone, or a line past its end: struck out, not a dead link', () => {
  const t = text(one({ refs: ['lib/c.ts:3', 'In lib/c.ts:3 here.', 'lib/d.ts:50', 'lib/d.ts:5'] }),
    { refGone: new Set(['file:///w|lib/c.ts']), refLines: new Map([['file:///w|lib/d.ts', 10]]) })
  assert.equal(t.refs, '~~c.ts:3~~ (file gone) · ~~d.ts:50~~ (line gone) · [d.ts:5](lib/d.ts:5-5)\n\nIn ~~c.ts:3~~ (file gone) here.')
})

test('a stale step: no delta, and its own lines dedupe nothing', () => {
  const t = text(one({ refs: ['src/a.ts:40', 'src/a.ts:12'] }, { start: 15, end: 25, stale: true, was: 'x' }))
  assert.equal(t.refs, '[a.ts:40](src/a.ts:40-40) · [a.ts:12](src/a.ts:12-12)')
  assert.equal(t.stale, true)
})

test('bare refs are joined with " · "; one without a line goes to line 1', () => {
  const t = text(one({ refs: ['lib/b.ts:7', 'lib/c.ts', 'lib/e.ts#L9'] }))
  assert.equal(t.refs, '[b.ts:7](lib/b.ts:7-7) · [c.ts](lib/c.ts:1-1) · [e.ts#L9](lib/e.ts:9-9)')
})

test('a bare `#L` ref names its file and line: the file checked is the path without `#L`', () => {
  assert.deepEqual(parseBare('lib/e.ts#L9'), { text: 'e.ts#L9', file: 'lib/e.ts', line: 9 })
  assert.deepEqual([...refFiles({ refs: ['lib/e.ts#L9'], lead: '', details: '' })], ['lib/e.ts'])
})

test('a bare range ref reads as its range', () => {
  assert.deepEqual(parseBare('a/b.ts:40-42'), { text: 'b.ts:40-42', file: 'a/b.ts', line: 40, end: 42 })
  assert.equal(text(one({ refs: ['lib/b.ts:40-42'] })).refs, '[b.ts:40-42](lib/b.ts:40-42)')
})

const deduped: Partial<JStep> = {
  refs: ['lib/b.ts:7', 'lib/c.ts:12', 'src/a.ts:12', 'src/a.ts:30', 'In lib/b.ts:7 too.', 'In lib/f.ts:3 too.'],
  lead: 'It parks the run.',
  details: 'Then lib/b.ts:7 does more.',
  links: [{ phrase: 'parks the run', file: 'lib/c.ts', start: 10, end: 15, text: '' }, { phrase: 'absent phrase', file: 'lib/f.ts', start: 1, end: 9, text: '' }],
}

test('refs already on screen are not listed: inside a code link\'s lines, or inside the step\'s own lines', () => {
  const t = text(one(deduped))
  assert.equal(t.lead, 'It parks the run.')
  assert.equal(t.details, 'Then [b.ts:7](lib/b.ts:7-7) does more.')
  assert.equal(t.refs, '[b.ts:7](lib/b.ts:7-7) · [a.ts:30](src/a.ts:30-30)\n\nIn [b.ts:7](lib/b.ts:7-7) too.\n\nIn [f.ts:3](lib/f.ts:3-3) too.')
})

test('with the details open, refs they already link are not listed again', () => {
  const t = text(one(deduped), { detailsOpen: true })
  assert.equal(t.details, 'Then [b.ts:7](lib/b.ts:7-7) does more.')
  assert.equal(t.refs, '[a.ts:30](src/a.ts:30-30)\n\nIn [f.ts:3](lib/f.ts:3-3) too.')
})

test('"(path:line)" asides are dropped from the details; other paths there become links', () => {
  const t = text(one({ details: 'It stores (`lib/b.ts:7`) the row (b.ts:3) and (lib/c.ts#L4) here (lib/d.ts:1-2).\nNext src/a.ts:12.' }, { start: 15, end: 25 }))
  assert.equal(t.details, 'It stores the row and here.\nNext [a.ts:17](src/a.ts:17-17).')
  assert.equal(t.refs, '')
})

test('the link callback gets where the ref goes now, never marked gone or stale', () => {
  const got: StepRef[] = []
  stepText(one({ refs: ['src/a.ts:40-42'] }, { start: 15, end: 25 }), 1, (r) => { got.push(r); return '' }, input())
  assert.deepEqual(got, [{ label: 'a.ts:45-47', file: 'src/a.ts', line: 45, end: 47, gone: false, stale: false }])
})

test('the stale banner: file gone, lines lost, or changed; nothing for a fresh step', () => {
  const st = (at: Partial<StepAt>, fileGone: boolean) => staleText(one({}, at), 1, 'ASK', fileGone)
  assert.equal(st({}, false), '')
  assert.equal(st({}, true), '**⚠ File moved or deleted** · ASK')
  assert.equal(st({ stale: true }, false), '**⚠ Code changed: can\'t find these lines** · ASK')
  assert.equal(st({ stale: true, was: 'w' }, false), '**⚠ Code changed** · ASK')
  assert.equal(st({ stale: true, was: 'w', removed: true }, false), '**⚠ Code changed: can\'t find these lines** · ASK')
})

test('the example journey: which refs are listed, as today', () => {
  const j = parseJourney(fs.readFileSync(path.join(__dirname, '../../test/fixtures/journey/journeys/place-order.json'), 'utf8'), 'place-order') as Journey
  const lj: TextJourney = { folder: { uri: 'file:///w' }, j, at: j.steps.map((s) => ({ ...s.range, stale: false })) }
  const closed = stepText(lj, 1, link, input()), open = stepText(lj, 1, link, input({ detailsOpen: true }))
  assert.equal(closed.lead, 'The Place order button ([Checkout.vue:30](web/src/checkout/Checkout.vue:30-30)) lands here; nothing is charged in the browser.')
  // placeOrder.ts:33 is inside the step's own lines; the lead linking Checkout.vue:30 does not drop that ref.
  assert.equal(closed.refs, '[Checkout.vue:30](web/src/checkout/Checkout.vue:30-30)')
  assert.equal(open.refs, closed.refs)
  assert.equal(stepText(lj, 6, link, input()).refs, '', 'its one ref is inside its own lines')
})
