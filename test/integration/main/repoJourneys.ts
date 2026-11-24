// Journeys kept in the repository (<repo>/journeys/, the codeNotes.journeys.folder setting) with compact (v3) anchors:
// read once even when a personal copy has the same id; a block that moved is found fresh, one edited inside is
// "changed", one deleted is "gone". Source: src/journeys/, src/core/anchors/compact.ts.
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'
import { test, untilEqual } from '../helpers'
import { writeJourney } from '../fixtures'
import { ctx, journeyById, journeysDir, journeysTree, snap, until, wsPath } from './context'
import { repoJourneysDir, savingJourney, savingTs } from './shared'

/* eslint-disable @typescript-eslint/no-explicit-any */
const writeSavingTs = (lines: string[]) => fs.writeFileSync(wsPath('src', 'saving.ts'), lines.join('\n'))

const saving = () => journeyById('saving')
/** Re-reads the journeys, as a window reload would. */
const reload = () => ctx.api.reloadJourneys()

export const repoJourneysTests = [
  test('journeys in <repo>/journeys/ (codeNotes.journeys.folder) are read; a same-id copy in the notes folder is not listed twice', async () => {
    writeSavingTs(savingTs)
    // The same id in the notes folder too (a personal copy, the old place): listed once, the repo's.
    fs.mkdirSync(journeysDir(), { recursive: true })
    fs.writeFileSync(path.join(journeysDir(), 'saving-copy.json'), JSON.stringify({ ...savingJourney, title: 'Personal copy' }))
    writeJourney(repoJourneysDir(), savingJourney)
    await reload()
    await until('repo journey read', () => saving())
    assert.equal(snap().journeys.filter((x: any) => x.id === 'saving').length, 1, 'one saving journey')
    const rows = journeysTree()
    assert.ok(rows.some((l) => /journey:.*Saving a note/.test(l)) && !rows.some((l) => /Personal copy/.test(l)), `the repo copy wins: ${rows.join(' / ')}`)
    assert.deepEqual(saving().at.map((a: any) => [a.start, a.end, a.stale]), [[3, 8, false], [10, 13, false]])
  }),

  test('compact anchors: moved block fresh at its new place, edited inside changed, deleted gone', async () => {
    const first = () => saving()?.at[0]
    writeSavingTs(['// header', '// more', ...savingTs])
    await reload()
    await untilEqual('moved, fresh', () => [first().start, first().end, !!first().stale, saving().at[1].start], [5, 10, false, 12])
    const edited = [...savingTs]; edited[5] = '  log("saved", n.id)'
    writeSavingTs(edited)
    await reload()
    await untilEqual('edited, changed', () => ({ stale: !!first().stale, removed: !!first().removed, start: first().start, end: first().end }), { stale: true, removed: false, start: 3, end: 8 })
    writeSavingTs(savingTs.slice(9))
    await reload()
    await untilEqual('deleted, gone', () => ({ stale: !!first().stale, removed: !!first().removed }), { stale: true, removed: true })
    assert.deepEqual([saving().at[1].start, saving().at[1].stale], [1, false], 'the other step followed')
    writeSavingTs(savingTs)
    await reload()
    await until('back, fresh', () => saving() && saving().at.every((a: any) => !a.stale))
  }),
]
