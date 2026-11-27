// What Commit & push would commit: made by push.ts, shown by the Check view (viewModel.ts), acted on by the controller.
// No vscode API here.

export interface CommitPlan {
  /** The check file and the setup files `init` wrote. */
  files: string[]
  /** Files a TODO from the check went to: committed only when ticked (`include`). */
  todos: string[]
  /** The TODO files ticked. */
  include: Set<string>
  /** Files an applied fix changed: committed unless unticked (`exclude`). */
  fixes?: string[]
  /** The fix files unticked. */
  exclude?: Set<string>
  /** The questions whose suggested fix those files hold. */
  applied?: string[]
  /** The check file's only change is its tour. */
  tourOnly?: boolean
  /** The repository's first check commit also adds the .gitattributes line that folds check files in diffs. */
  fold?: boolean
  /** How that is said (default: checkWords.ts COMMITS.fold). */
  foldText?: string
}
