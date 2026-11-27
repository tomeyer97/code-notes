// A run of Claude shown in a progress notification: its clock and phase ("1:05 · reading the code"), and Cancel. One
// helper for every writer (the check's questions; journeys can use it too).
import * as vscode from 'vscode'
import type { AgentRun } from './agent/agent'
import type { AskResult } from './agent/claude'
import { runProgress, type ClaudeRun } from '../core/agentRun'

/** The notification's clock ticks once a second. */
export const RUN_TICK_MS = 1000

/**
 * `start` run in a notification titled `title`, for `run` (its clock and phase): `start` gets `tick`, to call when the
 * phase changes; `onTick` follows each tick (a view's clock). Cancel stops the run; its result once it ends.
 */
export async function withRunProgress(
  run: ClaudeRun, title: string, start: (tick: () => void) => AgentRun, onTick?: () => void,
): Promise<AskResult> {
  const where = { location: vscode.ProgressLocation.Notification, title, cancellable: true }
  return await vscode.window.withProgress(where, async (progress, token) => {
    const tick = () => {
      progress.report({ message: runProgress(run) })
      onTick?.()
    }
    const agent = start(tick)
    token.onCancellationRequested(() => agent.cancel())
    tick()
    const timer = setInterval(tick, RUN_TICK_MS)
    try {
      return await agent.done
    } finally {
      clearInterval(timer)
    }
  })
}
