import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aboutStepLine, codeBlock, messageText, segments, suggestionOf, verbatimText } from '../src/threads/text'
import { diffBlock, oldCodeBlock, staleText, type StaleFacts } from '../src/threads/banner'
import { Links } from '../src/threads/links'
import { BANNER_COMMANDS, Cmd, MESSAGE_COMMANDS } from '../src/platform/commands'

const fileLink = (t: string, f: string, l?: string) => `[${t}](open:${f}:${l ?? 1})`
const base = { fileLink, root: '/r', home: '/h' }

test('a message cut at its fences: suggestions numbered in order, the same numbers Apply and suggestionOf use', () => {
  const body = 'a\n```suggestion\none\n```\nb\n```ts\nx\n```\n```suggestion\ntwo\n```'
  const s = segments(body)
  assert.deepEqual(s.map((x) => x.kind), ['text', 'suggestion', 'text', 'code', 'text', 'suggestion', 'text'])
  assert.deepEqual(s.flatMap((x) => (x.kind === 'suggestion' ? [x.k] : [])), [0, 1])
  assert.equal(suggestionOf(body, 0), 'one')
  assert.equal(suggestionOf(body, 1), 'two')
  assert.equal(suggestionOf(body, 2), undefined)
  const out = messageText({ ...base, body, apply: (k) => `[Apply ${k}]` })
  assert.equal(out, 'a\n```\none\n```\n\n[Apply 0]\nb\n```ts\nx\n```\n```\ntwo\n```\n\n[Apply 1]')
  assert.equal(messageText({ ...base, body }), body, 'no Apply (not an agent\'s message): suggestions stay as written')
})

test('file references link outside code only; the home folder is never shown', () => {
  const out = messageText({ ...base, body: 'see src/a.ts:3 and /h/x/b.ts:1\n```\nsrc/a.ts:3\n```' })
  assert.equal(out, 'see [src/a.ts:3](open:src/a.ts:3) and ~/x/b.ts:1\n```\nsrc/a.ts:3\n```')
})

test('the check\'s code links: phrases marked, tags escaped once, then the links put in; the suffix and its place', () => {
  const codeLinks = [{ phrase: 'the cache', file: 'src/c.ts', start: 2, end: 4, text: '' }]
  const out = messageText({ ...base, body: 'Is <id> in the cache?', codeLinks, codeLink: (i, p) => `<L${i}:${p}>`, suffix: ' <s>' })
  assert.equal(out, 'Is \\<id\\> in <L0:the cache>? \\<s\\>')
})

test('an answer as typed: Markdown punctuation and tags are text, each line its own', () => {
  assert.equal(verbatimText('# a <b>\n---'), '\\# a &lt;b&gt;  \n\\-\\-\\-')
})

test('a step question\'s last line, by id or (older notes) by number; with and without the blank lines before it', () => {
  const byId = aboutStepLine('Why?\n\n_About the step “Read” (id `s3`) of the journey “Start-up”_\n')
  assert.deepEqual(byId, { before: 'Why?\n\n', beforeBlank: 'Why?', journeyTitle: 'Start-up' })
  const byNumber = aboutStepLine('Why?\n\n_About step 3 of the journey “Boot”: Read the config_')
  assert.deepEqual(byNumber, { before: 'Why?\n\n', beforeBlank: 'Why?', journeyTitle: 'Boot' })
  assert.equal(aboutStepLine('Why?\n\n_About the step “Read” (id `s3`) of the journey “J”_\nmore'), undefined, 'only as the last line')
})

test('the stale banner: gone, shorter, changed (with the branch), and only the lines that changed', () => {
  const f: StaleFacts = { id: 'n1', file: 'src/a.ts', wholeFile: false, missing: false, was: '' }
  const l = () => new Links(BANNER_COMMANDS)
  const move = '[Move](command:codeNotes.moveToSelection?%5B%22n1%22%5D)'
  const keep = '[Keep here](command:codeNotes.acceptCode?%5B%22n1%22%5D)'
  assert.equal(staleText({ ...f, missing: true, wholeFile: true }, l()), '**`src/a.ts` no longer exists.**')
  assert.equal(staleText({ ...f, missing: true, was: '```\nx\n```' }, l()), `**\`src/a.ts\` no longer exists.**\n\n\`\`\`\nx\n\`\`\`\n\n${move}`)
  assert.equal(staleText({ ...f, pastEnd: 7 }, l()), `**The code changed since this note** (the file has 7 lines now).\n\n${move}`)
  assert.equal(staleText({ ...f, branch: 'dev' }, l()), `**The code changed since this note** (written on \`dev\`).\n\n${keep} · ${move}`)
  assert.equal(oldCodeBlock(['1', '2', '3', '4', '5']), '```\n1\n2\n3\n… 2 more\n```')
  assert.equal(diffBlock(['  a'], ['  b']), '```diff\n- a\n+ b\n```')
  assert.equal(codeBlock(['x'], 'ts'), '```ts\nx\n```')
})

test('links: the text may run every command it links to, after the ones it is allowed anyway', () => {
  const l = new Links(MESSAGE_COMMANDS)
  assert.deepEqual(l.commands, [...MESSAGE_COMMANDS])
  l.to('Next', Cmd.checkUnderstanding)
  l.to('Open', Cmd.openAt)
  assert.deepEqual(l.commands, [...MESSAGE_COMMANDS, Cmd.checkUnderstanding])
  assert.deepEqual(new Links([]).commands, [])
})
