// Done: Commit & push (the check file and the .gitattributes line, the TODO offered not taken, pushed with -u, the
// merge request link), then `ci` passing the committed file.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'
import { test } from '../helpers'
import { checkFrame, pageShot, ui } from '../devtools'
import { chk, ciOutput, devtools, git, until, untilButtonShown, view, ws } from './context'
import { withMergeRequestHint } from './support'

/** Other work in the working tree while Commit & push runs: it is left alone. */
const scratch = path.join(ws, 'api', 'scratch.js')
const MR_URL = 'https://git.example.com/shop/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat%2Flimits'

export const commitPushTests = [
  test('done: "✓ Done", Commit & push on screen; it names what it commits: the check file and, the first time, the .gitattributes line (the TODO is offered, not taken)', async () => {
    await until('done', () => view()?.title === '✓ Done' && view().action?.id === 'commitPush' && view().line === 'A new file: not committed yet.')
    await until('status bar done', () => chk().item === '$(pass) Understanding')
    // Right under "✓ Done", on screen and clickable, whatever the questions below take.
    await untilButtonShown('Commit & push on screen, clickable', 'Commit & push')
    fs.writeFileSync(scratch, 'export const mine = 1\n')
    // The line that folds check files in diffs goes with the repository's first check, said on the same line.
    await until('what it commits', () => view().commits === 'Commits feat-limits.json, also folds check files in diffs (.gitattributes)' && view().also?.[0]?.label === 'also limits.js (TODO added)' && view().also![0].on === false)
    assert.ok(!fs.existsSync(path.join(ws, '.gitattributes')), 'written only on Commit & push')
    await pageShot('check-3-done')
  }),

  test('Commit & push from the status item pushes; the merge request link the remote prints reaches the view and the status item', async () => {
    // The status item does what the button does (Commit & push), not a jump to question 1.
    await withMergeRequestHint(git('remote', 'get-url', 'origin'), 'feat/limits', MR_URL, async () => {
      void vscode.commands.executeCommand('codeNotes.checkUnderstanding')
      await until('pushed', () => view()?.line === 'Pushed.' && !view().action, 20000)
    })
    await until('the merge request link', () => view()?.mr === MR_URL)
    // view() is the model computed now, so it can say "Pushed." part way through the refresh after the push; the status
    // item (like the view on screen) is drawn at the end of that refresh.
    await until('the status item says "Pushed." too', () => /Done\. Pushed\.$/.test(chk().itemLabel ?? ''))
  }),

  test('on screen after the push: the status bar says what went; the view shows "Open merge request"', async () => {
    await until('the status bar says it', async () => (await (await ui()).locator('.statusbar-item', { hasText: 'Committed feat-limits.json, .gitattributes and pushed' }).count()) > 0)
    assert.ok(await (await checkFrame()).locator('.mr button.link', { hasText: 'Open merge request' }).isVisible(), 'the link is shown')
  }, devtools),

  test('Commit & push committed exactly the check file and the .gitattributes line, pushed with -u; the TODO and other work are left alone', async () => {
    try {
      assert.equal(git('ls-remote', 'origin', 'refs/heads/feat/limits').split('\t')[0], git('rev-parse', 'HEAD'))
      assert.equal(git('rev-parse', '--abbrev-ref', 'feat/limits@{upstream}'), 'origin/feat/limits', 'pushed with -u')
      assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['.gitattributes', 'understanding/feat-limits.json'])
      assert.equal(fs.readFileSync(path.join(ws, '.gitattributes'), 'utf8'), 'understanding/*.json gitlab-generated linguist-generated\nunderstanding/config.json -gitlab-generated -linguist-generated\n')
      assert.ok(!fs.existsSync(path.join(ws, '.ignore')), '.ignore stays init\'s')
      assert.deepEqual(git('status', '--porcelain').split('\n').map((l) => l.trim()).sort(), ['?? api/scratch.js', 'M api/limits.js'])
    } finally {
      fs.rmSync(scratch, { force: true }); git('checkout', '--', 'api/limits.js')
    }
  }),

  test('`ci` passes the committed file without calling a model', async () => {
    assert.match(ciOutput(), /^✓ Understanding check done/)
  }),
]
