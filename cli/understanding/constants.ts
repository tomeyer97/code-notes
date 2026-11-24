// The check's names, limits and links: what every other module (and the extension) shares. Values only: the
// sentences are in messages.ts and phases.ts, the markers in markers.ts.
import path from 'node:path'
import type { Config, Kind, QState, Verdict } from './types'

export const DIR = 'understanding'
/**
 * Where a branch's check waits while another branch is checked out: inside the extension's notes folder (git-ignored
 * there). The extension reads and writes it too (src/check/cliApi.ts), so this path is shared by both sides.
 */
export const CACHE = '.code-notes/.cache/checks'
export const KINDS: Kind[] = ['how', 'why', 'failure', 'edge', 'change']
/** `restated`: after an explanation, the author said the point back in their own words, rightly (counts as passed). */
export const VERDICTS: Verdict[] = ['pass', 'retry', 'explained', 'restated']
/**
 * A question's states (stateOf), by name: compare with these, not with string literals, so a search for one finds
 * every place that cares about it.
 */
export const STATE = {
  todo: 'todo',
  ungraded: 'ungraded',
  retry: 'retry',
  pass: 'pass',
  explained: 'explained',
  restated: 'restated',
} as const satisfies { [S in QState]: S }
export const DEFAULTS: Config = {
  questions: { min: 1, max: 5 }, passRatio: 0.6, maxDrift: 40, exempt: [], mode: 'required',
  skipLabel: 'skip-understanding', model: null, backend: null, mrComment: true,
}
/**
 * The grader's fixed settings. `model` is the anthropic backend's model when the config's "model" (DEFAULTS.model,
 * null: unset) and UNDERSTANDING_MODEL leave it open; the claude backend then uses Claude Code's own default.
 */
export const GRADER = {
  model: 'claude-opus-5-5',
  /** The Messages API's version header. */
  apiVersion: '2023-06-01',
  /** The reply's length limit. */
  maxTokens: 4000,
  /** How long one grade may take. */
  timeoutMs: 300_000,
} as const
/** At most this many questions in one file (the first set plus top-ups). */
export const MAX_QUESTIONS = 10
export const MAX_TEXT = 240
/** The check's journey (a guided tour of the change, `journey` in the file): at most this many steps (first set plus top-ups). */
export const MAX_TOUR_STEPS = 20
/** The merge request comment's line for reviewers when the check has a tour. */
export const TOUR_LINE = 'A guided tour of this change: open it in VS Code with Code Notes (Check view)'
/** The project's repository: the docs, the CI recipes and the skill, for people who only have this file. */
const REPO_URL = 'https://github.com/tomeyer97/code-notes'
export const DOCS_URL = `${REPO_URL}/blob/main/docs/understanding-check.md`
export const CI_URL = `${REPO_URL}#in-ci`
/** The skill that writes the questions (and, in Claude Code without VS Code, asks them in the chat). */
export const SKILL_URL = `${REPO_URL}/tree/main/skills/understanding-check`

/**
 * Where `init` puts the skill: Claude Code's project skills folder (`.claude/skills/<name>`), so anyone running Claude
 * Code in the repository can type /understanding-check.
 */
export const SKILL_DIR = '.claude/skills/understanding-check'

/**
 * This file's path: the built cli/understanding.mjs, or a copy of it (tools/understanding.mjs, the skill's
 * scripts/understanding.mjs). `init` copies it; run as a command, it runs main. Set by the entry (index.ts), the one
 * module that knows its own URL: the extension compiles these modules on their own, where it stays ''.
 */
let SELF = ''
/** Sets SELF (index.ts, from import.meta.url). */
const setSelf = (file: string): void => { SELF = file }
/** This file's path for a command line: relative to the repository when it is inside it, else "understanding.mjs". */
const cliName = (repo: string): string => {
  const me = path.relative(repo, SELF)
  return me && !me.startsWith('..') && !path.isAbsolute(me) ? me : 'understanding.mjs'
}

export { cliName, SELF, setSelf }
