// What git says about each workspace folder's checkout: its branch (followed as .git/HEAD changes), and the commit and
// branch a note's anchor is stamped with. git itself runs in git.ts.

import * as vscode from 'vscode'
import { gitOut, QUICK_GIT } from './git'
import { fireAndForget } from './run'

/** git's output in this folder's checkout (git.ts runs it: never takes the index lock); undefined off disk or on failure. */
export function gitIn(folder: vscode.WorkspaceFolder | undefined, args: string[]): Promise<string | undefined> {
  if (!folder || folder.uri.scheme !== 'file') return Promise.resolve(undefined)
  return gitOut(folder.uri.fsPath, args, false, QUICK_GIT)
}

/** What otherBranch reads of a note: its folder, and the branch its anchor was stamped with. */
interface OnBranch { folder: { uri: { toString(): string } }; data: { anchor: { branch?: string } } }

/** The checked-out branch per workspace folder, followed as `.git/HEAD` changes. */
export class Checkouts implements vscode.Disposable {
  private readonly branches = new Map<string, string | undefined>()
  private readonly changed = new vscode.EventEmitter<vscode.WorkspaceFolder>()
  /** `.git/HEAD` changed (a checkout; with a detached HEAD, a commit too) and the branch was read again. */
  readonly onDidChangeBranch = this.changed.event
  private readonly subs: vscode.Disposable[] = [this.changed]

  /** Reads each folder's branch now, and again whenever its `.git/HEAD` changes. */
  async watch(folders: readonly vscode.WorkspaceFolder[]): Promise<void> {
    for (const f of folders) {
      await this.refresh(f)
      const head = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(f, '.git/HEAD'))
      const onHead = () => fireAndForget(this.refresh(f).then(() => this.changed.fire(f)), 'checkout: read the branch')
      head.onDidChange(onHead)
      head.onDidCreate(onHead)
      this.subs.push(head)
    }
  }

  async refresh(folder: vscode.WorkspaceFolder): Promise<void> {
    this.branches.set(folder.uri.toString(), await gitIn(folder, ['rev-parse', '--abbrev-ref', 'HEAD']))
  }

  /** The note was written on another branch than the one checked out now. */
  otherBranch(n: OnBranch): string | undefined {
    const now = this.branches.get(n.folder.uri.toString())
    return n.data.anchor.branch && now && now !== n.data.anchor.branch ? n.data.anchor.branch : undefined
  }

  dispose(): void { for (const s of this.subs) s.dispose() }
}

/** The workspace's checkouts (one per extension host). */
export const checkouts = new Checkouts()

/** The note was written on another branch than the one checked out now. */
export const otherBranch = (n: OnBranch) => checkouts.otherBranch(n)

/** The commit and branch checked out now (no branch when detached), for a new anchor. */
export async function commitInfo(folder: vscode.WorkspaceFolder): Promise<{ commit?: string; branch?: string }> {
  const [commit, branch] = await Promise.all([
    gitIn(folder, ['rev-parse', '--short', 'HEAD']),
    gitIn(folder, ['rev-parse', '--abbrev-ref', 'HEAD']),
  ])
  return { ...(commit ? { commit } : {}), ...(branch && branch !== 'HEAD' ? { branch } : {}) }
}
