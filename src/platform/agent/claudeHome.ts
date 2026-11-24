// Claude Code's own folders: where its skills live and where a skill keeps its cache. No vscode API here.
import * as os from 'os'
import * as path from 'path'

/** ~/.claude/skills: a skill is a folder there with a SKILL.md (and its scripts in scripts/). */
export const skillsDir = (home = os.homedir()) => path.join(home, '.claude', 'skills')

/** A skill's own folder. */
export const skillDir = (name: string, home = os.homedir()) => path.join(skillsDir(home), name)

/** Where a skill keeps its cache ($XDG_CACHE_HOME/<name>, else ~/.cache/<name>). */
export const skillCacheDir = (name: string, home = os.homedir()) => path.join(process.env.XDG_CACHE_HOME ?? path.join(home, '.cache'), name)
