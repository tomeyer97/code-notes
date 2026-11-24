// Where a Claude Code skill is: the repository's own copy (a team can pin and adapt it), else the home folder's, else
// the one that ships with the extension. No vscode API here (unit-tested in test/skillDir.test.ts).
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/** A skill's folder; `bundled`: the extension's copy (Claude Code does not know it as a skill: prompts name its SKILL.md). */
export interface SkillDir { dir: string; bundled: boolean }

/**
 * Skill `name`'s first folder that has `marker` (a path inside it, e.g. "scripts/questions.mjs"): in `repo`'s
 * .claude/skills, in the home folder's, else `bundled` (the extension's skills folder). Undefined when none has it.
 */
export function findSkill(name: string, o: { repo?: string; bundled: string; marker: string; home?: string }): SkillDir | undefined {
  const home = o.home ?? os.homedir()
  const dirs = [
    ...(o.repo ? [path.join(o.repo, '.claude/skills', name)] : []),
    path.join(home, '.claude/skills', name),
    path.join(o.bundled, name),
  ]
  const dir = dirs.find((d) => fs.existsSync(path.join(d, o.marker)))
  return dir ? { dir, bundled: dir === path.join(o.bundled, name) } : undefined
}
