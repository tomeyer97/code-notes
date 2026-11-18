// Done: Commit & push (the check file and the .gitattributes line, the TODO offered not taken, pushed with -u, the
// merge request link), then `ci` passing the committed file.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'
import { test } from '../helpers'
import { cdp, checkFrame, pageShot, ui } from '../devtools'
import { chk, ciOutput, git, until, untilButtonShown, view, ws } from './context'

/* eslint-disable @typescript-eslint/no-explicit-any */

export const commitPushTests = [
  test('done: "✓ Done", Commit & push names and commits exactly the check file and, the first time, the .gitattributes line (the TODO is offered, not taken) and pushes with -u; the view says "Pushed."', async () => {
    await until('done', () => view()?.title === '✓ Done' && view().action?.id === 'commitPush' && view().line === 'A new file: not committed yet.')
    await until('status bar done', () => chk().item === '$(pass) Understanding')
    // The button is right under "✓ Done", on screen and clickable, whatever the questions below take.
    await untilButtonShown('Commit & push on screen, clickable', 'Commit & push')
    // It names what it commits; the TODO added from the check is offered, not taken; other work is left alone.
    fs.writeFileSync(path.join(ws, 'api', 'scratch.js'), 'export const mine = 1\n')
    // The repository's first check: the line that folds check files in diffs goes with it, said on the same line.
    await until('what it commits', () => view().commits === 'Commits feat-limits.json, also folds check files in diffs (.gitattributes)' && view().also?.[0]?.label === 'also limits.js (TODO added)' && view().also![0].on === false)
    assert.ok(!fs.existsSync(path.join(ws, '.gitattributes')), 'written only on Commit & push')
    await pageShot('check-3-done')
    // The status item does what the button does (Commit & push), not a jump to question 1.
    // The remote says how to open a merge request (as GitLab does for a branch without one).
    const remoteDir = git('remote', 'get-url', 'origin')
    fs.writeFileSync(path.join(remoteDir, 'hooks', 'pre-receive'), '#!/bin/sh\necho "To create a merge request for feat/limits, visit:"\necho "  https://git.example.com/shop/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat%2Flimits"\n', { mode: 0o755 })
    void vscode.commands.executeCommand('codeNotes.checkUnderstanding')
    await until('pushed', () => view()?.line === 'Pushed.' && !view().action, 20000)
    // Said where the person looks: the status bar says what went; the item uses the view's word; the merge request link.
    await until('the merge request link', () => view()?.mr === 'https://git.example.com/shop/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat%2Flimits')
    // view() is the model computed now, so it can say "Pushed." part way through the refresh after the push; the status
    // item (like the view on screen) is drawn at the end of that refresh. Wait for it rather than read it at once.
    await until('the status item says "Pushed." too', () => /Done\. Pushed\.$/.test(chk().itemLabel ?? ''))
    assert.match(chk().itemLabel ?? '', /Done\. Pushed\.$/)
    if (cdp) {
      await until('the status bar says it', async () => (await (await ui()).locator('.statusbar-item', { hasText: 'Committed feat-limits.json, .gitattributes and pushed' }).count()) > 0)
      assert.ok(await (await checkFrame()).locator('.mr button.link', { hasText: 'Open merge request' }).isVisible(), 'the link is shown')
    }
    fs.rmSync(path.join(remoteDir, 'hooks', 'pre-receive'))
    assert.equal(git('ls-remote', 'origin', 'refs/heads/feat/limits').split('\t')[0], git('rev-parse', 'HEAD'))
    assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['.gitattributes', 'understanding/feat-limits.json'])
    assert.equal(fs.readFileSync(path.join(ws, '.gitattributes'), 'utf8'), 'understanding/*.json gitlab-generated linguist-generated\nunderstanding/config.json -gitlab-generated -linguist-generated\n')
    assert.ok(!fs.existsSync(path.join(ws, '.ignore')), '.ignore stays init\'s')
    assert.deepEqual(git('status', '--porcelain').split('\n').map((l) => l.trim()).sort(), ['?? api/scratch.js', 'M api/limits.js'], 'the TODO and other work are left alone')
    fs.rmSync(path.join(ws, 'api', 'scratch.js')); git('checkout', '--', 'api/limits.js')
  }),

  test('`ci` passes the committed file without calling a model', async () => {
    assert.match(ciOutput(), /^✓ Understanding check done/)
  }),
]
