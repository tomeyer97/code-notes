import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Ask, claudeArgs, foldEvent, MODEL_ALIASES, modelProblem } from '../src/platform/agent/claude'
import { FoldState, lastTwoSegments, readLine } from '../src/platform/agent/stream'
import { ClaudeCliFinder, findClaude } from '../src/platform/agent/claudeCli'
import { CLAUDE_AUTHOR, claudePrompt, isClaudeAnswer, nothingToAnswer, STOPPED_MARK } from '../src/ask/prompts'
import { RunEnds, SETTLE_MS } from '../src/ask/settle'
import type { Message, NoteData } from '../src/core/format/noteModel'
import type { Note } from '../src/notes/store'

const FAKE_CLAUDE = path.join(__dirname, '../../test/fixtures/fake-claude.js')

test('folds a real `claude -p --output-format stream-json` transcript', () => {
  const lines = fs.readFileSync(path.join(__dirname, '../../test/fixtures/claude-stream.jsonl'), 'utf8').split('\n').filter(Boolean)
  const state: FoldState = { text: '' }
  const activities: string[] = []
  for (const l of lines) { foldEvent(state, l); if (state.activity) activities.push(state.activity) }
  assert.ok(state.result, 'result seen')
  assert.match(state.result.text, /firstNonEmpty/)
  assert.ok(state.result.sessionId)
  assert.ok(state.text.includes('firstNonEmpty'), 'streamed text accumulated')
  assert.ok(activities.some((a) => /Using|Reading|Searching|Looking/.test(a)), `tool activity shown: ${activities.join(' | ')}`)
})

test('ignores junk lines', () => {
  const state = { text: '' }
  assert.equal(foldEvent(state, 'not json'), false)
  assert.equal(foldEvent(state, '{"type":"system","subtype":"init"}'), false)
  assert.equal(foldEvent(state, '[1,2]'), false)
  assert.equal(foldEvent(state, '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta"}}}'), false)
})

test('the finished tool call reaches progress (for the phase)', () => {
  const state: FoldState = { text: '' }
  const toolUse = { type: 'tool_use', name: 'Bash', input: { command: 'journey.py check . x' } }
  foldEvent(state, JSON.stringify({ type: 'assistant', message: { content: [toolUse] } }))
  assert.deepEqual(state.tool, { name: 'Bash', input: { command: 'journey.py check . x' } })
  assert.equal(state.activity, 'Bash')
})

test('stream lines are read into typed events', () => {
  assert.deepEqual(readLine('{"type":"stream_event","event":{"type":"message_start"}}'), { kind: 'message-start' })
  assert.deepEqual(readLine('{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"Grep"}}}'), { kind: 'tool-start', name: 'Grep' })
  assert.deepEqual(readLine('{"type":"result","result":"no","is_error":true}'), { kind: 'result', text: 'no', sessionId: undefined, costUsd: undefined, isError: true })
  const state: FoldState = { text: 'one' }
  assert.equal(foldEvent(state, '{"type":"stream_event","event":{"type":"message_start"}}'), true)
  assert.equal(state.text, 'one\n\n', 'a new message is a new paragraph')
  assert.equal(foldEvent(state, '{"type":"stream_event","event":{"type":"message_start"}}'), false, 'only once')
  foldEvent(state, '{"type":"result","result":"no","is_error":true}')
  assert.equal(state.result?.error, 'no')
})

test('a tool call is said with the last two segments of its path', () => {
  assert.equal(lastTwoSegments('/repo/src/a/b.ts'), 'a/b.ts')
  assert.equal(lastTwoSegments('a/b.ts'), 'a/b.ts')
  assert.equal(lastTwoSegments('b.ts'), 'b.ts')
  assert.equal(lastTwoSegments('/a/b/'), '/a/b/')
  const state: FoldState = { text: '' }
  foldEvent(state, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/repo/src/a/b.ts' } }] } }))
  assert.equal(state.activity, 'Reading a/b.ts')
})

test('models are aliases or claude-* ids', () => {
  const aliases = MODEL_ALIASES.flatMap((a) => [a, a.toUpperCase(), `${a}[1m]`])
  for (const m of [undefined, '', ...aliases, 'claude-sonnet-4-5', 'claude-opus-5-5[1m]'])
    assert.equal(modelProblem(m), undefined, String(m))
  const list = `${MODEL_ALIASES.slice(0, -1).join(', ')} or ${MODEL_ALIASES.at(-1)}`
  assert.equal(modelProblem('sonet'), `Unknown model 'sonet'. Use ${list}.`)
  assert.ok(modelProblem('gpt-5') && modelProblem('fake-model-x') && modelProblem('--dangerous'))
})

test('claude -p arguments: read-only, Bash only through a skill, the model and the session', () => {
  const plain = claudeArgs({ cwd: '/r', prompt: 'p', model: 'opus', resume: 's1', addDirs: ['/d'] })
  assert.deepEqual(plain, [
    '-p', 'p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--allowedTools', 'Read', 'Grep', 'Glob', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'Bash',
    '--add-dir', '/d', '--model', 'opus', '--resume', 's1',
  ])
  const skill = claudeArgs({ cwd: '/r', prompt: 'p', extraTools: ['Skill', 'Bash(/s/scripts/*)'] })
  assert.ok(skill.includes('Bash(/s/scripts/*)') && !skill.slice(skill.indexOf('--disallowedTools')).includes('Bash'))
})

test('a run: the answer streamed, then the result', async () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ask-')), 'calls.log')
  const seen: string[] = []
  const ask = Ask.start({ cli: FAKE_CLAUDE, cwd: os.tmpdir(), prompt: 'hello', env: { FAKE_CLAUDE_LOG: log }, onProgress: (p) => seen.push(p.activity ?? p.text) })
  const res = await ask.done
  assert.equal(res.text, 'The token is read once in `src/renamed.ts:3`.')
  assert.equal(res.sessionId, 'sess-123')
  assert.ok(seen.includes('Reading src/renamed.ts'), seen.join(' | '))
  assert.deepEqual(JSON.parse(fs.readFileSync(log, 'utf8')).slice(0, 2), ['-p', 'hello'])
})

test('a run cancelled, and a program that is not there', async () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ask-')), 'calls.log')
  const slow = Ask.start({ cli: FAKE_CLAUDE, cwd: os.tmpdir(), prompt: 'slow', env: { FAKE_CLAUDE_LOG: log } })
  setTimeout(() => slow.cancel(), 300)
  assert.equal((await slow.done).cancelled, true)
  const none = await Ask.start({ cli: '/nonexistent/claude', cwd: os.tmpdir(), prompt: 'p' }).done
  assert.equal(none.errorKind, 'no-cli')
  assert.match(none.error ?? '', /^couldn't start Claude Code \(\/nonexistent\/claude\)/)
})

/** A folder with `claude` programs that say these versions. */
function installs(versions: string[]): string[] {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cli-'))
  return versions.map((v, i) => {
    const dir = path.join(root, `bin${i}`)
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'claude'), `#!/bin/sh\necho "${v} (Claude Code)"\n`, { mode: 0o755 })
    return dir
  })
}

test('the claude CLI: the setting when it runs, else the newest install', async () => {
  const [old, newer, pre] = installs(['2.1.9', '2.1.10', '2.1.10-beta'])
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'))
  const where = { pathVar: [old, pre, newer].join(path.delimiter), home, places: [] }
  assert.equal(await findClaude(undefined, where), path.join(newer, 'claude'), 'newest, a pre-release before its release')
  assert.equal(await findClaude(path.join(old, 'claude'), where), path.join(old, 'claude'), 'the setting')
  assert.equal(await findClaude('/nonexistent/claude', where), path.join(newer, 'claude'), 'a setting that does not run: the search')
  assert.equal(await findClaude(undefined, { ...where, pathVar: '' }), undefined)
  // An install place in the home folder counts like PATH.
  fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true })
  fs.copyFileSync(path.join(newer, 'claude'), path.join(home, '.local/bin/claude'))
  assert.equal(await findClaude(undefined, { ...where, pathVar: '', places: ['.local/bin/claude'] }), path.join(home, '.local/bin/claude'))
})

test('the found CLI is remembered: one search, then known without waiting', async () => {
  let searches = 0
  const finder = new ClaudeCliFinder(async (setting) => { searches++; return setting ? undefined : '/found/claude' })
  assert.equal(finder.known(undefined), undefined, 'not known before the search')
  assert.equal(await finder.find(undefined), '/found/claude')
  assert.equal(finder.known(undefined), '/found/claude')
  assert.equal(searches, 1, 'known() and find() shared the search')
  assert.equal(finder.known(FAKE_CLAUDE), FAKE_CLAUDE, 'a setting that is a program is known at once')
})

test('the model that answered is read from the stream\'s start', () => {
  const state: FoldState = { text: '' }
  assert.equal(foldEvent(state, '{"type":"system","subtype":"init","model":"claude-opus-5-5"}'), false, 'nothing shown')
  foldEvent(state, '{"type":"result","result":"done","is_error":false}')
  assert.equal(state.result?.model, 'claude-opus-5-5')
})

test('Claude: Path that is not a program: said once, naming it; the newest install still runs', async () => {
  const [newer] = installs(['2.1.10'])
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'))
  const where = { pathVar: newer, home, places: [] }
  const skipped: [string, string | undefined][] = []
  const finder = new ClaudeCliFinder((s) => findClaude(s, where), (s, used) => skipped.push([s, used]))
  assert.equal(await finder.find('/nonexistent/claude'), path.join(newer, 'claude'))
  assert.equal(await finder.find('/nonexistent/claude'), path.join(newer, 'claude'))
  finder.known('/nonexistent/claude')
  assert.deepEqual(skipped, [['/nonexistent/claude', path.join(newer, 'claude')]], 'once, with the program run instead')
  await finder.find(path.join(newer, 'claude'))
  await finder.find(undefined)
  assert.equal(skipped.length, 1, 'a setting that runs, or none: nothing to say')
})

test('an Ask right after a run ends, with nothing said since, is ignored for a second', () => {
  let now = 1000
  const ends = new RunEnds(() => now)
  assert.equal(ends.tooSoon('n', 3), false, 'no run yet')
  ends.ended('n', 3)
  now += SETTLE_MS - 1
  assert.equal(ends.tooSoon('n', 3), true, 'the click meant for Stop')
  assert.equal(ends.tooSoon('n', 4), false, 'a reply since: a new question')
  assert.equal(ends.tooSoon('other', 3), false, 'another note')
  now += 1
  assert.equal(ends.tooSoon('n', 3), false, 'a second later: a real Ask')
})

/** A note as prompts.ts reads it. */
const noteOf = (messages: Message[], claudeSession?: string): Note => ({
  data: { id: 'n1', file: 'src/a.ts', range: { start: 1, end: 1 }, status: 'open', anchor: { text: 'x' }, messages, claudeSession } as NoteData,
} as unknown as Note)

test('Ask on a note Claude answered last: nothing to answer (never an empty run); a stopped answer is asked again', () => {
  const q: Message = { author: 'Pat', role: 'human', body: 'Why twice?' }
  const a: Message = { author: CLAUDE_AUTHOR, role: 'agent', body: 'Once.' }
  const stopped: Message = { author: CLAUDE_AUTHOR, role: 'agent', body: `It is read in\n\n${STOPPED_MARK}`, extra: { stopped: true } }
  assert.equal(nothingToAnswer(noteOf([q])), false, 'a question')
  assert.equal(nothingToAnswer(noteOf([q, a], 's1')), true, "Claude's answer is the newest")
  assert.equal(nothingToAnswer(noteOf([q, a, { ...q, body: 'And here?' }], 's1')), false, 'a reply since')
  assert.equal(nothingToAnswer(noteOf([q, { author: 'Reviewer', role: 'agent', body: 'See b.ts' }])), false, "another agent's message")
  assert.equal(nothingToAnswer(noteOf([q, a, { ...q, body: 'More?' }, stopped], 's1')), false, 'stopped: still awaits its answer')
  assert.equal(isClaudeAnswer(stopped), false)
  // The stopped text is the person's, not part of what Claude is asked.
  const again = claudePrompt(noteOf([q, a, { ...q, body: 'More?' }, stopped], 's1'), undefined, 'Pat')
  assert.match(again, /^Follow-up on the same note .*\n\nPat: More\?\n\nAnswer it\./)
  assert.ok(!again.includes(STOPPED_MARK))
  assert.ok(!claudePrompt(noteOf([q, stopped]), ['x'], 'Pat').includes(STOPPED_MARK))
})
