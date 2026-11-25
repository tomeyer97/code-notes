// What every suite starts from, in one shape: the workspace, the extension's test API and the suite's wait. Built once
// the extension is active, so nothing in it is ever undefined.
import * as vscode from 'vscode'
import * as path from 'path'
import type { TestApi } from '../../../src/testApi'
import { Until, waiter } from './waits'

export interface SuiteContext {
  folder: vscode.WorkspaceFolder
  /** The workspace folder on disk. */
  ws: string
  /** <ws>/.code-notes */
  notesDir: string
  /** The extension's test API (src/testApi.ts: what `activate` returns). */
  api: TestApi
  /** The suite's wait: `waitMs` by default, `dump` printed on a timeout. */
  until: Until
}

/** The extension activated in the window's first folder, and the suite's wait. */
export async function createSuiteContext(
  activate: () => Promise<TestApi>,
  { waitMs, dump }: { waitMs?: number; dump?: (api: TestApi) => unknown } = {},
): Promise<SuiteContext> {
  const folder = vscode.workspace.workspaceFolders![0]
  const ws = folder.uri.fsPath
  const api = await activate()
  return { folder, ws, notesDir: path.join(ws, '.code-notes'), api, until: waiter({ ms: waitMs, dump: dump && (() => dump(api)) }) }
}
