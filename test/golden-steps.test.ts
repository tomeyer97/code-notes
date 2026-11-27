// Golden tests (test/README.md): the paths in a step's text, and where a step's code is found (the shop's journey on
// the shop's code), as today, byte for byte.
import { test } from 'node:test'
import { expectGolden } from './golden'
import { parsed, read } from './goldenJourneys'
import { capValue, linkPaths } from '../src/journeys/textFormat'
import { escapeTags } from '../src/core/escape'
import { dropAsides, refsIn, shortPaths } from '../src/tour/stepText'
import { captureStepAnchor, placeStep, StepAt } from '../src/journeys/steps'

const AREA = 'journey'

/** Text with the paths steps name: links, asides, tags, code. */
const TEXTS = [
  'See api/orders.go:12 and `web/src/a.ts:3-5`, also (worker/w.go#L9) and [x](api/orders.go:3).',
  'A <name> and <id> outside `code <x>` and ```\n<block>\n```, \\<kept\\>.',
  'Asides go (orders.go:12) here (`api/a.ts:3–4`) but not (see orders.go).',
  'No paths at all: README, a.ts, ./x/y.js:3 and ../z/w.ts:4 and dir/file.tsx#L10.',
]

test('golden: paths in step text: linked, shortened, asides dropped, tags escaped', () => {
  const link = (text: string, file: string, line: number) => `{${text}|${file}|${line}}`
  expectGolden(AREA, 'text-format', TEXTS.map((t) => ({
    in: t, linked: linkPaths(t, link), short: shortPaths(t), noAsides: dropAsides(t), escaped: escapeTags(t), refs: refsIn(t),
  })).concat([{ capped: ['', 'short', 'x'.repeat(40), `${'y'.repeat(38)}  tail`, 'z'.repeat(41)].map((v) => capValue(v)) } as never]))
})

// ---------- where a step's code is found (the shop's journey on the shop's code) ----------

test('golden: the shop journey\'s steps placed in their code: as is, moved, edited, removed', () => {
  const j = parsed('shop-place-order')
  const shop = (f: string) => read(`examples/shop/${f}`).split('\n')
  const out = j.steps.map((s) => {
    const lines = shop(s.file)
    const was: StepAt = { ...s.range, stale: false }
    const a = s.anchor ?? captureStepAnchor(lines, s.range)
    const shifted = ['// one', '// two', '// three', ...lines]
    const edited = lines.map((l, i) => (i === s.range.start ? `${l} // edited` : l))
    const removed = [...lines.slice(0, s.range.start - 1), ...lines.slice(s.range.end)]
    return {
      id: s.id, file: s.file, range: s.range,
      captured: captureStepAnchor(lines, s.range),
      asIs: placeStep(lines, a, was, {}),
      moved: placeStep(shifted, a, was, { file: 'renamed.js' }),
      edited: placeStep(edited, a, was, {}),
      removed: placeStep(removed, a, was, {}),
    }
  })
  expectGolden(AREA, 'placed.shop-place-order', out)
})
