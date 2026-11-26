// Which changed files count: never the check's own files, nor an `exempt` glob; documentation files.
import { DIR, SKILL_DIR } from './constants'

/** A glob as a RegExp: `**` any path, `*` and `?` within a name; a pattern without "/" matches the name in any folder. */
export function globRe(glob: string): RegExp {
  const g = String(glob).replace(/^\.?\//, '')
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*' && g[i + 1] === '*') { const dir = g[i + 2] === '/'; re += dir ? '(?:.*/)?' : '.*'; i += dir ? 2 : 1 }
    else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${g.includes('/') ? '^' : '(^|/)'}${re}$`)
}
/** Documentation files: a change made only of these gets one question about what a reader sees differently. */
export const isDoc = (file: string): boolean => /\.(md|mdx|markdown|rst|adoc|txt)$/i.test(file) || /(^|\/)docs?\//i.test(file)

/**
 * Files that never count: the check itself, Code Notes' notes, what `init` writes for them (its lines, the skill) and
 * a committed copy of this CLI (tools/understanding.mjs: the docs suggest one for CI).
 */
export const own = (file: string): boolean => file.startsWith(`${DIR}/`) || file.startsWith('.code-notes/') || file === '.gitattributes' || file === '.ignore' || file.startsWith(`${SKILL_DIR}/`) || /(^|\/)understanding\.mjs$/.test(file)
/** Whether a changed file counts: not the check itself, not one of the config's `exempt` globs (none by default). */
export function counted(file: string, exempt: string[] = []): boolean {
  return !own(file) && !exempt.some((g) => globRe(g).test(file))
}
