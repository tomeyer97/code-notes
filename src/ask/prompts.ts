// What Claude is told when it answers a note: the note and its conversation, the rules, and the hints for a step's
// question and the skills it may use (a feature adds its own hints through its AskHandler: handlers.ts). Only text, no vscode API: ask/run.ts sends it
// (snapshot-tested in test/askPrompts.test.ts).

import type { Message } from '../core/format/noteModel'
import type { Note } from '../notes/store'
import { UPDATE_ASK } from '../tour/texts'

/** The author of Claude's answers in a thread. */
export const CLAUDE_AUTHOR = 'Claude'

/**
 * One of Claude's own answers: an agent's message by Claude (the check's questions and other agents' messages are
 * agent messages too, and are part of what Claude has not seen).
 */
export const isClaudeAnswer = (m: Message) => m.role === 'agent' && m.author === CLAUDE_AUTHOR

/** A prompt written as one sentence or clause per line, read as one paragraph. */
export const lines = (...parts: string[]) => parts.join(' ')

/** How Claude works on a note and answers. */
const RULES = lines(
  'Read whatever code you need (Read, Grep, Glob); do not modify files.',
  'Reply in concise markdown;',
  'reference code as path:line (relative to the repository root) so it becomes a link.',
  'Your reply is posted into the note thread as is.',
)

/** A question asked on a journey step: the answer first, short (a yes/no question gets its yes or no). */
const STEP_HINT = lines(
  'Start with a one-line answer (yes or no first, for a yes/no question), then at most 2-4 sentences.',
  'No headings, no lists unless asked; more only if asked.',
)

/** The skills `names` a note may use, and how to run their scripts (`skillsDir`: the folder holding them). */
export const SKILLS_HINT = (names: string[], skillsDir: string) => lines(
  `If the note asks for something one of these skills does, use it: ${names.join(', ')}.`,
  `Run a skill's scripts by their full path (${skillsDir}/<skill>/scripts/…), one command per call:`,
  'no shell variables, no && or pipes (anything else is refused).',
  "When you are done, reply with a short summary; findings you wrote as notes don't need repeating.",
)

/** A hint is a paragraph of its own after the prompt. */
export const paragraph = (text: string) => `\n\n${text}`

/** A code block of `text`. */
export const fenced = (text: string) => `${'```'}\n${text}\n${'```'}`

/** The journey a step's question was asked on (`extra.journey`), if any. */
const journeyOf = (n: Note): unknown => n.data.extra?.journey

/** A question asked on a journey step (not an "update the step" request): STEP_HINT. */
export function stepAskHint(n: Note): string {
  return journeyOf(n) && !n.data.messages[0]?.body.startsWith(UPDATE_ASK) ? paragraph(STEP_HINT) : ''
}

/** Where the note is, in words: "the folder x/", "the whole file x", "x lines 3-5". */
function placeOf(n: Note): string {
  const d = n.data
  if (d.target === 'folder') return `the folder ${d.file}/`
  return d.target ? `the whole file ${d.file}` : `${d.file} lines ${d.range.start}-${d.range.end}`
}

/** A follow-up (Claude answered before, in session `claudeSession`): only what was said since its last answer. */
function followUpPrompt(n: Note, lastAnswer: number): string {
  const d = n.data
  const fresh = d.messages.slice(lastAnswer + 1).map((m) => `${m.author}: ${m.body}`).join('\n\n')
  const changed = d.stale ? ', and the code there changed' : ''
  return `Follow-up on the same note (now on ${placeOf(n)}${changed}):\n\n${fresh}\n\nAnswer it. ${RULES}`
}

/** The first question on a note: the note, its code (`code`: the file's lines), the conversation, what to answer. */
function firstPrompt(n: Note, code: string[] | undefined, me: string): string {
  const d = n.data
  const snippet = code && !d.target ? code.slice(d.range.start - 1, d.range.end).join('\n') : ''
  const staleNote = d.stale ? ' (the code there has changed since; the note was about the lines under "Originally")' : ''
  const said = (m: Message) => `${m.author}${m.role ? ` (${m.role})` : ''}: ${m.body}`
  const parts = [
    `${me} left a note on ${placeOf(n)} in this repository${staleNote}:`,
    snippet && fenced(snippet),
    d.selection ? `It is about this exact text: \`${d.selection.text}\`` : '',
    d.stale && d.anchor.text ? `Originally:\n${fenced(d.anchor.text)}` : '',
    'The conversation so far:',
    d.messages.map(said).join('\n\n'),
    `Answer ${me}'s latest message. ${RULES}`,
  ]
  return parts.filter(Boolean).join('\n\n')
}

/** The prompt for a note (`me`: the person's name): a follow-up in Claude's session, else the first one. */
export function claudePrompt(n: Note, code: string[] | undefined, me: string): string {
  const lastAnswer = n.data.messages.map(isClaudeAnswer).lastIndexOf(true)
  return n.data.claudeSession && lastAnswer >= 0 ? followUpPrompt(n, lastAnswer) : firstPrompt(n, code, me)
}
