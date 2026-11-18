// What git says about each workspace folder's checkout: its branch (followed as it changes), and the commit and
// branch a note's anchor is stamped with.

import * as vscode from 'vscode'
import { gitOut } from './git'
import { Note } from './store'

/** Identity and branch reads are quick: a git that hangs longer than this is given up. */
const QUICK_GIT_TIMEOUT_MS = 3000

/** git's output in this folder's checkout (git.ts runs it: never takes the index lock); undefined off disk or on failure. */
export function git(folder: vscode.WorkspaceFolder | undefined, args: string[]): Promise<string | undefined> {
  if (!folder || folder.uri.scheme !== 'file') return Promise.resolve(undefined)
  return gitOut(folder.uri.fsPath, args, false, { timeoutMs: QUICK_GIT_TIMEOUT_MS })
}

/** The checked-out branch per workspace folder (updated when .git/HEAD changes). */
const branches = new Map<string, string | undefined>()

export async function refreshBranch(folder: vscode.WorkspaceFolder): Promise<void> {
  branches.set(folder.uri.toString(), await git(folder, ['rev-parse', '--abbrev-ref', 'HEAD']))
}

/** The note was written on another branch than the one checked out now. */
export function otherBranch(n: Note): string | undefined {
  const now = branches.get(n.folder.uri.toString())
  return n.data.anchor.branch && now && now !== n.data.anchor.branch ? n.data.anchor.branch : undefined
}

/** The commit and branch checked out now (no branch when detached), for a new anchor. */
export async function commitInfo(folder: vscode.WorkspaceFolder): Promise<{ commit?: string; branch?: string }> {
  const [commit, branch] = await Promise.all([
    git(folder, ['rev-parse', '--short', 'HEAD']),
    git(folder, ['rev-parse', '--abbrev-ref', 'HEAD']),
  ])
  return { ...(commit ? { commit } : {}), ...(branch && branch !== 'HEAD' ? { branch } : {}) }
}
