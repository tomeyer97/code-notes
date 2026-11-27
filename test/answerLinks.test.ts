import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ANSWER_LINK_PATTERNS, linkify } from '../src/core/linkifyAnswer'
import { linkTarget } from '../src/core/linkUri'

const link = (t: string, f: string, l?: string) => `[${t}](cmd:${f}:${l ?? 1})`

test('references in answers are links, inside parentheses and lists, never with the home path', () => {
  const L = (s: string) => linkify(s, '/home/me/repo', '/home/me', link)
  assert.equal(L('see (src/a.ts:12)'), 'see ([src/a.ts:12](cmd:src/a.ts:12))')
  assert.equal(L('- `src/a.ts:3`'), '- [`src/a.ts:3`](cmd:src/a.ts:3)')
  assert.equal(L('in /home/me/repo/src/a.ts:7 here'), 'in [src/a.ts:7](cmd:src/a.ts:7) here')
  assert.equal(L('([a.ts:7](/home/me/repo/src/a.ts:7))'), '([a.ts:7](cmd:src/a.ts:7))')
  assert.equal(L('[`src/x.ts:3`](src/x.ts:3)'), '[`src/x.ts:3`](cmd:src/x.ts:3)', 'no link nested in a link label')
  assert.equal(L('[x](src/x.ts#L4)'), '[x](cmd:src/x.ts:4)')
  assert.equal(L('lines src/a.ts:12-20.'), 'lines [src/a.ts:12-20](cmd:src/a.ts:12).')
  assert.equal(L('outside /home/me/other/b.ts:2'), 'outside ~/other/b.ts:2', 'outside the repo: no link, no home path')
  assert.equal(L('[docs](https://example.com/a/b.md:3)'), '[docs](https://example.com/a/b.md:3)')
  assert.equal(L('![shot](img/a.png)'), '[image: shot](img/a.png)')
})

test('a relative Markdown link without a line opens the file; its title is dropped', () => {
  const L = (s: string) => linkify(s, '/r', '/h', link)
  assert.equal(L('[a](./src/a.ts)'), '[a](cmd:src/a.ts:1)')
  assert.equal(L('[x](src/a.ts:5 "the title")'), '[x](cmd:src/a.ts:5)')
})

test('links that are not files stay as written: anchors, home paths, other schemes', () => {
  const L = (s: string) => linkify(s, '/r', '/h', link)
  assert.equal(L('[top](#intro)'), '[top](#intro)')
  assert.equal(L('[mine](~/notes/a.md)'), '[mine](~/notes/a.md)')
  assert.equal(L('[mail](mailto:a@b.c)'), '[mail](mailto:a@b.c)')
  assert.equal(L('see ~/x/b.ts:2'), 'see ~/x/b.ts:2', 'a ~/ path is outside the repo: text')
})

test('a file:// URL into the repository is a link to its relative path', () => {
  assert.equal(linkify('at file:///r/src/a.ts:7', '/r/', '/h', link), 'at [src/a.ts:7](cmd:src/a.ts:7)')
})

test('no repository or home folder given: nothing is stripped, references still link', () => {
  assert.equal(linkify('in src/a.ts:3', '', '', link), 'in [src/a.ts:3](cmd:src/a.ts:3)')
  assert.equal(linkify('no reference here.', '', '', link), 'no reference here.')
})

test('linkTarget: a vscode://…/link query as the file and its lines (end never before start)', () => {
  assert.deepEqual(linkTarget('file=src/a.ts&start=3&end=7'), { file: 'src/a.ts', start: 3, end: 7 })
  assert.deepEqual(linkTarget('file=%2Fhome%2Fme%2Fa.ts&start=4'), { file: '/home/me/a.ts', start: 4, end: 4 })
  assert.deepEqual(linkTarget('file=a.ts&start=9&end=2'), { file: 'a.ts', start: 9, end: 9 })
  assert.equal(linkTarget('file=a.ts&start=0'), undefined)
  assert.equal(linkTarget('file=a.ts'), undefined)
  assert.equal(linkTarget('start=3'), undefined)
})

test('the reference patterns, case by case: the bare reference assembled, and what each pattern finds', () => {
  const P = ANSWER_LINK_PATTERNS
  // The bare reference as a reader would have to assemble it: not after a word, "/", "~", ".", "-" or a kept link;
  // an optional backtick; the path (folders, then a file name); its line.
  assert.equal(P.BARE_REF.source,
    String.raw`(?<![\w/~.\-\u0000])` + '`?((?:[\\w.-]+\\/)+[\\w.-]+\\.[a-zA-Z]{1,6})' + String.raw`(?::(\d+)(?:-\d+)?|#L(\d+))` + '`?')
  const all = (re: RegExp, s: string) => [...s.matchAll(new RegExp(re.source, 'g'))].map((m) => [...m])
  const table: [RegExp, string, (string | undefined)[][]][] = [
    [P.IMAGE, 'see ![chart](img/a.png "t")', [['![chart](img/a.png "t")', 'chart', 'img/a.png']]],
    [P.MD_LINK, '[the parser](src/parse.ts#L12 "t")', [['[the parser](src/parse.ts#L12 "t")', 'the parser', 'src/parse.ts#L12']]],
    [P.NOT_A_FILE, 'https://x.y', [['https:']]],
    [P.NOT_A_FILE, 'src/a.ts', []],
    [P.TARGET, 'src/a.ts#L12-L20', [['src/a.ts#L12-L20', 'src/a.ts', '12', undefined]]],
    [P.BARE_REF, 'at src/a.ts:12-20.', [['src/a.ts:12-20', 'src/a.ts', '12', undefined]]],
    [P.BARE_REF, '(`src/a.ts#L4`)', [['`src/a.ts#L4`', 'src/a.ts', undefined, '4']]],
    [P.BARE_REF, 'a.ts:3 ~/x/b.ts:2 lib/src/c.ts:1', [['lib/src/c.ts:1', 'lib/src/c.ts', '1', undefined]]],
  ]
  for (const [re, text, want] of table) assert.deepEqual(all(re, text), want, `${text}`)
})
