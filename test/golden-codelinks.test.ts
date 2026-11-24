// Golden tests (test/README.md): the code links in a step's text, as read today, byte for byte.
import { test } from 'node:test'
import { expectGolden } from './golden'
import { parsed } from './goldenJourneys'
import { readLinks } from '../src/core/format/journeyModel'
import { codeLinkMarkup, linkPhrases, PH } from '../src/core/codeLinkText'

const AREA = 'journey'

test('golden: code links in each step of the shop journey, and their markup', () => {
  const j = parsed('shop-place-order')
  const out = j.steps.map((s) => {
    const links = readLinks(s.links)
    const used = new Set<number>()
    const lead = linkPhrases(s.lead, links, used, PH)
    const details = linkPhrases(s.details ?? '', links, used, PH)
    return { id: s.id, lead, details, unused: links.map((_, i) => i).filter((i) => !used.has(i)), markup: links.map((l, i) => codeLinkMarkup(`k|${s.id}`, i, l, l.phrase)) }
  })
  // A phrase inside a link or code, overlapping another, used before.
  const tricky = linkPhrases('See [the queue](x) and `the queue` then the queue and the queue job.', [
    { phrase: 'the queue', file: 'a', start: 1, end: 1, text: '' }, { phrase: 'queue job', file: 'b', start: 2, end: 3, text: '' }, { phrase: 'and', file: 'c', start: 1, end: 1, text: '' },
  ], new Set([2]), (i, p) => `<${i}:${p}>`)
  expectGolden(AREA, 'code-links', { steps: out, tricky, markupTint: codeLinkMarkup('k', 0, { file: 'a/b.ts', start: 4, end: 4 }, 'one  two', 'red', 'why') })
})
