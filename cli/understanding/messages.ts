// What the CI job says, in its log and in the merge request comment, apart from the words of a check's phase
// (those are in phases.ts, beside what VS Code and `status` say for the same phase). Change the tone here.
// Log lines here have no glyph: ci.ts puts ✓ / ✗ / ! (or ⚠ Advisory) in front by the job's result.
import { DEFAULTS, SKILL_URL } from './constants'
import { MARKER } from './markers'
import type { CodeStat, Config } from './types'

/**
 * The way without VS Code, the same in `status` and CI: /understanding-check in Claude Code (the skill, committed in
 * the repository by `init`, asks the questions one at a time in the chat). `installed`: the repository has the skill.
 */
export const withoutVsCode = (installed: boolean): string => (installed
  ? 'Without VS Code: type /understanding-check in Claude Code.'
  : `Without VS Code: add the understanding-check skill to .claude/skills (${SKILL_URL}), then type /understanding-check in Claude Code.`)

/** The job can't check: the history it needs is missing. */
export const NO_HISTORY = 'Understanding check: the base or head commit is not in this clone. Fetch the full history (GitLab: GIT_DEPTH: 0; GitHub: fetch-depth: 0).'
export const cantReadMr = (why: string): string => `Understanding check: couldn't read the merge request: ${why}`
export const cantReadApprovals = (why: string): string => `Understanding check: couldn't read approvals: ${why}`

/** No check needed (log): a stack's parent covers it, or only the settings changed. */
export const coveredBy = (branch: string): string => `No check needed: covered by ${branch}'s check (no code changed since).`
export const ONLY_SETTINGS = 'No check needed: only the check\'s settings changed.'
/** Why no check is needed: only exempt files changed, or no code lines (comments, blank lines). */
export function noCheckText(change: CodeStat): string {
  if (change.exemptOnly) {
    const f = change.exempt
    return `No check needed: only exempt files changed (${f.slice(0, 3).join(', ')}${f.length > 3 ? `, +${f.length - 3} more` : ''}).`
  }
  return 'No check needed: no code lines changed (only comments or blank lines).'
}

/** noCheckText as the log's line ("✓ No check needed: …"). */
export const noCheckLine = (change: CodeStat): string => `✓ ${noCheckText(change)}`

/** The skip label and approvals (skipDecision): waived, or why not yet. `rerun`: what to do after an approval. */
export const SKIP = {
  /** Log and comment: someone other than the author approved. */
  waived: (approvers: string[]): string => `Understanding check waived (approved by ${approvers.map((u) => `@${u}`).join(', ')})`,
  /** Log: the job has no token to read approvals with (`tokenVar`: the variable it needs). */
  blind: (label: string, tokenVar: string): string => `Label "${label}" is set, but this job can't see approvals (no ${tokenVar}).`,
  /** Log: only the author approved. */
  authorOnly: (author: string | undefined, rerun: string): string => `Approved only by ${author} (the author). Ask a reviewer to approve${rerun}.`,
  /** Log and comment: no approval yet. */
  asked: (rerun: string): string => `Skip requested: an approval from a reviewer waives the understanding check${rerun}.`,
  /** Comment: only the author approved. */
  ownApproval: (rerun: string): string => `Your own approval doesn't count: ask a reviewer to approve${rerun}.`,
}

/** The comment's line under the headline in advisory mode. */
export const ADVISORY_COMMENT = "Advisory: this check doesn't block merging."
/** The log's first line of a failure in advisory mode (`text`: the failure, without its glyph). */
export const advisoryLine = (text: string): string => `⚠ Advisory: ${text}`
/** GitHub Actions' warning annotation's title. */
export const ANNOTATION_TITLE = 'Understanding check'

/** No check file yet: the log's lines (the first without its glyph). `quiet`: no skip instructions (advisory, or label set). */
export function missingLog(rel: string, { size, skipLabel, rerun, quiet, withoutVs }: { size: string; skipLabel: string; rerun: string; quiet: boolean; withoutVs: string }): [string, ...string[]] {
  return [`No understanding check yet: a few questions about your change (${size}). Run "Code Notes: Check my understanding" in VS Code, then commit ${rel} and push.`,
    `  ${withoutVs}`,
    ...(quiet ? [] : [`  Or add the label "${skipLabel}" and get a reviewer's approval${rerun}.`])]
}
/** The merge request comment while there is no check yet: what it is and what to do, in two lines. */
export function missingBody(rel: string, cfg: Config = DEFAULTS, rerun = ', then re-run the job', { quiet = false, size = 'about 5 min' }: { quiet?: boolean; size?: string } = {}): string {
  return [MARKER, `**Understanding check: not done yet.** A few questions about your change (${size}): run **Code Notes: Check my understanding** in VS Code, then commit \`${rel}\` and push.`,
    ...(quiet ? [] : [`<sub>Or add the label \`${cfg.skipLabel}\` and get a reviewer's approval${rerun}.</sub>`])].join('\n')
}

/** The check file can't be used: the log's first line (no glyph) and the comment's headline. `inline`: made safe for markdown. */
export const INVALID = {
  notJson: { log: (rel: string, why: string): string => `${rel} is not valid JSON (${why}).`, comment: (rel: string): string => `**Understanding check:** \`${rel}\` is not valid JSON. Run **Check my understanding** again.` },
  notValid: { log: (rel: string, first: string): string => `${rel} is not valid: ${first}.`, comment: (rel: string, firstInline: string): string => `**Understanding check:** \`${rel}\` is not valid (${firstInline}).` },
  regraded: {
    log: (rel: string, bad: string[]): string => `${rel}: ${bad.join(', ')} changed after grading (a merge, or an edit by hand). Grade ${bad.length === 1 ? 'it' : 'them'} again in VS Code, then commit and push.`,
    comment: '**Understanding check:** some answers changed after grading. Grade them again in VS Code, then push.',
  },
}

/** The settings change, one sentence (`parts`: "mode required → advisory"). */
export const settingsSentence = (parts: string[]): string => `This merge request changes the understanding check's settings: ${parts.join(', ')}.`
/** The settings change as the comment's headline: it applies once merged; this merge request is judged by the target's. */
export const settingsHeadline = (line: string): string => `**⚠ ${line.replace(/\.$/, '')}** (from the merge on; this merge request follows the current settings)`
/** The settings change in the log, when the change also needs a check. */
export const settingsLater = (sentence: string): string => `  ${sentence} It applies once merged.`

/** The log's line on the comment: written, or why not. */
export const commentWritten = (how: 'created' | 'updated'): string => `  Merge request comment ${how}.`
export const commentFailed = (why: string): string => `  (couldn't write the merge request comment: ${why})`
/** The log's tip when check files don't collapse in diffs yet (never in the comment). */
export const foldTip = (cli: string): string => `  tip: run "node ${cli} init" once and commit .gitattributes and .ignore: check files then collapse in diffs.`
