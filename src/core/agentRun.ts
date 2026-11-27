// A run of Claude that writes something (the check's questions or tour; a journey): when it started, what it is doing
// now in plain words, and how the model is named. Pure, shared by every writer (unit-tested in test/agentRun.test.ts).
import { clock } from './writing'

/** A finished tool call as the agent reports it (platform/agent's ToolCall has this shape). */
export interface ToolUse { name: string; input?: Record<string, unknown> }

/** How the model is named (logs, the UI, the scripts' JOURNEY_MODEL / UNDERSTANDING_MODEL_LABEL) when none is set. */
export const DEFAULT_MODEL_NAME = 'Claude Code default'

/** The model's name as people read it: the one set, else Claude Code's own default. */
export const modelLabel = (m?: string): string => m || DEFAULT_MODEL_NAME

/** A timed run of Claude: since when, its phase (follows the tool calls), and a way to stop it once it started. */
export interface ClaudeRun {
  readonly started: number
  phase: string
  agent?: { cancel(): void; readonly pid?: number }
}

/** "1:05 · reading the code": a run's clock and phase, for a progress notification. */
export const runProgress = (r: ClaudeRun, now = Date.now()): string => `${clock(now - r.started)} · ${r.phase}`

/** How a writer reads its phase from Claude's tool calls. */
export interface PhaseTable {
  /** Tools that only read the code. */
  readTools: readonly string[]
  /** The phase a read-only tool call means after `prev`. */
  onRead(prev: string): string
  /** The phase a Bash command line means after `prev` (undefined: the phase goes on). */
  onCommand(command: string, prev: string): string | undefined
}

/** What Claude is doing, from its last finished tool call (none, or another tool: the phase goes on). */
export function phaseFromTool(tool: ToolUse | undefined, prev: string, table: PhaseTable): string {
  if (!tool) return prev
  if (table.readTools.includes(tool.name)) return table.onRead(prev)
  if (tool.name !== 'Bash') return prev
  return table.onCommand(String(tool.input?.command ?? ''), prev) ?? prev
}
