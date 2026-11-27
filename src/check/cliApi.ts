// The understanding CLI's functions the extension host calls: the check's rules live in one place
// (cli/understanding/*.ts; the extension compiles the modules it uses, the CLI ships them bundled). Split by what a
// call does, so a synchronous git call on the host doesn't compile:
//   pureCli   reads nothing: the rules, the words, file names, prompts and verdicts
//   fileCli   the check file, its settings and the lines a question points at: small files read and written on the
//             host, and commitAndPush (git, but asynchronous)
// Everything that runs git synchronously (the status, diffs) is on the worker thread: cliWorker.ts `workerApi`,
// called through CliThread's typed proxy.
import { relocate } from '../../cli/understanding/anchors'
import { own } from '../../cli/understanding/changeFiles'
import { addAttempt, CACHE, cachedFor, conflictOf, conflictSides, fileFor, loadConfig, readCheck, writeCheck } from '../../cli/understanding/checkFile'
import { hunksOf, linesOf } from '../../cli/understanding/diff'
import { graderPrompt } from '../../cli/understanding/graderPrompt'
import { codeWindow, diffForGrader, gradeMode, openOthers, parseVerdict, recordGrade, tourText } from '../../cli/understanding/grading'
import { FOLD_TEXT, foldDiffs, foldMissing } from '../../cli/understanding/init'
import { concernLink } from '../../cli/understanding/mrComment'
import { commitAndPush } from '../../cli/understanding/push'
import { stamp, stateOf, stateWords, summarize } from '../../cli/understanding/state'

export const pureCli = {
  stateOf, stateWords, summarize, stamp, addAttempt, fileFor, cachedFor, CACHE, conflictOf, conflictSides, linesOf,
  hunksOf, own, concernLink, gradeMode, graderPrompt, openOthers, tourText, parseVerdict, diffForGrader, FOLD_TEXT,
}

export const fileCli = { readCheck, writeCheck, loadConfig, relocate, codeWindow, recordGrade, foldMissing, foldDiffs, commitAndPush }

/** What the extension host may call. */
export const hostCli = { ...pureCli, ...fileCli }
export type HostCli = typeof hostCli
