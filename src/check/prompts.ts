// What Claude is asked when it writes the check: the prompt for the questions, the prompt for the tour, and the
// phase shown while it works (from its last tool call). No vscode API here (unit-tested in test/checkModel.test.ts).
import { READ_ONLY_TOOLS } from '../claude'
import type { ToolCall } from '../claude'

/** The prompt for `claude -p` that writes (or tops up) the questions with the understanding-check skill. */
export function checkPrompt(o: { skill: string; branch: string; baseRef: string; base: string; topUp: boolean; bundled: boolean; head?: string }): string {
  const how = o.bundled
    ? `Read ${o.skill}/SKILL.md and follow it exactly (it is the understanding-check skill; it is not installed, so do not look for it with the Skill tool)`
    : 'Use the understanding-check skill'
  // The branch and commit are pinned: the person may switch branches while this runs.
  const pin = o.head ? ` --branch ${o.branch} --head ${o.head}` : ''
  const start = `${o.skill}/scripts/questions.mjs start ${o.topUp ? '--top-up' : `--base ${o.base}`}${pin}`
  return [
    `${how} to ${o.topUp ? 'add 1-2 questions about what changed since the understanding check of' : 'write the questions of an understanding check for'} this branch (${o.branch}, compared with ${o.baseRef}).`,
    `Start with: ${start}`,
    `Run the script by its full path (${o.skill}/scripts/…), one command per call: no shell variables, no && or pipes. Do not modify any other file.`,
    'When done, reply with one line per question you wrote.',
  ].join('\n\n')
}

/**
 * The prompt that writes the check's tour (a journey of the change, embedded in the check file), right after the
 * questions: `resumed` when it goes on in the session that wrote them (the change is read already).
 */
export function tourPrompt(o: { skill: string; journeySkill: string; topUp: boolean; bundled: boolean; resumed: boolean }): string {
  const how = o.bundled || !o.resumed ? `Follow the section "The tour" of ${o.skill}/SKILL.md` : 'Follow the section "The tour" of the understanding-check skill'
  return [
    `${o.resumed ? 'Now write' : 'Write'} the tour of this change, so the author can click their way to each answer. ${how}.`,
    `Start with: ${o.skill}/scripts/questions.mjs tour${o.topUp ? ' --top-up' : ''}`,
    `Run the scripts by their full path (${o.skill}/scripts/… and ${o.journeySkill}/scripts/journey.py), one command per call: no shell variables, no && or pipes (a heredoc for journey.py's text is fine). Do not modify any other file.`,
    'When done, reply with the step titles, one per line.',
  ].join('\n\n')
}

/** The phase a `questions.mjs <command>` call starts (other commands: the phase goes on). */
const PHASE_OF: Record<string, string> = {
  start: 'reading the change',
  add: 'writing questions',
  remove: 'writing questions',
  finish: 'checking',
  'tour-finish': 'checking',
  tour: 'writing the tour',
}

/** What Claude is doing while it writes the questions (or the tour), in plain words, from its last tool call. */
export function checkPhase(tool: ToolCall | undefined, prev: string): string {
  if (!tool) return prev
  if (tool.name !== 'Bash') {
    // A look at the code while writing is part of the writing.
    const writing = prev === 'writing questions' || prev === 'writing the tour'
    return READ_ONLY_TOOLS.includes(tool.name) && !writing ? 'reading the code' : prev
  }
  const cmd = String(tool.input?.command ?? '')
  if (/journey\.py/.test(cmd)) return 'writing the tour'
  const m = /questions\.mjs\s+([a-z-]+)/.exec(cmd)
  return m && Object.hasOwn(PHASE_OF, m[1]) ? PHASE_OF[m[1]] : prev
}
