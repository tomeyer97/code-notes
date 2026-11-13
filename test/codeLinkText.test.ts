import test from 'node:test'
import assert from 'node:assert/strict'
import { linkPhrases, readLinks } from '../src/codeLinkText'

const L = (phrase: string) => ({ phrase, file: 'a.go', start: 1, end: 1, text: '' })

test('linkPhrases: first free occurrence, never inside a link or code, each phrase once across texts', () => {
  const used = new Set<number>()
  const make = (i: number, p: string) => `<${i}:${p}>`
  assert.equal(linkPhrases('It settles the key and refuses the run.', [L('settles the key'), L('refuses the run')], used, make), 'It <0:settles the key> and <1:refuses the run>.')
  assert.equal(linkPhrases('It settles the key again.', [L('settles the key')], used, make), 'It settles the key again.', 'already used in the lead')
  assert.equal(linkPhrases('See [the run](x.go:1) and `the run`; the run is stored.', [L('the run')], new Set(), make), 'See [the run](x.go:1) and `the run`; <0:the run> is stored.')
  assert.equal(linkPhrases('stores the run', [L('stores the run'), L('the run')], new Set(), make), '<0:stores the run>', 'overlapping phrases: the first wins')
  assert.equal(linkPhrases('nothing here', [L('absent')], new Set(), make), 'nothing here')
})

test('readLinks: bad entries dropped, end defaults to start', () => {
  assert.deepEqual(readLinks([{ phrase: ' a ', file: 'f.go', start: 3 }, { phrase: '', file: 'f.go', start: 1 }, { phrase: 'b', start: 1 }, null]), [{ phrase: 'a', file: 'f.go', start: 3, end: 3, text: '' }])
  assert.deepEqual(readLinks(undefined), [])
})
