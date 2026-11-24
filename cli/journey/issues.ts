// What a check finds, in the words journey.py prints. One shape for every check (scene, marks, links, values).

/** problem: refused when written, a PROBLEM in `check`; refuse: refused when written, a WARNING in `check`;
 *  warning: a WARNING. */
export type Level = 'problem' | 'refuse' | 'warning'

export interface Issue { level: Level; text: string }

/** Collects issues whose text starts with `prefix`. */
export function collector(prefix = '') {
  const issues: Issue[] = []
  const add = (level: Level) => (text: string) => { issues.push({ level, text: prefix + text }) }
  return { issues, problem: add('problem'), refuse: add('refuse'), warning: add('warning') }
}
