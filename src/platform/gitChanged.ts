// "What changed since commit X": the files of a repository changed since a commit (committed since, or edited and not
// committed), or why git can't say. No vscode: tests run it on a scratch repository (test/gitChanged.test.ts).

import { gitOut, QUICK_GIT } from './git'

/** A commit id as a file may name one (abbreviated or full): anything else is not passed to git. */
export const isCommitId = (s: string) => /^[0-9a-f]{4,40}$/i.test(s)

/** The files (relative to `repo`) changed since `commit`, or why git can't say. */
export async function changedFiles(repo: string, commit: string): Promise<{ files: Set<string> } | { why: string }> {
  if (!isCommitId(commit)) return { why: `"${commit}" is not a commit id` }
  const out = await gitOut(repo, ['diff', '--name-only', '--relative', commit, '--'], true, QUICK_GIT)
  if (out === undefined) return { why: `git could not compare with ${commit} (no git, or a commit this checkout doesn't have)` }
  return { files: new Set(out.split('\n').map((l) => l.trim()).filter(Boolean)) }
}
