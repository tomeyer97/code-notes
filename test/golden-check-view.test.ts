// Golden tests (test/README.md): the Check view's names and the messages its page may send, text split at code links,
// the thread texts it shows, as they are today.
import { test } from 'node:test'
import { expectGolden } from './golden'
import { ACTIONS, busyLabel, definedOnly, KIND_LABEL, linkParts, STATE_WORD } from '../src/check/viewModel'
import { CHECK_VIEW_REPORTS, CHECK_VIEW_REQUESTS } from '../src/check/viewMessages'
import { missingMessages, retryText, SAY_IT_BACK } from '../src/check/threadText'
import * as C from '../src/check/constants'

const AREA = 'check-model'

test('golden: the Check view\'s names, the messages its page sends, text at code links', () => {
  const links = [{ phrase: 'the lock' }, { phrase: 'unique key' }, { phrase: 'missing phrase' }, { phrase: 'the' }]
  expectGolden(AREA, 'view-names', {
    actions: ACTIONS, kinds: KIND_LABEL, states: STATE_WORD, requests: CHECK_VIEW_REQUESTS, reports: CHECK_VIEW_REPORTS,
    constants: C, sayItBack: SAY_IT_BACK,
    retry: [undefined, '', 'Not quite: look again.', 'Look at the lock.'].map((f) => retryText(f)),
    busy: [0, 999, 1000, 61_000, 3_600_000].map((ms) => busyLabel('Writing questions', 0, ms)),
    defined: definedOnly({ a: 1, b: undefined, c: null, d: '', e: false }),
    parts: ['Why is the lock taken before the unique key is checked?', 'No links here.', '', 'the the the'].map((t) => [t, linkParts(t, links)]),
    missing: [
      missingMessages([{ role: 'agent' }, { role: 'human' }], [{ role: 'agent', n: 1 }, { role: 'human', n: 2 }, { role: 'agent', n: 3 }]),
      missingMessages([], [{ n: 1 }, { role: 'human', n: 2 }]),
      missingMessages([{ role: 'agent' }, { role: 'agent' }, { role: 'agent' }], [{ role: 'agent', n: 1 }]),
    ],
  })
})
