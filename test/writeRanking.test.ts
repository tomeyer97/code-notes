// Which journeys answer a question (src/write/ranking.ts): the same question or title first, else the close ones.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLOSE_ENOUGH, MAX_CHOICES, matchJourneys, rankJourneys } from '../src/write/ranking'

const j = (id: string, title: string, question: string, steps: string[] = []) =>
  ({ item: id, text: { title, question, summary: '', steps } })

const all = [
  j('save', 'Saving a note', 'How is a note saved?', ['the store writes the file', 'the anchor is kept']),
  j('load', 'Loading notes', 'How are notes loaded?', ['the store reads the folder']),
  j('tour', 'The tour', 'How does the tour walk the steps?', ['the walk moves', 'the card shows']),
]

test('the same question or title is the one answer, whatever the case and punctuation', () => {
  assert.deepEqual(matchJourneys(all, 'how is a NOTE saved'), ['save'])
  assert.deepEqual(matchJourneys(all, 'The tour!'), ['tour'])
})

test('ranked by words matched; nothing matched, nothing ranked', () => {
  assert.deepEqual(rankJourneys(all, 'where does the tour walk').map((v) => v.item)[0], 'tour')
  assert.deepEqual(rankJourneys(all, 'quantum flux'), [])
  assert.deepEqual(matchJourneys(all, 'quantum flux'), [])
})

test('only close ones are offered, at most MAX_CHOICES', () => {
  assert.ok(CLOSE_ENOUGH > 0 && CLOSE_ENOUGH < 1)
  const many = Array.from({ length: 6 }, (_, i) => j(`n${i}`, `Notes ${i}`, 'How are notes stored on disk?'))
  assert.equal(matchJourneys(many, 'where are notes stored on disk').length, MAX_CHOICES)
})
