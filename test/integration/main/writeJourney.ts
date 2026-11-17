// "Ask the agent to write a journey" when nothing matches: the fake claude CLI (test/fixtures/fake-claude.js) plays
// the code-journey skill's journey.py; the journey is staged, checked, moved into journeys/, and its map opens.
// Source: src/writing.ts (staging), src/claude.ts (the CLI's arguments), src/extension.ts.
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'
import { fakeCalls, flag, readJson, test } from '../helpers'
import { ctx, snap, until, wsPath } from './context'

/* eslint-disable @typescript-eslint/no-explicit-any */
export const writeJourneyTests = [
  test('"Ask the agent to write a journey": claude with the code-journey skill writes it, its map opens', async () => {
    // The repository's own copy of the skill is used (a teammate has none in their home folder).
    const repoSkill = wsPath('.claude', 'skills', 'code-journey')
    fs.mkdirSync(path.join(repoSkill, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(repoSkill, 'scripts', 'journey.py'), '# stand-in\n')
    const callsBefore = fakeCalls().length
    const writing = ctx.api.writeJourney('How is a note saved?')
    // Written into a staging folder; not listed (nor "new") until it is checked and moved; one "Writing:" row meanwhile.
    const stageRoot = path.join(ctx.notesDir, '.writing')
    const staged = () => { try { return fs.readdirSync(stageRoot).map((d) => path.join(stageRoot, d, 'written.json')).find((f) => fs.existsSync(f)) } catch { return undefined } }
    await until('staged file written', () => staged(), 8000)
    assert.ok(!snap().journeys.some((x: any) => x.id === 'written'), 'a journey being written is not listed')
    assert.ok(!fs.existsSync(wsPath('journeys', 'written.json')), 'not in the journeys folder yet')
    assert.match(ctx.api.writing()[0]?.label ?? '', /^Writing: How is a note saved\? · \d:\d\d$/, 'one "Writing: <question> · m:ss" row')
    const wrote = await writing
    assert.equal(wrote, 'written', 'the new journey opened')
    assert.equal(ctx.api.writing().length, 0, 'no row once written')
    const writtenFile = wsPath('journeys', 'written.json')
    assert.equal(readJson(writtenFile).model, 'Claude Code default', 'the model is stamped')
    assert.ok(!fs.readdirSync(stageRoot).length, 'the staging folder is cleaned up')
    await until('its map is open', () => snap().tour.map === 'written')
    const cli = fakeCalls()[callsBefore]
    const prompt = flag(cli, '-p')!
    assert.match(prompt, /^Use the code-journey skill to answer: How is a note saved\?/)
    const allowed = cli.slice(cli.indexOf('--allowedTools') + 1, cli.indexOf('--disallowedTools'))
    assert.ok(['Read', 'Grep', 'Glob', 'Skill'].every((x) => allowed.includes(x)) && allowed.some((x: string) => /^Bash\(.*\/\.claude\/skills\/code-journey\/scripts\/\*\)$/.test(x)), `tools: ${allowed}`)
    assert.ok(cli.includes('Edit') && cli.includes('Write'), 'edits stay blocked')
    assert.ok(allowed.includes(`Bash(${repoSkill}/scripts/*)`), `the repo's skill scripts are allowed: ${allowed}`)
    assert.ok(prompt.includes(`${repoSkill}/scripts/`), 'the prompt points at the repo\'s skill')
    assert.match(prompt, /a request, not the journey's question/, 'the person\'s words are a request')
    fs.unlinkSync(writtenFile)
    await until('written gone', () => !snap().journeys.some((x: any) => x.id === 'written'))
  }),
]
