// A branch's check, not committed yet, moved out of the working tree while another branch is checked out, and put
// back once it is checked out again. It waits in the CLI's cache folder (Cli CACHE: git-ignored).
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { gitOut } from '../platform/git'
import { RESTORED_OPEN_MS } from './constants'
import type { CheckController } from './controller'
import { fireAndForget } from '../platform/run'

export class Parking {
  /** Branches whose check was moved out only because another branch was checked out: put back quietly. */
  private quiet = new Set<string>()

  constructor(private ctl: CheckController) {}

  /** Another branch is checked out: the check `before` had, not committed yet, waits in the cache (put back quietly). */
  async left(before: string): Promise<void> {
    if (await this.park(before)) this.quiet.add(before)
  }

  /** Moves the questions written for `branch` out of a working tree that has another branch now. */
  async park(branch: string): Promise<boolean> {
    const ctl = this.ctl, repo = ctl.repo!
    const rel = ctl.cli.fileFor(branch)
    const src = path.join(repo, rel)
    if (!fs.existsSync(src)) return false
    try {
      fs.mkdirSync(path.join(repo, ctl.cli.CACHE), { recursive: true })
      const ignore = path.join(repo, path.dirname(ctl.cli.CACHE), '.gitignore')
      if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n')
      // Tracked on this branch (it has a check of that name): leave it, it is not ours to move.
      const tracked = !!(await gitOut(repo, ['ls-files', '--', rel]))
      if (tracked) return false
      fs.renameSync(src, path.join(repo, ctl.cli.cachedFor(branch)))
      ctl.log.info(`questions for ${branch} kept in ${ctl.cli.CACHE} until it is checked out`)
      return true
    } catch (e) {
      ctl.log.error(`couldn't keep the questions for ${branch}: ${e}`)
      return false
    }
  }

  /** Back on a branch whose questions were parked: they go in place, and question 1 opens. */
  async restore(): Promise<boolean> {
    const ctl = this.ctl, repo = ctl.repo!, st = ctl.st!
    const cached = path.join(repo, ctl.cli.cachedFor(st.branch))
    if (!fs.existsSync(cached)) return false
    try {
      fs.mkdirSync(path.dirname(path.join(repo, st.file)), { recursive: true })
      fs.renameSync(cached, path.join(repo, st.file))
    } catch (e) {
      ctl.log.error(`couldn't put back the questions for ${st.branch}: ${e}`)
      return false
    }
    // Moved out only because another branch was checked out: back where it was, nothing said.
    if (this.quiet.delete(st.branch)) return true
    fireAndForget(vscode.window.showInformationMessage(`Your questions for ${st.branch} are here.`), 'park: window.showInformationMessage')
    setTimeout(() => fireAndForget(ctl.openNext(), 'park: ctl.openNext'), RESTORED_OPEN_MS)
    return true
  }
}
