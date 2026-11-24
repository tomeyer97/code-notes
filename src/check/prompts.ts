// What Claude is asked when it writes the check: the prompt for the questions, the prompt for the tour, and the
// phase shown while it works (from its last tool call). No vscode API here (unit-tested in test/checkModel.test.ts and
// the goldens in test/golden-check-agent.test.ts).
import { READ_ONLY_TOOLS } from '../platform/agent/claude'
import type { ToolCall } from '../platform/agent/claude'
import type { Note } from '../notes/store'
import { isClaudeAnswer, lines, paragraph } from '../ask/prompts'
import { phaseFromTool, type PhaseTable } from '../core/agentRun'

/** What a questions or tour prompt is about. `bundled`: the skill is the extension's copy (not installed). */
interface SkillPrompt { skill: string; bundled: boolean }

/**
 * The skill script's `start` command line (skills/understanding-check/scripts/questions.mjs): a top-up, else from
 * `base`; the branch and commit pinned when known (the person may switch branches while Claude works).
 */
export function startCommand(o: { skill: string; branch: string; base: string; topUp: boolean; head?: string }): string {
  const from = o.topUp ? '--top-up' : `--base ${o.base}`
  const pin = o.head ? ` --branch ${o.branch} --head ${o.head}` : ''
  return `${o.skill}/scripts/questions.mjs start ${from}${pin}`
}

/** The prompt for `claude -p` that writes (or tops up) the questions with the understanding-check skill. */
export function checkPrompt(o: SkillPrompt & { branch: string; baseRef: string; base: string; topUp: boolean; head?: string }): string {
  const how = o.bundled
    ? `Read ${o.skill}/SKILL.md and follow it exactly (it is the understanding-check skill; it is not installed, so do not look for it with the Skill tool)`
    : 'Use the understanding-check skill'
  const what = o.topUp
    ? 'add 1-2 questions about what changed since the understanding check of'
    : 'write the questions of an understanding check for'
  return [
    `${how} to ${what} this branch (${o.branch}, compared with ${o.baseRef}).`,
    `Start with: ${startCommand(o)}`,
    lines(
      `Run the script by its full path (${o.skill}/scripts/…), one command per call: no shell variables, no && or pipes.`,
      'Do not modify any other file.',
    ),
    'When done, reply with one line per question you wrote.',
  ].join('\n\n')
}

/**
 * The prompt that writes the check's tour (a journey of the change, embedded in the check file), right after the
 * questions: `resumed` when it goes on in the session that wrote them (the change is read already).
 */
export function tourPrompt(o: SkillPrompt & { journeySkill: string; topUp: boolean; resumed: boolean }): string {
  // A new session, or the extension's copy, needs the skill's path; the session that wrote the questions knows it.
  const which = o.bundled || !o.resumed ? `${o.skill}/SKILL.md` : 'the understanding-check skill'
  return [
    lines(
      `${o.resumed ? 'Now write' : 'Write'} the tour of this change, so the author can click their way to each answer.`,
      `Follow the section "The tour" of ${which}.`,
    ),
    `Start with: ${o.skill}/scripts/questions.mjs tour${o.topUp ? ' --top-up' : ''}`,
    lines(
      `Run the scripts by their full path (${o.skill}/scripts/… and ${o.journeySkill}/scripts/journey.py), one command per call:`,
      'no shell variables, no && or pipes (a heredoc for journey.py\'s text is fine).',
      'Do not modify any other file.',
    ),
    'When done, reply with the step titles, one per line.',
  ].join('\n\n')
}

/** The phases shown while Claude writes the check ("Writing questions · 0:42 · reading the change"). */
export const PHASE = {
  starting: 'starting',
  readingChange: 'reading the change',
  readingCode: 'reading the code',
  writingQuestions: 'writing questions',
  writingTour: 'writing the tour',
  checking: 'checking',
} as const

/** The phase a `questions.mjs <command>` call starts (other commands: the phase goes on). */
const PHASE_OF: Record<string, string> = {
  start: PHASE.readingChange,
  add: PHASE.writingQuestions,
  remove: PHASE.writingQuestions,
  finish: PHASE.checking,
  'tour-finish': PHASE.checking,
  tour: PHASE.writingTour,
}
const QUESTIONS_COMMAND = /questions\.mjs\s+([a-z-]+)/

/** How the check's writers read their phase: journey.py writes the tour; questions.mjs's command says the rest. */
const CHECK_PHASES: PhaseTable = {
  readTools: READ_ONLY_TOOLS,
  // A look at the code while writing is part of the writing.
  onRead: (prev) => (prev === PHASE.writingQuestions || prev === PHASE.writingTour ? prev : PHASE.readingCode),
  onCommand: (cmd) => {
    if (/journey\.py/.test(cmd)) return PHASE.writingTour
    const sub = QUESTIONS_COMMAND.exec(cmd)?.[1]
    return sub && Object.hasOwn(PHASE_OF, sub) ? PHASE_OF[sub] : undefined
  },
}

/** What Claude is doing while it writes the questions (or the tour), in plain words, from its last tool call. */
export function checkPhase(tool: ToolCall | undefined, prev: string): string {
  return phaseFromTool(tool, prev, CHECK_PHASES)
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
