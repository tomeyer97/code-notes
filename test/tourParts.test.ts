// The tour's small pure parts: the line-suffix grammar (src/core/lineSuffix.ts), a title as a link label, a step link's
// arguments and what kind of note was asked from a step (src/tour/texts.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatLineSuffix, LINE_SUFFIX_PLAIN, lineSuffixOf } from '../src/core/lineSuffix'
import { mdLabel } from '../src/core/mdLabel'
import type { Note } from '../src/notes/store'
import { openStepLinkArgs, stepLink } from '../src/tour/stepLink'
import { aboutStepLine, isUpdateRequest, UPDATE_ASK, UPDATE_REQUEST } from '../src/tour/texts'

test('line suffix: `:a`, `:a-b` (either dash kept), `#La`, at the end of a path; none elsewhere', () => {
  assert.deepEqual(lineSuffixOf('src/a.ts:12'), { index: 8, line: 12, hash: false })
  assert.deepEqual(lineSuffixOf('src/a.ts:12–14'), { index: 8, line: 12, end: 14, dash: '–', hash: false })
  assert.deepEqual(lineSuffixOf('a.ts#L7'), { index: 4, line: 7, hash: true })
  assert.equal(lineSuffixOf('src/a.ts'), undefined)
  assert.equal(lineSuffixOf('src/a.ts:12 more'), undefined)
  assert.equal(lineSuffixOf('a:1:2')?.index, 3, 'the last one: the path may hold a colon')
  for (const s of [':12', ':12-14', ':12–14', '#L7']) assert.equal(formatLineSuffix(lineSuffixOf(`a.ts${s}`)!), s)
  assert.ok(new RegExp(`^${LINE_SUFFIX_PLAIN}$`).test(':3-4'), 'the same grammar, to embed')
})

test('a title as a link label: its brackets go', () => {
  assert.equal(mdLabel('Orders [v2] and [x]'), 'Orders v2 and x')
})

test("a step link's arguments in openStepLink's order", () => {
  const s = { journey: 'j', step: 's3', n: 3, folder: 'file:///w' }
  assert.deepEqual(openStepLinkArgs(s), ['j', 's3', 3, 'file:///w'])
  assert.equal(stepLink('J, step 3', s), `[J, step 3](command:codeNotes.openStepLink?${encodeURIComponent('["j","s3",3,"file:///w"]')})`)
})

test('an update request is known by its link (`kind`); older notes without one by the words they start with', () => {
  const note = (body: string, journey?: object) => ({ data: { messages: [{ body }], ...(journey ? { extra: { journey } } : {}) } }) as unknown as Note
  const link = { id: 'j', step: 's1', n: 1 }
  assert.equal(isUpdateRequest(note('Where did it go?', { ...link, kind: UPDATE_REQUEST })), true, 'whatever the words')
  assert.equal(isUpdateRequest(note(`${UPDATE_ASK} More.`, { ...link, kind: 'other' })), false, 'the kind decides')
  assert.equal(isUpdateRequest(note(`${UPDATE_ASK} More.`, link)), true, 'an older note: by its words')
  assert.equal(isUpdateRequest(note('How does this work?', link)), false)
})

test("a question's line naming its step: by title and id, and its journey", () => {
  assert.equal(aboutStepLine('Read it', 's3', 'Start-up'), '_About the step “Read it” (id `s3`) of the journey “Start-up”_')
})
