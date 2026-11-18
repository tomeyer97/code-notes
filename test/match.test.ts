import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchScore, queryWords, scoreJourney, stem, tellingWords, STOP } from '../src/match'
import { items } from './fixtures/journeyList'

// ---------- the Journeys list's search (matchScore, queryWords) ----------

test('the list\'s search: every word must match; a title hit weighs more than a path hit', () => {
  const orders = items()[0]
  assert.equal(matchScore(orders, 'orders nothinglikethis').score, 0)
  assert.ok(matchScore(orders, 'orders').score > matchScore(orders, 'api').score, 'a title hit weighs more than a path hit')
})

test('a question typed into the search: stop-words left out (unless that is all there is), words stemmed alike', () => {
  assert.deepEqual(queryWords('how are charges retried'), ['charges', 'retried'])
  assert.deepEqual(queryWords('how does it'), ['how', 'does', 'it'], 'only stop-words: kept')
  assert.equal(stem('retried'), stem('retry'))
  assert.equal(stem('retries'), stem('retrying'))
  assert.equal(stem('charges'), stem('charge'))
})

// ---------- which journey answers a question (scoreJourney, tellingWords) ----------

test('a journey matches most of the telling words, with synonyms; title and question count most', () => {
  const j = { title: 'Change a shipping address', question: 'How does the shipping address of an order get updated?', summary: 'The address is updated without a new order.', steps: ['The page posts the new address'] }
  assert.deepEqual(tellingWords('How does the code work?'), [])
  assert.ok(scoreJourney(j, 'How do we change the address of an order?').answers, '"change" finds "update"')
  assert.ok(scoreJourney(j, 'How are shipping addresses updated?').answers)
  assert.ok(!scoreJourney(j, 'How are widgets frobnicated?').answers)
  const s = scoreJourney(j, 'How is an address deleted and billed?')
  assert.ok(!s.answers && s.matched === 1, 'one word of three is not enough')
  const head = scoreJourney(j, 'address'), tail = scoreJourney({ ...j, title: 'x', question: 'y?' }, 'address')
  assert.ok(head.weight > tail.weight, 'title/question weigh more than the summary')
})

test('light stems: plural, past and -ing endings go when four letters are left', () => {
  assert.equal(stem('environments'), 'environment')
  assert.equal(stem('versioned'), 'version')
  assert.equal(stem('running'), 'runn')
  assert.equal(stem('bus'), 'bus', 'too short to lose its s')
})

test('telling words: no stop words, stemmed, each once', () => {
  assert.ok(STOP.has('how') && STOP.has('work'))
  assert.deepEqual(tellingWords('How do environments and an environment work?'), ['environment'])
  assert.deepEqual(tellingWords('Where are certificates rotated?'), ['certificat', 'rotat'], '"-es" goes before "-s"')
})

test('one or two telling words must all match; no telling words answers nothing', () => {
  const j = { title: 'Certificate rotation', question: 'How are TLS certificates rotated?', summary: '', steps: [] }
  assert.ok(scoreJourney(j, 'certificates').answers)
  assert.ok(!scoreJourney(j, 'certificates billing').answers, 'one of two is not enough')
  const none = scoreJourney(j, 'How does it work?')
  assert.deepEqual([none.total, none.answers], [0, false])
})

test('a synonym counts a little less than the word itself', () => {
  const j = { title: 'Change an address', question: 'Where is it changed?', summary: '', steps: [] }
  assert.equal(scoreJourney(j, 'change').weight, 3)
  assert.ok(Math.abs(scoreJourney(j, 'update').weight - 2.4) < 1e-9, 'a synonym in the title: 3 × 0.8')
})
