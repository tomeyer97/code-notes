// `init`: the repository set up for checks (check files out of diffs and search), and the skill put in it.
import fs from 'node:fs'
import path from 'node:path'
import { DIR, SELF, SKILL_DIR } from './constants'
import { gitOk } from './git'
import { SKILL_FILES } from './skillFiles'

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


/** What installSkill writes: the skill's files (`files`: path in the skill → text) and this CLI file (`cli`). */
export interface SkillSource { files: Readonly<Record<string, string>>; cli: string }

/**
 * The skill to install: the one beside this copy of the CLI, as it ships (the built cli/understanding.mjs has it at
 * ../skills/understanding-check; the skill's own copy, <skill>/scripts/understanding.mjs, is inside it), else the copy
 * this file carries (SKILL_FILES: a CLI copied elsewhere, e.g. tools/understanding.mjs, still installs it).
 */
export function skillSource(cli: string = SELF): SkillSource {
  const here = path.dirname(cli)
  const names = Object.keys(SKILL_FILES)
  const dir = cli ? [path.join(here, '../skills/understanding-check'), path.join(here, '..')].find((d) => names.every((f) => fs.existsSync(path.join(d, f)))) : undefined
  const files = dir ? Object.fromEntries(names.map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')])) : SKILL_FILES
  return { files, cli }
}
/** The repository has the skill (`init` put it there). */
export const hasSkill = (repo: string): boolean => fs.existsSync(path.join(repo, SKILL_DIR, 'SKILL.md'))
/**
 * The repository's own copy of the CLI outside the skill's folder (e.g. tools/understanding.mjs): committed, or this
 * very file when it runs from inside the repository (copied in, not committed yet).
 */
function repoCli(repo: string, cli: string): string | undefined {
  const committed = (gitOk(repo, ['ls-files', '--', ':(glob)**/understanding.mjs']) ?? '').split('\n').find((f) => f && !f.startsWith(`${SKILL_DIR}/`))
  if (committed || !cli) return committed
  const rel = path.relative(fs.realpathSync(repo), fs.realpathSync(cli)).split(path.sep).join('/')
  return !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.startsWith(`${SKILL_DIR}/`) ? rel : undefined
}

/**
 * Puts the skill in the repository (SKILL_DIR: SKILL.md and its script), so anyone running Claude Code there can type
 * /understanding-check, and the CLI beside it unless the repository has a copy of its own (the script finds that
 * one). `from`: what to write (skillSource). Written when missing or different; returns the files written.
 */
export function installSkill(repo: string, from: SkillSource = skillSource()): string[] {
  const want: [string, Buffer][] = Object.entries(from.files).map(([rel, text]) => [rel, Buffer.from(text)])
  if (from.cli && !repoCli(repo, from.cli)) want.push(['scripts/understanding.mjs', fs.readFileSync(from.cli)])
  const out: string[] = []
  for (const [rel, text] of want) {
    const to = path.join(repo, SKILL_DIR, rel)
    let have: Buffer | undefined
    try { have = fs.readFileSync(to) } catch { /* new */ }
    if (have && have.equals(text)) continue
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.writeFileSync(to, text)
    out.push(`${SKILL_DIR}/${rel}`)
  }
  return out
}
