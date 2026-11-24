// Journey steps follow their code: edits in an editor, files changed, made or deleted on disk (a step follows its code
// into a file made just now, or goes stale), files renamed in the editor, another branch checked out. The steps are
// in memory only; the journey file is never written.

import * as vscode from 'vscode'
import { FileOnDisk, WorkspaceEvents } from '../platform/events'
import { relPath } from '../platform/documents'
import { exists } from '../platform/exists'
import { Debouncer } from '../platform/debounce'
import { fireAndForget } from '../platform/run'
import { Journeys } from './journeys'
import { fileOf, LoadedJourney } from './steps'

/** One pass after a burst of file events. */
const DISK_PASS_MS = 600
/** How long the paths of the steps' files are trusted (a step found in a renamed file by git alone says nothing). */
const STEP_PATHS_MS = 5000

export interface FollowJourneysPorts {
  /** Steps of these journeys followed their code into another file, or went stale, after a change on disk. */
  stepsFollowed(changed: LoadedJourney[]): Promise<void>
  /** The steps were found again after another branch was checked out. */
  relocated(): void
}

export function followJourneys(events: WorkspaceEvents, journeys: Journeys, ports: FollowJourneysPorts): vscode.Disposable {
  const follow = new JourneyFiles(events, journeys, ports)
  return vscode.Disposable.from(
    follow,
    events.onDidEditDocument((e) => { journeys.onEdit(e); journeys.onDocument(e.document) }),
    events.onDidChangeFileOnDisk((f) => follow.onDisk(f)),
    events.onDidRenameFiles((e) => fireAndForget(follow.renamed(e), 'journeys: follow renamed files')),
    events.onDidChangeBranch(() => fireAndForget(journeys.relocateOnDisk().then(ports.relocated), 'branch changed: find the steps again')),
    events.onDidChangeFolders(() => fireAndForget(journeys.load(), 'journeys: read again for the folders')),
  )
}

class JourneyFiles implements vscode.Disposable {
  /**
   * The paths of the files journey steps are in. Every file event of the workspace comes here (a build writes
   * thousands): worked out once per change of the journeys (or of where their steps are), not per event.
   */
  private stepPaths: { at: number; paths: Set<string> } | undefined
  /** Files with journey steps changed on disk since the last pass: their steps are found again. */
  private readonly changed = new Set<string>()
  private readonly pass = new Debouncer('journeys: files changed on disk')
  private readonly subs: vscode.Disposable[]

  constructor(private readonly events: WorkspaceEvents, private readonly journeys: Journeys, private readonly ports: FollowJourneysPorts) {
    const forget = () => { this.stepPaths = undefined }
    this.subs = [journeys.onDidChange(forget), journeys.onDidMoveSteps(forget)]
  }

  /** A journey step's code is in this file. */
  private stepIn(u: vscode.Uri): boolean {
    if (!this.stepPaths || Date.now() - this.stepPaths.at > STEP_PATHS_MS) {
      const paths = [...this.journeys.list.values()].flatMap((lj) => lj.j.steps.map((s) => vscode.Uri.joinPath(lj.folder.uri, fileOf(lj, s.n)).path))
      this.stepPaths = { at: Date.now(), paths: new Set(paths) }
    }
    return this.stepPaths.paths.has(u.path)
  }

  /** A file changed, made or deleted on disk: a pass soon, when journey steps are in it (or it is new). */
  onDisk(f: FileOnDisk): void {
    const steps = this.stepIn(f.uri)
    if (steps) this.changed.add(f.uri.path)
    if (!steps && f.kind !== 'created') return
    this.pass.later('disk', DISK_PASS_MS, () => this.diskPass())
  }

  /** Steps followed into moved files, then the steps in changed files found again. */
  private async diskPass(): Promise<void> {
    await this.followMovedFiles()
    const paths = new Set(this.changed)
    this.changed.clear()
    if (paths.size) await this.journeys.relocateOnDisk(paths)
  }

  /** Steps whose file was renamed or deleted on disk: follow the code into a file made just now, or go stale. */
  private async followMovedFiles(): Promise<void> {
    const changed: LoadedJourney[] = []
    for (const lj of this.journeys.list.values()) {
      let moved = false
      for (const s of lj.j.steps) {
        const f = fileOf(lj, s.n)
        if (await exists(vscode.Uri.joinPath(lj.folder.uri, f))) continue
        // Only the same code (fresh) follows into a new file: edited look-alikes don't.
        const into = await this.events.findMovedFile(
          (folder) => folder?.uri.toString() === lj.folder.uri.toString(),
          (lines) => this.journeys.findIn(lj, s.n, lines).state === 'fresh' || undefined,
        )
        if (into) await this.journeys.moveStep(lj, s.n, relPath(lj.folder, into.uri))
        if (fileOf(lj, s.n) === f && (await this.journeys.locate(lj, (k) => k === s.n))) moved = true
      }
      if (moved) changed.push(lj)
    }
    await this.ports.stepsFollowed(changed)
  }

  /** Files renamed in the editor: the steps in them follow, in memory. */
  async renamed(e: vscode.FileRenameEvent): Promise<void> {
    for (const { oldUri, newUri } of e.files) {
      for (const lj of this.journeys.list.values()) {
        for (const s of lj.j.steps) {
          const old = vscode.Uri.joinPath(lj.folder.uri, fileOf(lj, s.n)).path
          if (old !== oldUri.path && !old.startsWith(oldUri.path + '/')) continue
          await this.journeys.moveStep(lj, s.n, relPath(lj.folder, vscode.Uri.joinPath(newUri, old.slice(oldUri.path.length))))
        }
      }
    }
  }

  dispose(): void {
    this.pass.dispose()
    for (const s of this.subs) s.dispose()
  }
}
