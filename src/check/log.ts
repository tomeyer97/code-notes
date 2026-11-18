// The check's lines in the extension's log: each starts "understanding check: " (one prefix, searchable in the log).
import type * as vscode from 'vscode'

export interface CheckLog {
  info(line: string): void
  error(line: string): void
  debug(line: string): void
}

/** ", $0.123": what a run of Claude cost, when it said (for a log line). */
export const costOf = (res: { costUsd?: number }): string => (res.costUsd ? `, $${res.costUsd.toFixed(3)}` : '')

/** `log` with the check's prefix on every line. */
export function checkLog(log: vscode.LogOutputChannel): CheckLog {
  const line = (s: string) => `understanding check: ${s}`
  return {
    info: (s) => log.info(line(s)),
    error: (s) => log.error(line(s)),
    debug: (s) => log.debug(line(s)),
  }
}
