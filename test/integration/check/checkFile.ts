// The check file changed under the window: rewritten on disk, a merge conflict written into it, broken by hand, a real
// merge conflict that Keep both and Commit & push resolve. A file changed by hand is put back in `finally`
// (withCheckFile), so a failure doesn't leave the next chapters a different check.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { test } from '../helpers'
import { pageShot } from '../devtools'
import { api, checkFile, checkNotes, chk, devtools, git, noteOf, readCheck, readCheckOr, until, untilButtonShown, view, ws } from './context'
import { clickInCheckView, withCheckFile } from './support'

const asText = (check: unknown) => JSON.stringify(check, null, 2) + '\n'

export const checkFileTests = [
  test('the check file rewritten on disk: a changed question gets a new thread, a removed one loses its thread', async () => {
    // Questions written again, a pull: threads follow; none stands for another question.
    const oldQ2 = (await until('q2\'s thread', () => noteOf('q2'))).id
    const rewritten = readCheck()
    rewritten.questions[1].text = 'Why does reset() take a customer instead of clearing every count?'; rewritten.questions[1].attempts = []
    rewritten.questions.splice(2, 1)
    await withCheckFile(asText(rewritten), () => until('threads follow the rewritten file', () => checkNotes().length === 2 && noteOf('q2')?.id !== oldQ2 && noteOf('q2')?.messages[0].body === rewritten.questions[1].text && !api.thread(oldQ2)))
    await until('and back', () => checkNotes().length === 3 && noteOf('q3'))
  }),

  test('a merge conflict in the check file: "The check file has a merge conflict", Keep both answers merges it', async () => {
    const ours = readCheck()
    const theirs = { ...ours, updatedAt: '2026-11-16T09:00:00.000Z' }
    const conflicted = ['<<<<<<< HEAD', JSON.stringify(ours, null, 2), '=======', JSON.stringify(theirs, null, 2), '>>>>>>> pairing', ''].join('\n')
    await withCheckFile(conflicted, async () => {
      await until('the conflict said', () => view()?.title === 'The check file has a merge conflict' && view().action?.id === 'merge' && chk().item === '$(warning) Understanding: merge conflict')
      await pageShot('check-7-conflict')
      await clickInCheckView('footer button.primary', 'Keep both answers')
      await until('merged', () => !fs.readFileSync(checkFile, 'utf8').includes('<<<<<<<') && view()?.title === '✓ Done' && checkNotes().length === 3)
    })
  }, devtools),

  test('a check file broken by hand: "Line 2: …" in the view, Open puts the caret where it breaks', async () => {
    const broken = fs.readFileSync(checkFile, 'utf8').replace('"version": 1,', '"version": 1,,')
    await withCheckFile(broken, async () => {
      await until('where it breaks', () => /^Line 2: /.test(view()?.line ?? '') && view().action?.id === 'openFile')
      await clickInCheckView('footer button.primary', /^Open$/)
      await until('Open: at the error', () => vscode.window.activeTextEditor?.document.uri.fsPath === checkFile && vscode.window.activeTextEditor.selection.active.line === 1 && vscode.window.activeTextEditor.selection.active.character > 0)
    })
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor')
    await until('readable again', () => view()?.title === '✓ Done')
  }, devtools),

  test('a real merge conflict: Keep both keeps the flag a teammate set (said in one line); Commit & push concludes the merge and pushes', async () => {
    // A teammate flagged q3's concern, Ada dismissed it (again).
    await until('clean before the merge', () => git('status', '--porcelain', '--', 'understanding/feat-limits.json') === '' && view()?.title === '✓ Done')
    git('checkout', '-q', '-b', 'feat/limits-bob')
    const bob = readCheck(); bob.questions[2].concern = { text: bob.questions[2].concern.text, flagged: true }
    fs.writeFileSync(checkFile, asText(bob)); git('commit', '-qam', 'bob flags q3')
    git('checkout', '-q', 'feat/limits')
    const ada = readCheck(); ada.questions[2].concern.dismissed.reason = 'Counts are per hour: a restart is harmless.'
    fs.writeFileSync(checkFile, asText(ada)); git('commit', '-qam', 'ada dismisses q3')
    try { git('merge', '-q', '--no-edit', 'feat/limits-bob') } catch { /* the conflict */ }
    void api.checkRefresh()
    await until('the real conflict said', () => view()?.action?.id === 'merge')
    await clickInCheckView('footer button.primary', 'Keep both answers')
    await until('kept both, the flag kept and said', () => readCheckOr()?.questions[2].concern?.flagged === true && /Question 3: its concern stays flagged/.test(view()?.said ?? '') && view().action?.id === 'commitPush')
    await untilButtonShown('Commit & push on screen after the merge', 'Commit & push')
    await clickInCheckView('footer button.primary', 'Commit & push')
    await until('the merge concluded and pushed', () => !fs.existsSync(path.join(ws, '.git', 'MERGE_HEAD')) && git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length === 3 && git('ls-remote', 'origin', 'refs/heads/feat/limits').split('\t')[0] === git('rev-parse', 'HEAD'), 20000)
  }, devtools),
]
