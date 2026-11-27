// The journeys Claude is writing or refreshing now. They are runs in the agent runner's one list of runs in progress
// (platform/agent/runner.ts InProgress), with what a journey's row says: its question, its phase, its model. A
// journey being written is never listed half-made; it has one row while it is.
import { agentRunner, InProgressRun } from '../platform/agent/runner'
import type { ClaudeRun } from '../core/agentRun'
import { elapsed as clock } from '../core/clock'

/** A journey being written (`write`) or refreshed (`refresh`, `journey`: its key). */
export interface JourneyJob extends ClaudeRun {
  id: string
  kind: 'write' | 'refresh'
  question: string
  /** The model, as the UI names it. */
  model: string
  journey?: string
}

/** A run of the runner's list that is a journey job: the job rides along with it. */
export interface JourneyRun extends Omit<InProgressRun, 'cancel' | 'started'> { purpose: 'journey'; job: JourneyJob }

/** The run to list for `job`. */
export const journeyRun = (job: JourneyJob): JourneyRun =>
  ({ key: `journey:${job.id}`, purpose: 'journey', label: job.question, job })

const jobOf = (r: InProgressRun): JourneyJob | undefined => (r as Partial<JourneyRun>).job

/** The journey jobs running now. */
export function journeyJobs(): JourneyJob[] {
  return agentRunner().inProgress.list('journey').flatMap((r) => jobOf(r) ?? [])
}

/** Whether the journey `key` is being refreshed now. */
export const isRefreshing = (key: string) => journeyJobs().some((j) => j.kind === 'refresh' && j.journey === key)

/** The rows a list can show for the journeys being written. */
export function writingRows(): { id: string; label: string; question: string; phase: string; model: string }[] {
  return journeyJobs().map((w) => ({
    id: w.id,
    question: w.question,
    phase: w.phase,
    model: w.model,
    label: `Writing: ${w.question} · ${clock(Date.now() - w.started)}`,
  }))
}
