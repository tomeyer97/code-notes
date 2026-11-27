// `init`: the repository set up for checks (check files out of diffs and search), and the skill put in it.
import fs from 'node:fs'
import path from 'node:path'
import { DIR, SELF, SKILL_DIR } from './constants'
import { gitOk } from './git'

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
const OLD_LINES: Record<string, string[]> = { '.gitattributes': [`${DIR}/*.json linguist-generated=true`] }

/**
 * One of `init`'s files as it is in the working tree (`text`, '' when there is none) and the lines it lacks
 * (`missing`; a line counts as there whatever spaces surround it; `have`: its lines, trimmed).
 */
function missingLines(repo: string, name: keyof typeof INIT_LINES): { text: string; have: Set<string>; missing: string[] } {
  let text = ''
  try { text = fs.readFileSync(path.join(repo, name), 'utf8') } catch { /* no such file yet */ }
  const have = new Set(text.split(/\r?\n/).map((l) => l.trim()))
  return { text, have, missing: INIT_LINES[name].filter((l) => !have.has(l)) }
}
const INIT_FILES = Object.keys(INIT_LINES) as (keyof typeof INIT_LINES)[]

/** The `init` lines the repository doesn't have yet (in its working tree), as "file: line". */
export function setupMissing(repo: string): string[] {
  return INIT_FILES.flatMap((name) => missingLines(repo, name).missing.map((l) => `${name}: ${l}`))
}

/**
 * Writes or extends `.gitattributes` and `.ignore` in the repository's root so the check files stay out of diffs and
 * search. Idempotent: a line already there (ignoring surrounding spaces) is never added twice; a line an earlier
 * version wrote is replaced in place. `only`: that file alone. Returns what it added, as "file: line".
 */
export function initRepo(repo: string, { only }: { only?: string } = {}): string[] {
  const added: string[] = []
  for (const name of INIT_FILES) {
    if (only && name !== only) continue
    const { text: was, have, missing } = missingLines(repo, name)
    let text = was
    if (!missing.length) continue
    added.push(...missing.map((l) => `${name}: ${l}`))
    const old = (OLD_LINES[name] ?? []).find((l) => have.has(l))
    if (old) text = text.split(/(\r?\n)/).map((l) => (l.trim() === old ? missing.shift() : l)).join('')
    if (missing.length) text = `${text}${text && !text.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`
    fs.writeFileSync(path.join(repo, name), text)
  }
  return added
}

/**
 * The first check committed in a repository also folds check files in merge request diffs: true while its
 * `.gitattributes` lacks the line (`init` writes it too). `.ignore` stays `init`'s.
 */
export const foldMissing = (repo: string): boolean => setupMissing(repo).some((l) => l.startsWith('.gitattributes:'))
/** Writes the `.gitattributes` lines that fold check files in diffs (when missing); returns what it added. */
export const foldDiffs = (repo: string): string[] => initRepo(repo, { only: '.gitattributes' })
/** What a check commit says it also does, beside the file: "also folds check files in diffs (.gitattributes)". */
export const FOLD_TEXT = 'also folds check files in diffs (.gitattributes)'


/** What installSkill copies: the skill's folder (SKILL.md, scripts/questions.mjs) and this CLI file. */
export interface SkillSource { dir: string; cli: string }

/**
 * Where this copy of the CLI finds the skill to install: beside it, as it ships. The built cli/understanding.mjs (in
 * the extension and in its repository) has it at ../skills/understanding-check; the skill's own copy
 * (<skill>/scripts/understanding.mjs) is inside it. A copy elsewhere (a CI download) has none: undefined.
 */
export function skillSource(cli: string = SELF): SkillSource | undefined {
  const here = path.dirname(cli)
  const dir = [path.join(here, '../skills/understanding-check'), path.join(here, '..')].find((d) => fs.existsSync(path.join(d, 'SKILL.md')) && fs.existsSync(path.join(d, 'scripts/questions.mjs')))
  return dir ? { dir, cli } : undefined
}
/** The repository has the skill (`init` put it there). */
export const hasSkill = (repo: string): boolean => fs.existsSync(path.join(repo, SKILL_DIR, 'SKILL.md'))
/** The CLI the repository has committed already (e.g. tools/understanding.mjs), outside the skill's folder. */
const committedCli = (repo: string): string | undefined => (gitOk(repo, ['ls-files', '--', ':(glob)**/understanding.mjs']) ?? '').split('\n').find((f) => f && !f.startsWith(`${SKILL_DIR}/`))

/**
 * Puts the skill in the repository (SKILL_DIR: SKILL.md and its script), so anyone running Claude Code there can type
 * /understanding-check, and the CLI beside it unless the repository has a copy committed already (the script finds
 * that one). `from`: what to copy (skillSource: what ships beside this file). Written when missing or different;
 * returns the files written, or undefined when there is no skill to copy.
 */
export function installSkill(repo: string, from: SkillSource | undefined = skillSource()): string[] | undefined {
  if (!from) return undefined
  const want: [string, string][] = [['SKILL.md', path.join(from.dir, 'SKILL.md')], ['scripts/questions.mjs', path.join(from.dir, 'scripts/questions.mjs')]]
  if (!committedCli(repo)) want.push(['scripts/understanding.mjs', from.cli])
  const out: string[] = []
  for (const [rel, from] of want) {
    const to = path.join(repo, SKILL_DIR, rel)
    const text = fs.readFileSync(from)
    let have: Buffer | undefined
    try { have = fs.readFileSync(to) } catch { /* new */ }
    if (have && have.equals(text)) continue
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.writeFileSync(to, text)
    out.push(`${SKILL_DIR}/${rel}`)
  }
  return out
}
