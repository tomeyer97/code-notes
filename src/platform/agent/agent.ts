// What an agent is to Code Notes: a program that answers a prompt in a folder, read-only unless told otherwise,
// streaming what it writes and does. Claude Code is the one there is (claude.ts); notes, journeys and the check run it
// through runner.ts. No vscode API here.
import type { AskResult, ToolCall } from './stream'

/** What an agent is asked to do. */
export interface AgentRunOptions {
  cwd: string
  prompt: string
  /** Continue this session (follow-ups on the same note keep their context). */
  resume?: string
  model?: string
  /** More tools to allow (e.g. "Skill", "Bash(/path/to/skill/scripts/*)") and directories the agent may read. */
  extraTools?: string[]
  addDirs?: string[]
  /** More environment for the agent (and the commands it runs), e.g. JOURNEY_MODEL for journey.py. */
  env?: Record<string, string>
  /** Called as text arrives (the whole text so far) and when a tool starts; `tool`: the last finished call. */
  onProgress?: (p: AgentProgress) => void
}

export interface AgentProgress {
  text: string
  activity?: string
  tool?: ToolCall
}

/** A run in progress: its result once it ends; cancel stops it. */
export interface AgentRun {
  readonly done: Promise<AskResult>
  readonly pid: number | undefined
  cancel(): void
}

export interface Agent {
  /** How the agent is named in messages ("Claude Code"). */
  readonly name: string
  /** Why the agent can't run with model `m` (undefined: it can). */
  modelProblem(m: string | undefined): string | undefined
  start(o: AgentRunOptions): AgentRun
}
