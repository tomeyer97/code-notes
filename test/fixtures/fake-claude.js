#!/usr/bin/env node
// A stand-in for the `claude` CLI in integration tests: records its arguments, streams a canned answer.
const fs = require('fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG || require('path').join(require('os').tmpdir(), 'fake-claude.log'), JSON.stringify(args) + '\n')
const prompt = args[args.indexOf('-p') + 1] || ''
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const delay = /slow/.test(prompt) ? 30000 : 150
// "Use the code-journey skill to answer: …": write a journey file, as journey.py would, into the staging
// folder the prompt names (--dir <folder>); a resumed session (an answer to its question) writes one too.
// A request with "unclear" in it: no journey, a clarifying question instead.
const jq = /code-journey skill to answer: (.*)/.exec(prompt)
const dirArg = /--dir (\S+?)`/.exec(prompt)
const resumed = args.includes('--resume')
const clarify = jq && /unclear/.test(jq[1]) && !resumed
// "already": no new journey; the answer names the one that exists.
const exists = jq && /already/.test(jq[1]) && !resumed
if ((jq || (resumed && dirArg)) && !clarify && !exists) {
  const path = require('path')
  const dir = dirArg ? path.join(process.cwd(), dirArg[1]) : path.join(process.cwd(), '.code-notes', 'journeys')
  fs.mkdirSync(dir, { recursive: true })
  const q = jq ? jq[1].trim() : 'How is a note saved?'
  const j = { version: 2, id: 'written', question: q, title: 'Written by the agent', summary: '', model: 'fake-model', createdAt: new Date().toISOString(),
    nodes: [{ id: 'app', kind: 'system', label: 'App', summary: '' }, { id: 'f', kind: 'function', label: 'main', parent: 'app', summary: '' }],
    edges: [], steps: [{ id: 'm', title: 'main reads the token', node: 'f', file: 'src/renamed.ts', range: { start: 1, end: 1 }, lead: 'Here.', refs: [] }] }
  fs.writeFileSync(path.join(dir, '.written.json.tmp'), JSON.stringify(j, null, 2))
  fs.renameSync(path.join(dir, '.written.json.tmp'), path.join(dir, 'written.json'))
}
say({ type: 'system', subtype: 'init' })
say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/repo/src/renamed.ts' } }] } })
const words = exists ? ['The ', 'journey ', 'you ', 'need ', 'is ', 'already ', 'in ', '`journeys/saving.json`.'] : clarify ? ['Which ', 'part ', 'do ', 'you ', 'mean: ', '**saving** ', 'or ', 'loading?'] : ['The ', 'token ', 'is ', 'read ', 'once ', 'in ', '`src/renamed.ts:3`.']
let i = 0
const tick = setInterval(() => {
  if (i < words.length) { say({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: words[i++] } } }); return }
  clearInterval(tick)
  say({ type: 'result', result: words.join(''), session_id: clarify ? 'sess-clarify' : 'sess-123', total_cost_usd: 0.01, is_error: false })
}, delay)
