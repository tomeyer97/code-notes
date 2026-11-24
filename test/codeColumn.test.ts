// The code group's rule for an editor already on screen (src/journeys/codeColumn.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shownOutside } from '../src/journeys/codeColumn'

const editor = (uri: string, viewColumn?: number) => ({ document: { uri }, viewColumn })

test('shownOutside: the editor on the file, never the one in the map\'s group', () => {
  const inMap = editor('file:///w/a.ts', 2), beside = editor('file:///w/a.ts', 1), other = editor('file:///w/b.ts', 1)
  assert.equal(shownOutside([inMap, beside, other], 'file:///w/a.ts', 2), beside)
  assert.equal(shownOutside([inMap, other], 'file:///w/a.ts', 2), undefined, 'only in the map\'s group: none')
  assert.equal(shownOutside([inMap, other], 'file:///w/a.ts', undefined), inMap, 'no map: any group')
  assert.equal(shownOutside([editor('file:///w/a.ts')], 'file:///w/a.ts', 2), undefined, 'a map, and no group known: none')
})
