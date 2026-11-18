// `init`: the repository set up for checks (check files out of diffs and search), and the skill put in it.
import fs from 'node:fs'
import path from 'node:path'
import { DIR, SELF, SKILL_DIR } from './constants.mjs'
import { gitOk } from './git.mjs'

/**
 * What `init` makes sure of: the check files collapsed in merge request diffs (GitLab reads `gitlab-generated`, GitHub
 * `linguist-generated`), and skipped by ripgrep, VS Code's search and similar.
 */
export const INIT_LINES = {
  // The settings stay in sight: a merge request that changes them shows the change.
  '.gitattributes': [`${DIR}/*.json gitlab-generated linguist-generated`, `${DIR}/config.json -gitlab-generated -linguist-generated`],
  '.ignore': [`${DIR}/`],
}
/** Lines an earlier `init` wrote, replaced by today's. */
const OLD_LINES = { '.gitattributes': [`${DIR}/*.json linguist-generated=true`] }

/** The `init` lines the repository doesn't have yet (in its working tree), as "file: line". */
export function setupMissing(repo) {
  const out = []
  for (const [name, want] of Object.entries(INIT_LINES)) {
    let text = ''
    try { text = fs.readFileSync(path.join(repo, name), 'utf8') } catch { /* none */ }
    const have = new Set(text.split(/\r?\n/).map((l) => l.trim()))
    out.push(...want.filter((l) => !have.has(l)).map((l) => `${name}: ${l}`))
  }
  return out
}

/**
 * Writes or extends `.gitattributes` and `.ignore` in the repository's root so the check files stay out of diffs and
 * search. Idempotent: a line already there (ignoring surrounding spaces) is never added twice; a line an earlier
 * version wrote is replaced in place. `only`: that file alone. Returns what it added, as "file: line".
 */
export function initRepo(repo, { only } = {}) {
  const added = []
  for (const [name, want] of Object.entries(INIT_LINES)) {
    if (only && name !== only) continue
    const file = path.join(repo, name)
    let text = ''
    try { text = fs.readFileSync(file, 'utf8') } catch { /* a new file */ }
    const have = new Set(text.split(/\r?\n/).map((l) => l.trim()))
    const missing = want.filter((l) => !have.has(l))
    if (!missing.length) continue
    const old = (OLD_LINES[name] ?? []).find((l) => have.has(l))
    if (old) text = text.split(/(\r?\n)/).map((l) => (l.trim() === old ? missing.shift() : l)).join('')
    if (missing.length) text = `${text}${text && !text.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`
    fs.writeFileSync(file, text)
    added.push(...want.filter((l) => !have.has(l)).map((l) => `${name}: ${l}`))
  }
  return added
}

/**
 * The first check committed in a repository also folds check files in merge request diffs: true while its
 * `.gitattributes` lacks the line (`init` writes it too). `.ignore` stays `init`'s.
 */
export const foldMissing = (repo) => setupMissing(repo).some((l) => l.startsWith('.gitattributes:'))
/** Writes the `.gitattributes` lines that fold check files in diffs (when missing); returns what it added. */
export const foldDiffs = (repo) => initRepo(repo, { only: '.gitattributes' })
/** What a check commit says it also does, beside the file: "also folds check files in diffs (.gitattributes)". */
export const FOLD_TEXT = 'also folds check files in diffs (.gitattributes)'


/** Where the skill ships beside this file (in the extension and in its repository), if it does. */
const skillSource = () => {
  const here = path.dirname(SELF)
  return [path.join(here, '../skills/understanding-check'), path.join(here, '..')].find((d) => fs.existsSync(path.join(d, 'SKILL.md')) && fs.existsSync(path.join(d, 'scripts/questions.mjs')))
}
/** The CLI the repository has committed already (e.g. tools/understanding.mjs), outside the skill's folder. */
const committedCli = (repo) => (gitOk(repo, ['ls-files', '--', ':(glob)**/understanding.mjs']) ?? '').split('\n').find((f) => f && !f.startsWith(`${SKILL_DIR}/`))

/**
 * Puts the skill in the repository (`.claude/skills/understanding-check`: SKILL.md and its script), so anyone running
 * Claude Code there can type /understanding-check, and the CLI beside it unless the repository has a copy committed
 * already (the script finds that one). Written when missing or different; returns the files written, or undefined
 * when this copy of the CLI has no skill beside it.
 */
export function installSkill(repo) {
  const src = skillSource()
  if (!src) return undefined
  const want = [['SKILL.md', path.join(src, 'SKILL.md')], ['scripts/questions.mjs', path.join(src, 'scripts/questions.mjs')]]
  if (!committedCli(repo)) want.push(['scripts/understanding.mjs', SELF])
  const out = []
  for (const [rel, from] of want) {
    const to = path.join(repo, SKILL_DIR, rel)
    const text = fs.readFileSync(from)
    let have
    try { have = fs.readFileSync(to) } catch { /* new */ }
    if (have && have.equals(text)) continue
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.writeFileSync(to, text)
    out.push(`${SKILL_DIR}/${rel}`)
  }
  return out
}
