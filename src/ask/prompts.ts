// What Claude is told when it answers a note: the note and its conversation, the rules, and the hints for a step's
// question, an understanding check and the skills it may use. Only text: ask/run.ts sends it.

import { me } from '../notes/identity'
import { Note } from '../notes/store'
import { UPDATE_ASK } from '../tour/texts'

/** How Claude works on a note and answers. */
const RULES =
  'Read whatever code you need (Read, Grep, Glob); do not modify files. Reply in concise markdown; ' +
  'reference code as path:line (relative to the repository root) so it becomes a link. Your reply is posted into the note thread as is.'

/** A question asked on a journey step: the answer first, short (a yes/no question gets its yes or no). */
const STEP_HINT =
  'Start with a one-line answer (yes or no first, for a yes/no question), then at most 2-4 sentences. ' +
  'No headings, no lists unless asked; more only if asked.'

/** "Suggest a fix" on a check's concern, for lines `start`-`end`: the smallest change, as one suggestion block. */
const FIX_HINT = (start: number, end: number) =>
  'Suggest the smallest change that fixes it, and one that fits the problem: it must not rely on the thing that failed ' +
  '(no alert through the mail server that is down), and needs no new setting or environment variable unless there is no other way. ' +
  `Reply with one sentence (at most 25 words), then one \`\`\`suggestion block holding the new text of lines ${start}-${end} ` +
  '(the lines of this note: the block replaces exactly those lines, so repeat the ones that stay as they are). ' +
  'Nothing more: no headings, no lists, no other code blocks, no tests. ' +
  'If the fix is not in these lines, say in one sentence where it is instead, without a block.'

/** A question about the code of a check question `q`: explain the code, never the check's answer. */
const CHECK_ASK_HINT = (q: string) =>
  `The person is answering an understanding check about this code. Its question: "${q}". ` +
  'Explain the code they ask about; never write, or hint at, the answer to that check question: they answer it themselves.'

/** The skills `names` a note may use, and how to run their scripts (`home`: the home folder). */
export const SKILLS_HINT = (names: string[], home: string) =>
  `If the note asks for something one of these skills does, use it: ${names.join(', ')}. ` +
  `Run a skill's scripts by their full path (${home}/.claude/skills/<skill>/scripts/…), one command per call: ` +
  'no shell variables, no && or pipes (anything else is refused). ' +
  "When you are done, reply with a short summary; findings you wrote as notes don't need repeating."

/** A hint is a paragraph of its own after the prompt. */
const paragraph = (text: string) => `\n\n${text}`

/** A question asked on a journey step (not an "update the step" request): STEP_HINT. */
export function stepAskHint(n: Note): string {
  const x = n.data.extra as { journey?: unknown } | undefined
  return x?.journey && !n.data.messages[0]?.body.startsWith(UPDATE_ASK) ? paragraph(STEP_HINT) : ''
}

/**
 * A question asked about the code of an understanding-check question: explain the code, never write that answer.
 * "Suggest a fix" on a concern (until Claude has answered): the smallest change, as one suggestion block (Apply puts
 * it in; Undo takes it back).
 */
export function checkHint(n: Note): string {
  const x = n.data.extra as { checkAsk?: string; checkFix?: string } | undefined
  if (x?.checkFix && !n.data.target && !n.data.messages.some((m) => m.author === 'Claude')) {
    return paragraph(FIX_HINT(n.data.range.start, n.data.range.end))
  }
  return x?.checkAsk ? paragraph(CHECK_ASK_HINT(x.checkAsk)) : ''
}

/** Where the note is, in words: "the folder x/", "the whole file x", "x lines 3-5". */
function placeOf(n: Note): string {
  const d = n.data
  if (d.target === 'folder') return `the folder ${d.file}/`
  return d.target ? `the whole file ${d.file}` : `${d.file} lines ${d.range.start}-${d.range.end}`
}

/**
 * The prompt for a note: a follow-up (Claude answered before, in the same session) gets only what was said since;
 * else the note, its code (`code`: the file's lines), the conversation so far and what to answer.
 */
export function claudePrompt(n: Note, code: string[] | undefined): string {
  const d = n.data
  const where = placeOf(n)
  const lastClaude = d.messages.map((m) => m.author === 'Claude').lastIndexOf(true)
  if (d.claudeSession && lastClaude >= 0) {
    const fresh = d.messages.slice(lastClaude + 1).map((m) => `${m.author}: ${m.body}`).join('\n\n')
    const changed = d.stale ? ', and the code there changed' : ''
    return `Follow-up on the same note (now on ${where}${changed}):\n\n${fresh}\n\nAnswer it. ${RULES}`
  }
  const snippet = code && !d.target ? code.slice(d.range.start - 1, d.range.end).join('\n') : ''
  const staleNote = d.stale ? ' (the code there has changed since; the note was about the lines under "Originally")' : ''
  return [
    `${me()} left a note on ${where} in this repository${staleNote}:`,
    snippet ? '```\n' + snippet + '\n```' : '',
    d.selection ? `It is about this exact text: \`${d.selection.text}\`` : '',
    d.stale && d.anchor.text ? `Originally:\n\`\`\`\n${d.anchor.text}\n\`\`\`` : '',
    'The conversation so far:',
    d.messages.map((m) => `${m.author}${m.role ? ` (${m.role})` : ''}: ${m.body}`).join('\n\n'),
    `Answer ${me()}'s latest message. ${RULES}`,
  ].filter(Boolean).join('\n\n')
}
