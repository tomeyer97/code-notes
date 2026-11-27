// The Claude Code skills a note's question may use (setting codeNotes.claude.skills): the Skill tool, Bash for each
// skill's own scripts only, its cache folder, and the hint that tells Claude so. Looked up on each ask, without
// blocking (a skill installed meanwhile is used at once).

import * as fs from 'fs'
import * as path from 'path'
import { cfg } from '../platform/settings'
import { skillCacheDir, skillDir, skillsDir } from '../platform/agent/claudeHome'
import { SKILLS_HINT } from './prompts'

export interface SkillAccess {
  tools: string[]
  dirs: string[]
  hint: string
}

const there = (p: string) => fs.promises.access(p).then(() => true, () => false)
/** The items of `xs` for which `test` holds, in their order. */
async function those<T>(xs: T[], test: (x: T) => Promise<boolean>): Promise<T[]> {
  const ok = await Promise.all(xs.map(test))
  return xs.filter((_, i) => ok[i])
}

/** The skills of the setting that are installed, and what Claude may do with them. */
export async function skillAccess(): Promise<SkillAccess> {
  const wanted = cfg().get<string[]>('claude.skills') ?? []
  const names = await those(wanted, (x) => there(path.join(skillDir(x), 'SKILL.md')))
  if (!names.length) return { tools: [], dirs: [], hint: '' }
  const tools = ['Skill', ...names.map((x) => `Bash(${skillDir(x)}/scripts/*)`)]
  const dirs = await those(names.map((x) => skillCacheDir(x)), there)
  return { tools, dirs, hint: `\n\n${SKILLS_HINT(names, skillsDir())}` }
}
