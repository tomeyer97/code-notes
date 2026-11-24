// What the check offers in each phase, in one table (PHASES): the Check view's one button (and the line above it),
// and what Check my understanding (the command, the status bar item) does. No vscode API here.
import { ACTIONS, type ActionId, LINE, PUSH_ONLY_LABEL } from './checkWords'
import type { CheckViewOptions, PushOutcome, PushView, ViewButton } from './checkViewTypes'
import type { CommitPlan } from './commitPlan'
import type { BranchStatus, Phase } from './types'

export { ACTIONS, type ActionId } from './checkWords'

/** What the command does: a button's action, or show the view (`show`), or the tour / the next question (`walk`). */
export type RunStep = Exclude<ActionId, 'merge' | 'pull'> | 'show' | 'walk'

/** What the command is told besides the status. */
export interface RunOptions { commit?: Pick<CommitPlan, 'fixes' | 'tourOnly'>; unpushed?: boolean }

/** The view's button and the line above it (`line`: the CLI's words, replaced where the button needs its own). */
export interface ButtonAndLine { action?: ViewButton; line: string }

interface PhaseRule {
  /** The view's button. */
  button: (st: BranchStatus, line: string, o: CheckViewOptions) => ButtonAndLine
  /** The command's step. Where the view has no button the command still shows something. */
  command: (st: BranchStatus, o: RunOptions) => RunStep
}

/** A button: its id and label (its usual one unless given). */
const button = (id: ActionId, label: string = ACTIONS[id]): ViewButton => ({ id, label })
const noButton = (_st: BranchStatus, line: string): ButtonAndLine => ({ line })

/** A check that needs a top-up: Commit… first when only uncommitted lines put it over, else Add questions. */
const driftAction = (st: BranchStatus): 'scm' | 'topUp' => (st.state.commitFirst ? 'scm' : 'topUp')
/** Done, and something is left to send: the check file changed (`dirty`), an applied fix, or a push (or no upstream). */
const leftToSend = (dirty: boolean | undefined, fixes: string[] | undefined, unpushed: boolean | undefined): boolean => {
  return !!(dirty || fixes?.length || unpushed !== false)
}

/**
 * Each phase side by side. Where they differ: a file that can't be read is opened by the command (the view may offer
 * Keep both answers); no check yet starts writing (the view says Commit… first when nothing is committed); done, a
 * change of the tour alone is no reason for the command to commit; nothing to check or a stash: the command shows the
 * view; answering: the command walks the tour or opens the next question.
 */
const PHASES: Record<Phase, PhaseRule> = {
  stashed: { button: noButton, command: () => 'show' },
  nothing: { button: noButton, command: () => 'show' },
  // Nothing of the change committed yet: said before any Claude call; Commit… (the check starts once it is in).
  none: {
    button: (_st, line, o) => (o.uncommitted ? { action: button('scm'), line: LINE.commitFirst } : { action: button('start'), line }),
    command: () => 'start',
  },
  invalid: { button: invalidButton, command: () => 'openFile' },
  drift: { button: (st, line) => ({ action: button(driftAction(st)), line }), command: driftAction },
  answering: { button: noButton, command: () => 'walk' },
  short: { button: noButton, command: () => 'walk' },
  done: { button: doneButton, command: doneCommand },
}
/** A phase this build doesn't know (a newer CLI): no button; the command walks. */
const UNKNOWN: PhaseRule = { button: noButton, command: () => 'walk' }
const ruleOf = (p: Phase): PhaseRule => (Object.hasOwn(PHASES, p) ? PHASES[p] : UNKNOWN)

/** The view's one button and the line above it. Check my understanding decides with runAction, from the same table. */
export function viewAction(st: BranchStatus, line: string, o: CheckViewOptions): ButtonAndLine {
  return ruleOf(st.state.phase).button(st, line, o)
}
/** What Check my understanding does. */
export function runAction(st: BranchStatus, o: RunOptions): RunStep {
  return ruleOf(st.state.phase).command(st, o)
}

/** A file that can't be read: open it (at the first conflict); a conflict whose sides both read: keep both answers. */
function invalidButton(st: BranchStatus, line: string, o: CheckViewOptions): ButtonAndLine {
  const action = button(st.state.conflict?.mergeable ? 'merge' : 'openFile')
  // Where the file stops being JSON ("Line 3: expected double-quoted property name."): Open goes there.
  return { action, line: o.invalidAt && !st.state.conflict ? o.invalidAt : line }
}

/** Done: whatever is left to commit or push, the button is there (the check file, an applied fix, the push itself). */
function doneButton(st: BranchStatus, line: string, o: CheckViewOptions): ButtonAndLine {
  let action: ViewButton | undefined
  const fixes = o.commit?.fixes ?? []
  if (leftToSend(st.dirty, fixes, o.unpushed)) {
    const toCommit = st.dirty || fixes.length || o.commit?.todos.length
    action = button('commitPush', toCommit ? ACTIONS.commitPush : PUSH_ONLY_LABEL)
    if (!st.dirty) line = fixes.length ? LINE.fixNotCommitted : LINE.notPushed
    // Only the tour is new (the answers are committed): no need for a push of its own.
    else if (o.commit?.tourOnly) line = LINE.tourOnly
  } else line = LINE.pushed
  const outcome = pushOutcome(o)
  if (o.pushed && outcome !== 'pushed') line = o.pushed
  // Rejected: origin has newer commits. Pull is the way on (a conflict in the check file is then offered to merge).
  if (outcome === 'rejected') action = button('pull')
  return { action, line }
}
/** Done: commit and push what is left, except a change of the tour alone (it goes with the next push); else walk. */
function doneCommand(st: BranchStatus, o: RunOptions): RunStep {
  const dirty = st.dirty && !o.commit?.tourOnly
  return leftToSend(dirty, o.commit?.fixes, o.unpushed) ? 'commitPush' : 'walk'
}

/**
 * How the last Commit & push went: as push.ts said it when it says (`pushOutcome`), else read from its line (the one
 * place its English is read). Undefined: nothing was pushed yet.
 */
export function pushOutcome(o: PushView): PushOutcome | undefined {
  if (!o.pushed) return undefined
  if (o.pushOutcome) return o.pushOutcome
  if (o.pushed === LINE.pushed) return 'pushed'
  return /rejected/.test(o.pushed) ? 'rejected' : 'other'
}
