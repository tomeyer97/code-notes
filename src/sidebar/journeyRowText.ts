// What a journey's row in the views says, from its state worked out once (JourneyRowState): the description, the
// tooltip, the screen reader's label and the menus' context. No vscode API (unit-tested in test/journeyRowText.test.ts).

import type { ListRow } from '../core/list/journeyList'
import { plural } from '../core/text'
import { ClaudeRun, runProgress } from '../core/agentRun'
import { clock } from '../core/format/podcast/model'
import type { PodcastStatus } from '../tour/api'

/** The groups under which a journey's row lists its step questions: Continue, All and its areas, and a row of no group
 *  (the Code Notes view's). A journey is listed once there (a walked one only in Continue); "In this file" repeats it. */
export const nestsQuestions = (group: string | undefined) => !group || group === 'all' || group === 'continue' || group.startsWith('area:')

/** What a journey's row says, worked out once: its description, tooltip, screen-reader label, icon and menus are all
 *  made from it. */
export interface JourneyRowState {
  /** Being walked now; where it is, or where it was left past step 1 (0: neither: opening one is not reading it). */
  active: boolean
  left: number
  steps: number
  /** Unread replies to its step questions (a reply shows on the folded row, like an unread note). */
  newReplies: number
  pod?: PodcastStatus
  refreshing: boolean
  stale: boolean
  unreadable: boolean
  isNew: boolean
  /** Its row in the list model the Journeys view drew: "3 of 7 steps here" (none before a drawing). */
  row?: ListRow
}

const replies = (n: number) => plural(n, 'reply', 'replies')
const unreadReplies = (n: number) => plural(n, 'unread reply', 'unread replies')

/**
 * Muted and short: where it was left (step 3/14; while walking the icon says so and the card and status bar have the
 * position), else how long it is (10 steps); its podcast's length; Refreshing… or ⚠ Stale; new replies; unreadable;
 * new. No age (the tooltip says when it was written), no question count (the questions are the rows below). In this
 * file (`here`): how much of it is here ("3 of 7 steps here"), unless it is being walked or was left.
 */
export function journeyDescription(s: JourneyRowState, group: string | undefined): string | undefined {
  const { row } = s
  const pod = podcastText(s.pod)
  if (group === 'here' && row && !(row.walking || row.resume > 1)) {
    return [row.hereText, pod, row.stale ? '⚠ Stale' : ''].filter(Boolean).join(' · ')
  }
  // Listened to: no step (the player has where it is).
  const where = s.pod?.session ? '' : s.left ? `step ${s.left}/${s.steps}` : plural(s.steps, 'step')
  return [
    where,
    pod,
    s.refreshing ? 'Refreshing…' : s.stale ? '⚠ Stale' : '',
    s.newReplies ? replies(s.newReplies) : '',
    s.unreadable ? '⚠ unreadable' : '',
    s.isNew ? 'new' : '',
  ].filter(Boolean).join(' · ') || undefined
}

/** The question, the summary, who wrote it, which steps are stale, unread replies ("new" is only a new journey: an
 *  unread answer is said in full here), and a podcast that can't be played and why (the row offers no ▶ then). */
export function journeyTooltip(s: JourneyRowState, j: { question: string; summary: string; provenance: string; staleLine: string }): string {
  const replyLine = s.newReplies ? `${unreadReplies(s.newReplies)} from Claude` : ''
  const podcastLine = s.pod?.state === 'broken' ? `Podcast unavailable: ${s.pod.text}` : ''
  return [j.question, j.summary, j.provenance, j.staleLine, replyLine, podcastLine].filter(Boolean).join('\n')
}

/** The row's quiet podcast mark: its length, always (listening or not: the player has the state and the time). */
const podcastText = (pod: PodcastStatus | undefined) => (pod?.state === 'ok' ? `♪ ${clock(pod.duration ?? 0)}` : '')

/** Whether the row offers ▶ Listen: a podcast that plays, unless it is playing (paused, ▶ goes on where it was). */
export function podcastContext(pod: PodcastStatus | undefined): string {
  if (!pod) return ''
  if (pod.state !== 'ok') return ';podcastBroken'
  return pod.playing ? ';podcastPlaying' : ';podcast'
}

/** What a screen reader says: the title, then where the walk is, the podcast, unread replies, new. */
export function journeyLabel(title: string, s: JourneyRowState): string {
  const where = s.active ? `walking, step ${s.left} of ${s.steps}` : s.left ? `left at step ${s.left} of ${s.steps}` : ''
  const listen = s.pod?.state === 'ok' ? `podcast ${clock(s.pod.duration ?? 0)}` : ''
  return [title, where, listen, s.newReplies ? unreadReplies(s.newReplies) : '', s.isNew ? 'new' : ''].filter(Boolean).join(', ')
}

/** A journey Claude is writing now, as its row says it: "Writing: <question>", then "1:20 · reading store.ts". */
export function writingRowText(job: { question: string; model: string } & ClaudeRun, now: number): { label: string; description: string; tooltip: string; a11y: string } {
  const q = job.question.replace(/\s+/g, ' ').trim()
  return {
    label: `Writing: ${q}`,
    description: runProgress(job, now),
    tooltip: `${q}\nClaude (${job.model}) is writing a journey for this question.`,
    a11y: `Writing a journey: ${q}, ${runProgress(job, now)}`,
  }
}
