// What Claude is asked when it writes the check: the prompt for the questions, the prompt for the tour, and the
// phase shown while it works (from its last tool call). No vscode API here (unit-tested in test/checkModel.test.ts).
import { READ_ONLY_TOOLS } from '../platform/agent/claude'
import type { ToolCall } from '../platform/agent/claude'
import type { Note } from '../notes/store'
import { isClaudeAnswer, lines, paragraph } from '../ask/prompts'

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

/** "Suggest a fix" on a check's concern, for lines `start`-`end`: the smallest change, as one suggestion block. */
const FIX_HINT = (start: number, end: number) => lines(
  'Suggest the smallest change that fixes it, and one that fits the problem:',
  'it must not rely on the thing that failed (no retry through the connection that just broke),',
  'and needs no new setting or environment variable unless there is no other way.',
  `Reply with one sentence (at most 25 words), then one ${'```'}suggestion block holding the new text of lines ${start}-${end}`,
  '(the lines of this note: the block replaces exactly those lines, so repeat the ones that stay as they are).',
  'Nothing more: no headings, no lists, no other code blocks, no tests.',
  'If the fix is not in these lines, say in one sentence where it is instead, without a block.',
)

/** A question about the code of a check question `q`: explain the code, never the check's answer. */
const CHECK_ASK_HINT = (q: string) => lines(
  `The person is answering an understanding check about this code. Its question: "${q}".`,
  'Explain the code they ask about; never write, or hint at, the answer to that check question: they answer it themselves.',
)

/** `extra.checkAsk` / `extra.checkFix` (the check question a note asks about, or suggests a fix for), when set. */
function checkExtra(n: Note): { checkAsk?: string; checkFix?: string } {
  const x = n.data.extra ?? {}
  return {
    ...(typeof x.checkAsk === 'string' ? { checkAsk: x.checkAsk } : {}),
    ...(typeof x.checkFix === 'string' ? { checkFix: x.checkFix } : {}),
  }
}

/**
 * What Ask Claude adds to a note's prompt for the check (its AskHandler's hint): a question about the code of a check
 * question: explain the code, never write that answer. "Suggest a fix" on a concern (until Claude has answered): the
 * smallest change, as one suggestion block (Apply puts it in; Undo takes it back).
 */
export function checkAskHint(n: Note): string {
  const x = checkExtra(n)
  if (x.checkFix && !n.data.target && !n.data.messages.some(isClaudeAnswer)) {
    return paragraph(FIX_HINT(n.data.range.start, n.data.range.end))
  }
  return x.checkAsk ? paragraph(CHECK_ASK_HINT(x.checkAsk)) : ''
}
