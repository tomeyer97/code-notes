// The extension's vscode://<publisher>.code-notes/<route> links, each route its own handler: /link lights lines of a
// file (a terminal's or an agent's answer), /explain is an old script's request (requests.ts).
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { claudeLinks } from './ports'
import { log } from '../platform/host'
import { fireAndForget } from '../platform/run'
import { linkTarget } from '../core/linkUri'
import { explainLink } from './requests'

/** /link?file=…&start=…&end=…: the lines lit (a workspace-relative file in the first folder). */
async function onLink(uri: vscode.Uri): Promise<void> {
  const t = linkTarget(uri.query)
  if (!t) { log().warn(`link: no file or start: ${uri.toString(true)}`); return }
  const folder = vscode.workspace.workspaceFolders?.[0]
  const file = path.isAbsolute(t.file) || !folder ? vscode.Uri.file(t.file) : vscode.Uri.joinPath(folder.uri, t.file)
  await claudeLinks().light(file, t.start - 1, t.end - 1)
}

/** A path with its links resolved (as it is when it can't be). */
const realPath = (p: string) => fs.promises.realpath(p).catch(() => p)

/** The open folder that is repository `repo` (by real path), if any. */
async function folderOf(repo: string): Promise<vscode.WorkspaceFolder | undefined> {
  const want = await realPath(repo)
  for (const f of vscode.workspace.workspaceFolders ?? []) if ((await realPath(f.uri.fsPath)) === want) return f
  return undefined
}

/** /explain?action=…&q=…[&repo=<path>]: another repository's request is left to the window that has it open. */
async function onExplain(uri: vscode.Uri): Promise<void> {
  const repo = new URLSearchParams(uri.query).get('repo')
  if (repo && !(await folderOf(repo))) {
    log().info(`explain: a link for ${repo}, not open in this window: left to that window`)
    return
  }
  await explainLink(uri.query)
}

const ROUTES: Record<string, (uri: vscode.Uri) => Promise<void>> = { '/link': onLink, '/explain': onExplain }

/** The links' handler: each to its route (a trailing slash is the same route). */
export function registerUriRoutes(): vscode.Disposable {
  return vscode.window.registerUriHandler({
    handleUri: (uri) => {
      const route = ROUTES[uri.path.replace(/\/+$/, '')]
      if (!route) { log().warn(`unknown link: ${uri.toString(true)}`); return }
      fireAndForget(route(uri), 'explain link')
    },
  })
}
