// A podcast file no journey reads (src/podcast/strayLine.ts): what the output says about it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { strayLine } from '../src/podcast/strayLine'

const ids = new Map([['place-order', 'place-order.podcast.json']])
const why = 'ignored: a podcast plays next to its journey, named <journey>.podcast.json, and there is no'

test('a stray podcast: why it isn\'t played, and the journey it names (whose podcast that journey has, or none)', () => {
  const pod = (id: unknown) => JSON.stringify({ version: 1, journey: { id }, audio: 'a.mp3', segments: [] })
  assert.equal(strayLine('/r/journeys/order.podcast.json', pod('place-order'), ids),
    `podcast /r/journeys/order.podcast.json: ${why} order.json; its journey.id is "place-order" (whose podcast is place-order.podcast.json)`)
  assert.equal(strayLine('/r/journeys/x.podcast.json', pod('gone'), ids),
    `podcast /r/journeys/x.podcast.json: ${why} x.json; its journey.id is "gone", and no journey here has that id`)
  // Another version still names its journey; no id, not JSON, not read: said without it.
  assert.match(strayLine('/r/x.podcast.json', JSON.stringify({ version: 2, journey: { id: 'gone' } }), ids), /its journey.id is "gone"/)
  for (const raw of [pod(3), '{', undefined]) assert.equal(strayLine('/r/x.podcast.json', raw, ids), `podcast /r/x.podcast.json: ${why} x.json`)
})
