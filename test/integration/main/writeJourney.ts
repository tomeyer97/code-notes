// "Ask the agent to write a journey" when nothing matches: the fake claude CLI (test/fixtures/fake-claude.js) plays
// the code-journey skill's journey.py; the journey is staged, checked, moved into journeys/, and its map opens.
// Source: src/write/ (claudeRun.ts, writeJourney.ts, staging.ts); what Claude may run is unit-tested in
// test/writing.test.ts (runOptions.ts through claude.ts's claudeArgs), so here it is enough that the CLI was called.
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'
import { fakeCalls, flag, readJson, test } from '../helpers'
import { writeSkillStandIn } from '../fixtures'
import { STAGING } from '../../../src/write/staging'
import { ctx, snap, until, wsPath } from './context'

/** The journey file `name` in a staging folder of the notes folder (`.writing/<id>/<name>`), once there is one. */
function stagedFile(notesDir: string, name: string): string | undefined {
  const root = path.join(notesDir, STAGING)
  if (!fs.existsSync(root)) return undefined
  return fs.readdirSync(root).map((id) => path.join(root, id, name)).find((f) => fs.existsSync(f))
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export const writeJourneyTests = [
  test('"Ask the agent to write a journey": claude with the code-journey skill writes it, its map opens', async () => {
    // The repository's own copy of the skill is used (a teammate has none in their home folder).
    const repoSkill = writeSkillStandIn(ctx.ws)
    const callsBefore = fakeCalls().length
    const writing = ctx.api.writeJourney('How is a note saved?')
    // Written into a staging folder; not listed (nor "new") until it is checked and moved; one "Writing:" row meanwhile.
    await until('staged file written', () => stagedFile(ctx.notesDir, 'written.json'), 8000)
    assert.ok(!snap().journeys.some((x: any) => x.id === 'written'), 'a journey being written is not listed')
    assert.ok(!fs.existsSync(wsPath('journeys', 'written.json')), 'not in the journeys folder yet')
    assert.match(ctx.api.writing()[0]?.label ?? '', /^Writing: How is a note saved\? · \d:\d\d$/, 'one "Writing: <question> · m:ss" row')
    const wrote = await writing
    assert.equal(wrote, 'written', 'the new journey opened')
    assert.equal(ctx.api.writing().length, 0, 'no row once written')
    const writtenFile = wsPath('journeys', 'written.json')
    assert.equal(readJson(writtenFile).model, 'Claude Code default', 'the model is stamped')
    assert.ok(!fs.readdirSync(path.join(ctx.notesDir, STAGING)).length, 'the staging folder is cleaned up')
    await until('its map is open', () => snap().tour.map === 'written')
    const cli = fakeCalls()[callsBefore]
    assert.ok(cli, 'the claude CLI was called')
    const prompt = flag(cli, '-p')!
    assert.match(prompt, /^Use the code-journey skill to answer: How is a note saved\?/)
    assert.ok(cli.includes(`Bash(${repoSkill}/scripts/*)`), 'the repo\'s skill scripts are the ones allowed')
    assert.ok(prompt.includes(`${repoSkill}/scripts/`), 'the prompt points at the repo\'s skill')
    assert.match(prompt, /a request, not the journey's question/, 'the person\'s words are a request')
    fs.unlinkSync(writtenFile)
    await until('written gone', () => !snap().journeys.some((x: any) => x.id === 'written'))
  }),
]
