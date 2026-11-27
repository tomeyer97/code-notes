// A throwaway git repository for a test: one identity (in the environment and the repository's config, so no global
// git config is read for it), files written and committed in one call.
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'

/** The author and committer of every test commit. */
export const TEST_IDENTITY = { name: 'A', email: 'a@example.com' }

export interface GitRepo {
  dir: string
  /** The environment the repository's git commands run with (the identity set). */
  env: NodeJS.ProcessEnv
  /** Runs git in the repository; its output, trimmed. */
  git(...args: string[]): string
  /** Writes files (path relative to the repository → text), creating folders. */
  write(files: Record<string, string>): void
  /** Writes files, then commits everything with `message`. */
  commit(message: string, files?: Record<string, string>): void
}

/** A new repository on `branch` (default main) with one commit of `files` (default `a.js`). */
export function gitRepo(o: { prefix?: string; branch?: string; files?: Record<string, string> } = {}): GitRepo {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), o.prefix ?? 'git-repo-'))
  const { name, email } = TEST_IDENTITY
  const env = { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email }
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, env, encoding: 'utf8' }).trim()
  const write = (files: Record<string, string>) => {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
      fs.writeFileSync(path.join(dir, rel), text)
    }
  }
  const commit = (message: string, files: Record<string, string> = {}) => {
    write(files)
    git('add', '-A')
    git('commit', '-qm', message)
  }
  git('init', '-q', '-b', o.branch ?? 'main')
  git('config', 'user.name', name)
  git('config', 'user.email', email)
  commit('one', o.files ?? { 'a.js': 'export const a = 1\n' })
  return { dir, env, git, write, commit }
}
