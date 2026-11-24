// A step card's view and how the inline card and the map's card render it (src/tour/stepView.ts): pure, no vscode.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Journey, JStep } from '../src/core/format/journeyModel'
import type { StepAt } from '../src/journeys/steps'
import { cardMarkdown, commandRefLink, panelCardOf, panelRefLink, stepLabel, StepViewState, stepView } from '../src/tour/stepView'
import type { TextJourney } from '../src/tour/stepText'

const step = (n: number, o: Partial<JStep> = {}): JStep =>
  ({ id: `s${n}`, n, title: `Step ${n}`, node: 'n', file: 'src/a.ts', range: { start: 10 * n, end: 10 * n + 5 }, lead: '', refs: [], ...o })
function journey(steps: JStep[], at: Partial<StepAt>[] = []): TextJourney {
  return {
    folder: { uri: 'file:///w' },
    j: { title: 'J', steps } as Journey,
    at: steps.map((s, i) => ({ ...s.range, stale: false, ...at[i] })),
  }
}
const state = (o: Partial<StepViewState> = {}): StepViewState =>
  ({ renames: new Map(), refGone: new Set(), refLines: new Map(), detailsOpen: false, fileGone: false, nextIsQuestion: false, ...o })
const inline = (lj: TextJourney, n: number, o: Partial<StepViewState> = {}) => stepView(lj, n, state(o), (r) => commandRefLink('file:///w', n, r))
const md = (lj: TextJourney, n: number, o: Partial<StepViewState> = {}, tutorial: '' | 'card' | 'links' = '') =>
  cardMarkdown(inline(lj, n, o), { links: [], linkKey: 'k', tutorial }).body
const GAP = '   '

test('the card: the lead, then one row of buttons (Next, Ask; Previous after step 1; More when there are details)', () => {
  const lj = journey([step(1, { lead: 'Reads <config>.' }), step(2, { details: 'More words.' })])
  assert.equal(md(lj, 1), `Reads \\<config\\>.\n\n[Next ›](command:codeNotes.nextStep)${GAP}[Ask](command:codeNotes.askStep)`)
  assert.equal(md(lj, 2), [
    '[‹ Previous](command:codeNotes.previousStep)', '[Finish](command:codeNotes.nextStep)', '[Ask](command:codeNotes.askStep)',
    `[More](command:codeNotes.stepDetails?${encodeURIComponent('[true]')})`,
  ].join(GAP))
  assert.match(md(lj, 2, { detailsOpen: true }), /\[Less\]\(command:codeNotes\.stepDetails\?%5Bfalse%5D\)\n\nMore words\.$/)
  assert.match(md(lj, 1, { nextIsQuestion: true }), /\[Question ›\]/, "a check's tour: Next goes to its question")
})

test('a stale step: the banner first with its one Ask (the request once asked), and no second Ask in the row', () => {
  const lj = journey([step(1, { lead: 'L' })], [{ stale: true, removed: true }])
  const body = md(lj, 1)
  assert.equal(body.split('\n\n')[0], "**⚠ Code changed: can't find these lines** · [Ask](command:codeNotes.askStepUpdate)")
  assert.doesNotMatch(body, /codeNotes\.askStep\)/)
  const asked = md(lj, 1, { asked: { id: 'n1', text: '1 asked', update: true } })
  assert.match(asked, /^\*\*⚠ [^*]+\*\* · \[Asked ›\]\(command:codeNotes\.openNoteId\?%5B%22n1%22%5D\)/)
  assert.match(asked, /\[1 asked ›\]\(command:codeNotes\.openNoteId/, 'the questions are a button of the row')
  assert.match(md(journey([step(1)]), 1, { fileGone: true }), /^\*\*⚠ File moved or deleted\*\*/)
})

test("the tutorial's card about the card: its buttons on the highlight, built so; escaping the text leaves them alone", () => {
  const lj = journey([step(1, { lead: 'a <b>' })], [{ stale: true, was: 'x' }])
  const body = md(lj, 1, {}, 'card')
  const span = (label: string) => `<span style="color:var(--vscode-foreground);background-color:var(--vscode-editor-findMatchHighlightBackground);">${label}</span>`
  assert.ok(body.includes(`[${span('Ask')}](command:codeNotes.askStepUpdate)`), "the stale banner's Ask too")
  assert.ok(body.includes(`[${span('Finish')}](command:codeNotes.nextStep)`))
  assert.ok(body.includes('a \\<b\\>'), 'the text is still escaped')
  assert.equal(cardMarkdown(inline(lj, 1), { links: [], linkKey: 'k', tutorial: 'card' }).supportHtml, true)
  assert.equal(cardMarkdown(inline(lj, 1), { links: [], linkKey: 'k', tutorial: '' }).supportHtml, false)
})

test('a paused podcast: ▶ Play first in the row; a notice last; "See also" after the references', () => {
  const lj = journey([step(1, { lead: 'L' })])
  const v = stepView(lj, 1, state({ notice: 'It moved.', seeAlso: '[J2, step 3](command:x)' }), () => '')
  const body = cardMarkdown(v, { links: [], linkKey: 'k', tutorial: '', play: 'Play on' }).body
  assert.deepEqual(body.split('\n\n'), [
    'L',
    `[▶ Play](command:codeNotes.podcastToggle "Play on")${GAP}[Finish](command:codeNotes.nextStep)${GAP}[Ask](command:codeNotes.askStep)`,
    'See also: [J2, step 3](command:x)',
    '_ℹ It moved._',
  ])
})

test('references: a command link inline (the whole path its hover), `ref:i` with the file name on the map', () => {
  const lj = journey([step(1, { refs: ['src/c.ts:12-14', 'lib/b.ts:3'] })])
  const v = inline(lj, 1, { detailsOpen: true })
  const args = encodeURIComponent(JSON.stringify(['file:///w', 'src/c.ts', 12, 14, 1]))
  assert.ok(v.text.refs.startsWith(`[c.ts:12-14](command:codeNotes.openAt?${args} "src/c.ts:12-14")`))
  let i = 0
  const pv = stepView(lj, 1, state({ detailsOpen: true }), (r) => panelRefLink(r, i++))
  const card = panelCardOf(pv)
  assert.equal(card.refs, '[c.ts:12-14](ref:0) · [b.ts:3](ref:1)')
  assert.deepEqual(card.paths, ['src/c.ts:12-14', 'lib/b.ts:3'])
  assert.deepEqual(pv.refs.map((r) => r.file), ['src/c.ts', 'lib/b.ts'], 'the refs in order: the panel posts one back by index')
})

test("the map's card: the same view, its own Ask (`ask:update`, or the request asked as `note:`)", () => {
  const lj = journey([step(1, { lead: 'L', title: 'A <b> & c' })], [{ stale: true, removed: true }])
  const card = panelCardOf(stepView(lj, 1, state(), () => ''))
  assert.deepEqual(card, {
    n: 1, lead: 'L', refs: '', stale: true, staleText: "**⚠ Code changed: can't find these lines** · [Ask](ask:update)",
    open: false, title: 'A <b> & c', paths: [],
  })
  const asked = panelCardOf(stepView(lj, 1, state({ asked: { id: 'n9', text: '1 asked', update: true } }), () => ''))
  assert.match(asked.staleText, /· \[Asked ›\]\(note:n9\)$/)
  assert.equal(stepLabel(lj, 1), '1/1 · A ‹b› ＆ c', 'the header: look-alikes for what a thread label would escape')
})
