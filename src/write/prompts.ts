// What Claude is told when it writes a journey or refreshes one, and the one line of its reply the extension reads.
// No vscode API here (golden text: test/writePrompts.test.ts).
import { skillPreamble } from '../core/agentText'

const SKILL = 'code-journey'

/** Paragraphs of a prompt. */
const paragraphs = (...ps: string[]) => ps.join('\n\n')
/** Sentences of one paragraph, written one per line here. */
const sentences = (...ss: string[]) => ss.join(' ')

/** How the rules for journey.py's commands end: Claude runs them one by one, so each call matches its Bash rule. */
const oneCommandPerCall = (skill: string) =>
  `Run its scripts by their full path (${skill}/scripts/…), one command per call: no shell variables, no && or pipes.`

/** The line Claude ends with when a journey already answers the request (instead of writing one). */
export const ANSWERED_BY = 'ANSWERED_BY:'

/**
 * The prompt that writes a journey for `request` (the person's words). `stage`: the folder, relative to the
 * repository, journey.py writes into; Code Notes moves the journey into `journeysFolder` once `check` passes.
 */
export function journeyPrompt(request: string, skill: string, stage: string, journeysFolder: string, bundled = false): string {
  const asked = request.replace(/\s+/g, ' ').trim()
  return paragraphs(
    `${skillPreamble(SKILL, skill, bundled)} to answer: ${asked}`,
    journeyRules(skill, stage, journeysFolder),
  )
}

/** The rules of a journey run (also sent after the person answers Claude's question). */
export function journeyRules(skill: string, stage: string, journeysFolder: string): string {
  return paragraphs(
    sentences(
      'Those are the words of the person asking: a request, not the journey\'s question.',
      'Give the journey its own natural question, the one a developer would ask that this journey answers (one line),',
      'and a short title.',
    ),
    sentences(
      `Write exactly one journey with the skill's journey.py, always with \`--dir ${stage}\``,
      `(a staging folder: Code Notes moves the journey into ${journeysFolder}/ once \`check\` passes, so it never shows`,
      'half-written).',
      oneCommandPerCall(skill),
    ),
    sentences(
      'If the request is too unclear to pick one flow, write nothing and reply with one short clarifying question',
      'instead; the person can answer it.',
    ),
    sentences(
      'If a journey of this repository already answers it, write nothing and end your reply with one line',
      `\`${ANSWERED_BY} <its file, relative to the repository>\` (e.g. \`${ANSWERED_BY} ${journeysFolder}/<slug>.json\`).`,
    ),
    'When done, reply with the storyline.',
  )
}

/** A stale step of the journey being refreshed: its number and title. */
export interface StaleStep { n: number; title: string }

/** What Claude is asked to do in a refresh: the stale steps, and how to update only those. */
export function refreshTask(slug: string, stale: StaleStep[]): string {
  const which = stale.map((s) => `${s.n} (“${s.title}”)`).join(', ')
  const one = stale.length === 1
  const staleNow = one ? `step ${which} no longer matches` : `steps ${which} no longer match`
  const those = one ? 'that step' : 'those steps'
  return sentences(
    `The journey "${slug}" is out of date: ${staleNow} the code.`,
    `Update only ${those}: \`check … fix\` what only moved;`,
    'where the code changed, re-read it,',
    '`restep` the facts that are no longer true, then the range; `rmstep` a step whose code is gone for good.',
    'Leave the other steps, the map and the journey\'s question and title as they are.',
  )
}

/** The refresh prompt: the skill, the task, the staging folder, the reply wanted. */
export function refreshPrompt(skill: string, stage: string, task: string, bundled: boolean): string {
  return paragraphs(
    `${skillPreamble(SKILL, skill, bundled)}.`,
    task,
    sentences(
      `The journey is in a staging folder: run journey.py always with \`--dir ${stage}\``,
      '(Code Notes puts it back in place once `check` passes).',
      oneCommandPerCall(skill),
      'Edit nothing else.',
    ),
    'When done, reply with one short line per step you changed.',
  )
}

/** The journey file Claude's reply names on its ANSWERED_BY line (relative to the repository), if it has one. */
export function answeredBy(reply: string): string | undefined {
  const line = reply.split('\n').map((l) => l.trim().replace(/^`|`$/g, '')).find((l) => l.startsWith(ANSWERED_BY))
  const file = line?.slice(ANSWERED_BY.length).trim().replace(/^\.\//, '')
  return file || undefined
}
