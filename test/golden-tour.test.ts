// Golden tests (test/README.md): each step card's text as the tour writes it today, byte for byte.
import { test } from 'node:test'
import { expectGolden } from './golden'
import { FIXTURES, parsed } from './goldenJourneys'
import { Journey } from '../src/core/format/journeyModel'
import { refFiles, staleText, stepText, StepRef, StepTextInput, TextJourney } from '../src/tour/stepText'
import { StepAt, writtenAt } from '../src/journeys/steps'

const AREA = 'journey'

const loaded = (j: Journey, at?: StepAt[]): TextJourney => ({ folder: { uri: { toString: () => 'file:///w' } }, j, at: at ?? writtenAt(j) })
const cardLink = (r: StepRef) => `[${r.label}](${r.file}:${r.line}-${r.end}${r.gone ? ' gone' : ''}${r.stale ? ' stale' : ''})`
const noFacts = (o: Partial<StepTextInput> = {}): StepTextInput => ({ renames: new Map(), refGone: new Set(), refLines: new Map(), detailsOpen: false, ...o })

test('golden: each step card\'s text, as written, moved, stale, with renames and gone files', () => {
  for (const name of Object.keys(FIXTURES)) {
    const j = parsed(name)
    const cards = j.steps.map((s, i) => {
      const n = i + 1
      const files = [...refFiles(s)]
      const moved = writtenAt(j).map((a) => ({ ...a, start: a.start + 3, end: a.end + 3 }))
      const stale = writtenAt(j).map((a) => ({ ...a, stale: true, was: 'old' }))
      const removed = writtenAt(j).map((a) => ({ ...a, stale: true, removed: true }))
      // The first file a step names, renamed; the second gone; the third only 5 lines long.
      const facts = noFacts({
        detailsOpen: true,
        renames: new Map(files.slice(0, 1).map((f) => [f, `moved/${f.split('/').pop()}`])),
        refGone: new Set(files.slice(1, 2).map((f) => `file:///w|${f}`)),
        refLines: new Map(files.slice(2, 3).map((f) => [`file:///w|${f}`, 5])),
      })
      return {
        id: s.id, files,
        written: stepText(loaded(j), n, cardLink, noFacts()),
        movedDown3: stepText(loaded(j, moved), n, cardLink, noFacts()),
        detailsOpenWithFacts: stepText(loaded(j), n, cardLink, facts),
        stale: stepText(loaded(j, stale), n, cardLink, noFacts()),
        staleBanner: [staleText(loaded(j, stale), n, 'Ask to refresh', false), staleText(loaded(j, removed), n, 'Ask', false), staleText(loaded(j), n, 'Ask', true), staleText(loaded(j), n, 'Ask', false)],
      }
    })
    expectGolden(AREA, `step-text.${name}`, cards)
  }
})
