// A branch's check, not committed yet, moved out of the working tree while another branch is checked out, and put
// back once it is checked out again. It waits in the CLI's cache folder (CACHE: git-ignored).
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { gitOut } from '../platform/git'
import type { CheckCore } from './state'
import { fireAndForget } from '../platform/run'

/** What parking needs: the state, the CLI's file names, the log, and question 1 opened once a check is back. */
export interface ParkingPorts extends Pick<CheckCore, 'state' | 'cli' | 'log'> {
  /** The first question not done yet opened, after the refresh that put the check back has drawn. */
  openNextAfterRefresh(): void
}

const isThere = (p: string): Promise<boolean> => fs.promises.access(p).then(() => true, () => false)

export class Parking {
  /** Branches whose check was moved out only because another branch was checked out: put back quietly. */
  private quiet = new Set<string>()

  constructor(private ports: ParkingPorts) {}

  /** Another branch is checked out: the check `before` had, not committed yet, waits in the cache (put back quietly). */
  async left(before: string): Promise<void> {
    if (await this.park(before)) this.quiet.add(before)
  }

  /** Moves the questions written for `branch` out of a working tree that has another branch now. */
  async park(branch: string): Promise<boolean> {
    const { state, cli, log } = this.ports, repo = state.repo!
    const rel = cli.fileFor(branch)
    const src = path.join(repo, rel)
    if (!(await isThere(src))) return false
    try {
      await this.ensureCache(repo)
      // Tracked on this branch (it has a check of that name): leave it, it is not ours to move.
      if (await gitOut(repo, ['ls-files', '--', rel])) return false
      await fs.promises.rename(src, path.join(repo, cli.cachedFor(branch)))
      log.info(`questions for ${branch} kept in ${cli.CACHE} until it is checked out`)
      return true
    } catch (e) {
      log.error(`couldn't keep the questions for ${branch}: ${e}`)
      return false
    }
  }

  /** The cache folder, and a .gitignore of `*` in its parent (the CLI's own folder: nothing in it is committed). */
  private async ensureCache(repo: string): Promise<void> {
    const cache = this.ports.cli.CACHE
    await fs.promises.mkdir(path.join(repo, cache), { recursive: true })
    const ignore = path.join(repo, path.dirname(cache), '.gitignore')
    if (!(await isThere(ignore))) await fs.promises.writeFile(ignore, '*\n')
  }

  /** Back on a branch whose questions were parked: they go in place, and question 1 opens. */
  async restore(): Promise<boolean> {
    const { state, cli, log } = this.ports, repo = state.repo!, st = state.st!
    const cached = path.join(repo, cli.cachedFor(st.branch))
    if (!(await isThere(cached))) return false
    try {
      await fs.promises.mkdir(path.dirname(path.join(repo, st.file)), { recursive: true })
      await fs.promises.rename(cached, path.join(repo, st.file))
    } catch (e) {
      log.error(`couldn't put back the questions for ${st.branch}: ${e}`)
      return false
    }
    // Moved out only because another branch was checked out: back where it was, nothing said.
    if (this.quiet.delete(st.branch)) return true
    const said = vscode.window.showInformationMessage(`Your questions for ${st.branch} are here.`)
    fireAndForget(said, 'park: window.showInformationMessage')
    // Opened by the controller once the refresh that put it back has drawn (no timer of its own).
    this.ports.openNextAfterRefresh()
    return true
  }
}
