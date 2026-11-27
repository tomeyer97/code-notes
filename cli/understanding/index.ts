// The built file's entry (scripts/build/cli.mjs bundles it into cli/understanding.mjs): the CLI's API, the functions
// and values below (the extension, the skill's script and people's scripts import them), and the command line when
// the file is run. A module's other exports are shared between the modules only.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SELF, setSelf } from './constants'
import { main } from './main'

export { CI_URL, DEFAULTS, DIR, DOCS_URL, KINDS, MAX_QUESTIONS, MAX_TEXT, MAX_TOUR_STEPS, SKILL_DIR, SKILL_URL, TOUR_LINE, VERDICTS } from './constants'
export { MARKER } from './markers'
export { missingBody, noCheckLine, withoutVsCode } from './messages'
export { ciBranch, currentBranch, DEFAULT_BRANCHES, defaultBase, git, gitRun, hasCommit, isDefaultBranch, mergeBase, repoRoot, stackBase, stashedIn } from './git'
export { counted, globRe, isDoc, own } from './changeFiles'
export { commentStyle, isCode } from './comments'
export { changedRanges, codeLines, codeStat, diffText, freshLines, hunksOf, linesOf, nearestChanged, newCodeLines, numberDiff, numstat, oldLineOf, rangesOf, removalPoints, stat } from './diff'
export { changeKind, checkKind, evidenceText, minutesFor, questionsFor, questionsForChange, removedNames, searchNames, sizeText, sizeWords, topUpQuestions, tourSize } from './size'
export { addAttempt, attemptHash, CACHE, cachedFor, conflictOf, conflictSides, fileFor, flagConcern, gitIdentity, loadConfig, pruneAttempts, readCheck, slugOf, unknownSettings, writeCheck } from './checkFile'
export { hashProblems, tourProblems, validateCheck } from './validate'
export { checkState, driftOf, isDone, isPassed, localStatus, needed, nextQuestion, refreshInputs, ruleText, stamp, stateOf, stateWords, summarize } from './state'
export { compactOf, findAnchor, relocate } from './anchors'
export { graderPrompt, REPLY_WORDS } from './graderPrompt'
export { applyGrade, codeLinksIn, codeWindow, diffForGrader, gradeMode, gradeQuestion, openOthers, parseVerdict, promptFor, recordGrade, repeats, tourText } from './grading'
export { pickBackend, runGrader } from './graderBackends'
export { commitAndPush, commitCheck } from './push'
export { approvers, ciContext, mrInfo, refLink, upsertComment } from './platform'
export { clipAnswer, clipWords, commentBody, concernChanged, concernChangedIn, concernLink, discussItems, explanationOf, flaggedConcerns, inert, literal, noticedConcerns, questionText, reasonOf, reviewItems, settingsChange } from './mrComment'
export { ciMode, runCi } from './ci'
export { concernBody, concernPlace, syncConcerns, threadBody } from './threads'
export { FOLD_TEXT, foldDiffs, foldMissing, hasSkill, INIT_LINES, initRepo, installSkill, setupMissing } from './init'
export { main, parseArgs } from './main'

setSelf(fileURLToPath(import.meta.url))

/**
 * Whether this file is the command being run, not a module someone imported (the extension and the skill's script
 * import it). By real path: the command may be a symlink to it (a bin folder), or name it by another path.
 */
function isMain(): boolean {
  if (!process.argv[1]) return false
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF)
  } catch {
    // A path that doesn't resolve (the script name of `node -e`): not this file.
    return false
  }
}

if (isMain()) {
  main().then(
    (code) => { process.exitCode = code },
    (e) => { console.error(`! ${e.message}`); process.exitCode = 2 },
  )
}
