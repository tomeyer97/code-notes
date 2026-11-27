// The check's phases (checkState's one word) and what every surface says in each: the status bar, the Check view and
// `status` (`words`), and for the phases CI reports from a check file, the CI log and the merge request comment (`ci`).
// One entry per phase, so adding a phase means filling in its entry here; the types make the table exhaustive.
import { minutesFor, sizeText } from './size'
import type { BranchStatus, CheckPosition, Drift, Phase, Summary, Words } from './types'

/** Every phase, in the order a branch usually goes through them. */
export const PHASES = ['nothing', 'stashed', 'none', 'invalid', 'drift', 'answering', 'short', 'done'] as const satisfies readonly Phase[]
/** The phases CI reports from a valid check file (the others it says before reading one: messages.ts). */
export type CheckedPhase = 'drift' | 'answering' | 'short' | 'done'

/** A phase's words for VS Code and `status`, before the rule is added: `(state, st, branch, rule)`. */
type PhaseWords = (state: CheckPosition, st: Partial<BranchStatus>, branch: string, rule: string) => Omit<Words, 'rule'>
/** What CI's words are made of. */
export interface ResultWords { sum: Summary; drift: Drift; rel: string; rule: string; room: string }
/** CI's words: `log`, the log's first line (no glyph: ci.ts adds it), and `comment`, the merge request comment's headline. */
interface CiWords { log: (w: ResultWords) => string; comment: (w: ResultWords) => string }
/** A phase's entry: `ci` exactly for the phases CI reports from a check. */
type PhaseEntry<P extends Phase> = { words: PhaseWords } & (P extends CheckedPhase ? { ci: CiWords } : { ci?: never })

/** A phase missing from PHASES fails to compile here. */
const everyPhaseListed: [Exclude<Phase, (typeof PHASES)[number]>] extends [never] ? true : never = true
void everyPhaseListed

export const PHASE: { [P in Phase]: PhaseEntry<P> } = {
  nothing: {
    words: (state, st, branch) => (st.onBase
      // The default branch: one line, no change to speak of.
      ? { tone: 'ok', bar: '', title: `${branch}: no check here`, line: '' }
      : { tone: 'ok', bar: '', title: 'No check needed', line: nothingLine(state, st) }),
  },
  stashed: {
    words: (state) => ({
      tone: 'warn',
      bar: 'Understanding: in a stash',
      title: 'Your check is in a git stash',
      line: `Run git stash pop (${state.stash}).`,
    }),
  },
  none: {
    words: (state, st, branch) => ({
      tone: 'todo',
      bar: 'Understanding: start',
      title: `No check yet for ${branch}`,
      line: `${noneSize(state, st)}${state.want ? ` · ${sizeText(state.want)}` : ''}.`,
    }),
  },
  invalid: {
    words: (state) => (state.conflict
      ? {
        tone: 'warn',
        bar: 'Understanding: merge conflict',
        title: 'The check file has a merge conflict',
        line: state.conflict.mergeable ? 'Both sides of the conflict can be kept.' : 'Open it at the conflict.',
      }
      : {
        tone: 'warn',
        bar: 'Understanding: fix the file',
        title: 'The check file is not valid',
        line: / is not valid JSON/.test(state.why!) ? "It isn't valid JSON: open it." : `${state.why!.replace(/^\S+\.json:\s*/, '')}.`,
      }),
  },
  drift: {
    words: (state) => ({
      tone: 'warn',
      bar: `Needs top-up: +${state.grew} lines`,
      title: `Needs top-up: +${state.grew} lines`,
      line: state.commitFirst ? 'Commit, then add 1–2 questions about the new lines.' : 'Add 1–2 questions about the new lines.',
    }),
    ci: {
      log: (w) => `Your change grew by ${w.drift.lines} code lines since the check${w.drift.approx ? ' (compared by size: the branch was rewritten)' : ''}. Run "Check my understanding" again: it adds 1–2 questions about the new part only. Then commit and push.`,
      comment: (w) => `**Understanding check: needs a top-up.** The change grew by ${w.drift.lines} code lines since the questions; 1–2 questions about the new part are missing.`,
    },
  },
  answering: {
    words: (state, _st, _branch, rule) => ({
      tone: 'todo',
      bar: `Understanding ${state.done}/${state.total}`,
      title: `${state.done} of ${state.total} done`,
      line: `${rule} · ~${minutesFor(state.total! - state.done!)} min left.`,
    }),
    ci: {
      log: (w) => `Understanding check: ${w.sum.done} of ${w.sum.total} done (${w.rule}). Finish in VS Code, commit ${w.rel} and push.`,
      comment: (w) => `**Understanding check in progress:** ${w.sum.done} of ${w.sum.total} done (about ${minutesFor(w.sum.total - w.sum.done)} min left).`,
    },
  },
  short: {
    words: (state) => ({
      tone: 'warn',
      bar: `Understanding ${state.passed}/${state.needed} passed`,
      title: `${state.passed} passed, ${state.needed} must pass`,
      line: 'Say an explained answer back in your own words.',
    }),
    ci: {
      log: (w) => `Understanding check: ${w.sum.passed} passed, ${w.sum.needed} must pass. In VS Code, say an explained answer back in your own words, then commit and push.`,
      comment: (w) => `**Understanding check in progress:** all ${w.sum.total} answered, not finished yet.`,
    },
  },
  done: {
    words: (_state, st) => ({
      tone: 'ok',
      bar: '✓ Understanding',
      title: '✓ Done',
      line: st.untracked ? 'A new file: not committed yet.' : st.dirty ? 'Not committed yet.' : 'Committed.',
    }),
    ci: {
      log: (w) => `Understanding check done: ${w.sum.passed} of ${w.sum.total} passed (${w.rule}).${w.room}`,
      comment: (w) => `**✓ Understanding check done** · ${w.sum.total} question${w.sum.total === 1 ? '' : 's'}`,
    },
  },
}

/** How much room is left before a top-up is needed (the CI log's "done" line). */
export const roomText = (drift: Drift, maxDrift: number): string => (drift.lines ? ` ${drift.lines} code line${drift.lines === 1 ? '' : 's'} since the check (top-up at ${maxDrift}).` : '')

/** Why no check is needed, in a line: a stack's parent covers it, only exempt files, or no code lines. */
function nothingLine(state: CheckPosition, st: Partial<BranchStatus>): string {
  if (st.stackedOn) return `Covered by ${st.stackedOn}'s check.`
  return state.exemptOnly ? 'Only exempt files changed.' : 'No code lines changed.'
}

/** What changed, for "No check yet": "12 code lines changed", "3 lines removed (docs)", "Renamed, 0 lines changed (a.js)". */
function noneSize(state: CheckPosition, st: Partial<BranchStatus>): string {
  const renamed = st.change?.renamed ?? []
  if (!state.changed && renamed.length) return `Renamed, 0 lines changed (${renamed.map((r) => r.to.split('/').pop()).join(', ')})`
  const lines = `${state.changed} ${state.docs ? 'line' : 'code line'}${state.changed === 1 ? '' : 's'}`
  const since = st.stackedOn ? ` since ${st.stackedOn}'s check` : ''
  return `${lines} ${state.removal ? 'removed' : 'changed'}${state.docs ? ' (docs)' : ''}${since}`
}
