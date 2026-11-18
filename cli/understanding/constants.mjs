// The check's names, limits and links: what every other module (and the extension) shares.
import fs from 'node:fs'
import path from 'node:path'

export const DIR = 'understanding'
export const KINDS = ['how', 'why', 'failure', 'edge', 'change']
/** `restated`: after an explanation, the author said the point back in their own words, rightly (counts as passed). */
export const VERDICTS = ['pass', 'retry', 'explained', 'restated']
export const MARKER = '<!-- understanding-check -->'
export const DEFAULTS = {
  questions: { min: 1, max: 5 }, passRatio: 0.6, maxDrift: 40, exempt: [], mode: 'required',
  skipLabel: 'skip-understanding', model: null, backend: null, mrComment: true,
}
/** At most this many questions in one file (the first set plus top-ups). */
export const MAX_QUESTIONS = 10
export const MAX_TEXT = 240
/** The check's journey (a guided tour of the change, `journey` in the file): at most this many steps (first set plus top-ups). */
export const MAX_TOUR_STEPS = 20
/** The merge request comment's line for reviewers when the check has a tour. */
export const TOUR_LINE = 'A guided tour of this change: open it in VS Code with Code Notes (Check view)'
/** The design notes and the CI recipes, for people who only have this file. */
export const DOCS_URL = 'https://github.com/tomeyer97/code-notes/blob/main/docs/understanding-check.md'
export const CI_URL = 'https://github.com/tomeyer97/code-notes#in-ci'
/** The skill that writes the questions (and, in Claude Code without VS Code, asks them in the chat). */
export const SKILL_URL = 'https://github.com/tomeyer97/code-notes/tree/main/skills/understanding-check'
/**
 * The way without VS Code, the same in `status` and CI: /understanding-check in Claude Code (the skill, committed in
 * the repository by `init`, asks the questions one at a time in the chat). `installed`: the repository has the skill.
 */
export const withoutVsCode = (installed) => installed ? 'Without VS Code: type /understanding-check in Claude Code.' : `Without VS Code: add the understanding-check skill to .claude/skills (${SKILL_URL}), then type /understanding-check in Claude Code.`
/** The repository has the skill (`init` put it there). */
export const hasSkill = (repo) => fs.existsSync(path.join(repo, SKILL_DIR, 'SKILL.md'))

/** Where `init` puts the skill, so anyone running Claude Code in the repository can type /understanding-check. */
export const SKILL_DIR = '.claude/skills/understanding-check'
