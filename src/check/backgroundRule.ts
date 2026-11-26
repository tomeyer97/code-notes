// Whether a push writes questions in the background, and the commits it already did it for. No vscode at run time
// (background.ts watches the pushes): unit-tested (test/checkBackground.test.ts).
import * as fs from 'fs'
import * as path from 'path'
import { BG_COMMITS_KEPT } from './constants'
import type { CheckCore } from './state'
import type { Writer } from './writer'
import { DIR } from '../../cli/understanding/constants'
import { gitRaw } from '../platform/git'
import { STATE, type StateStore } from '../platform/state'

/**
 * The repository uses the check: its settings (understanding/config.json) are there, or a check file is committed at
 * one of `refs`. Questions are written in the background only then.
 */
export async function usesCheck(repo: string, refs: string[]): Promise<boolean> {
  if (fs.existsSync(path.join(repo, DIR, 'config.json'))) return true
  for (const ref of refs) {
    const out = await gitRaw(repo, ['ls-tree', '--name-only', ref, '--', `${DIR}/`])
    if (out?.split('\n').some((f) => f.endsWith('.json'))) return true
  }
  return false
}

/** The commits whose background questions were written (the last BG_COMMITS_KEPT), in the workspace's memory. */
export class BackgroundRuns {
  constructor(private stored: Pick<StateStore, 'get' | 'set'>) {}
  has(commit: string): boolean { return this.stored.get(STATE.checkBackgroundHeads).includes(commit) }
  async add(commit: string): Promise<void> {
    const done = this.stored.get(STATE.checkBackgroundHeads)
    await this.stored.set(STATE.checkBackgroundHeads, [...done.slice(-BG_COMMITS_KEPT), commit])
  }
}

/** What the rule reads: the state after a refresh, the setting, whether the repository uses the check, the writer. */
export interface PushedPorts extends Pick<CheckCore, 'state' | 'refresh'> {
  stored: Pick<StateStore, 'get' | 'set'>
  /** codeNotes.understanding.background. */
  enabled(): boolean
  /** The repository uses the check: understanding/config.json, or a check file committed at one of `refs`. */
  usesCheck(refs: string[]): Promise<boolean>
  writer: Pick<Writer, 'writing' | 'write'>
}

export class BackgroundWrites {
  private readonly runs: BackgroundRuns
  constructor(private ports: PushedPorts) {
    this.runs = new BackgroundRuns(ports.stored)
  }

  /**
   * `branch` was just pushed at `commit`: its questions are written when it has a change, no check, is not a default
   * branch, and the repository uses the check (a paid run nobody asked for otherwise). Once per commit. True: started.
   */
  async pushed(branch: string, commit: string | undefined): Promise<boolean> {
    const ports = this.ports
    if (!ports.enabled() || ports.writer.writing || !commit) return false
    if (this.runs.has(commit)) return false
    await ports.refresh()
    const st = ports.state.st
    if (!st || st.branch !== branch || st.state.phase !== 'none') return false
    // A default branch (the CLI's isDefaultBranch: origin's HEAD, else main or master; or the branch compared with).
    if (st.onBase) return false
    if (!(await ports.usesCheck(['HEAD', ...(st.baseRef ? [st.baseRef] : [])]))) return false
    await this.runs.add(commit)
    await ports.writer.write(false, { background: true })
    return true
  }
}
