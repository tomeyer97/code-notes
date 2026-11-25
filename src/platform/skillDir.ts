// Where a Claude Code skill is: the repository's own copy (a team can pin and adapt it), else the home folder's, else
// the one that ships with the extension. No vscode API here (unit-tested in test/skillDir.test.ts).
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/** A skill's folder; `bundled`: the extension's copy (Claude Code does not know it as a skill: prompts name its SKILL.md). */
export interface SkillDir { dir: string; bundled: boolean }

/** Where skill `name` is looked for, in order (`repo`: the repository, when there is one); and how a message names it. */
export interface SkillLookup { repo?: string; bundled: string; home?: string }

/** The places skill `name` is looked for, in order, each with how a message names it. */
export function skillPlaces(name: string, o: SkillLookup): { dir: string; said: string }[] {
  const home = o.home ?? os.homedir()
  return [
    ...(o.repo ? [{ dir: path.join(o.repo, '.claude/skills', name), said: `this repository (.claude/skills/${name})` }] : []),
    { dir: path.join(home, '.claude/skills', name), said: '~/.claude/skills' },
    { dir: path.join(o.bundled, name), said: 'the extension' },
  ]
}

/**
 * Skill `name`'s first folder that has `marker` (a path inside it, e.g. "scripts/questions.mjs"): in `repo`'s
 * .claude/skills, in the home folder's, else `bundled` (the extension's skills folder). Undefined when none has it.
 */
export function findSkill(name: string, o: SkillLookup & { marker: string }): SkillDir | undefined {
  const dir = skillPlaces(name, o).map((p) => p.dir).find((d) => fs.existsSync(path.join(d, o.marker)))
  return dir ? { dir, bundled: dir === path.join(o.bundled, name) } : undefined
}

/** "the code-journey skill isn't in this repository (…), in ~/.claude/skills or in the extension": made from the lookup. */
export function missingSkill(name: string, o: SkillLookup): string {
  const places = skillPlaces(name, o).map((p) => `in ${p.said}`)
  return `the ${name} skill isn't ${places.slice(0, -1).join(', ')} or ${places.at(-1)}`
}
