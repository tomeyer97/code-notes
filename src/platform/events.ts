// The workspace's events, subscribed to once and fanned out as typed events: edits, saves, files changed, created,
// deleted or renamed, the editors, the settings, the folders, the branch checked out. Each feature subscribes to the
// ones it needs in its own code (notes/followEdits.ts, notes/moves.ts, journeys/follow.ts, tour/follow.ts, …): this
// knows no feature.

import * as vscode from 'vscode'
import { Checkouts } from './checkout'
import { linesOfUri } from './documents'

/** A file changed, made or deleted on disk (an agent, git, a build), not one of `ignore`'s. */
export interface FileOnDisk { uri: vscode.Uri; kind: 'changed' | 'created' | 'deleted' }

/** How long a file made just now is where code that disappeared elsewhere may have gone (git mv, mv, refactors). */
const RECENT_MS = 15_000

export class WorkspaceEvents implements vscode.Disposable {
  private readonly subs: vscode.Disposable[] = []
  private readonly emitters: vscode.EventEmitter<any>[] = []
  /** Files made just now, oldest first. */
  private readonly created: { uri: vscode.Uri; at: number }[] = []

  /** A document's text changed (not only its dirty state). */
  readonly onDidEditDocument: vscode.Event<vscode.TextDocumentChangeEvent>
  readonly onDidSaveDocument: vscode.Event<vscode.TextDocument>
  readonly onDidChangeFileOnDisk: vscode.Event<FileOnDisk>
  /** Files renamed in the editor (Explorer, a refactoring). */
  readonly onDidRenameFiles: vscode.Event<vscode.FileRenameEvent>
  readonly onDidChangeVisibleEditors: vscode.Event<readonly vscode.TextEditor[]>
  readonly onDidChangeActiveEditor: vscode.Event<vscode.TextEditor | undefined>
  readonly onDidChangeSelection: vscode.Event<vscode.TextEditorSelectionChangeEvent>
  readonly onDidOpenTabs: vscode.Event<readonly vscode.Tab[]>
  readonly onDidChangeSettings: vscode.Event<vscode.ConfigurationChangeEvent>
  readonly onDidChangeFolders: vscode.Event<vscode.WorkspaceFoldersChangeEvent>
  /** Another branch checked out in a folder (its `.git/HEAD` changed). */
  readonly onDidChangeBranch: vscode.Event<vscode.WorkspaceFolder>

  /** `ignore`: files whose changes on disk are nobody's business here (git's own, the extension's own). */
  constructor(private readonly checkouts: Checkouts, ignore: (u: vscode.Uri) => boolean) {
    const fan = <T>(source: vscode.Event<T>, keep: (e: T) => boolean = () => true): vscode.Event<T> => {
      const out = new vscode.EventEmitter<T>()
      this.emitters.push(out)
      this.subs.push(source((e) => { if (keep(e)) out.fire(e) }))
      return out.event
    }
    this.onDidEditDocument = fan(vscode.workspace.onDidChangeTextDocument, (e) => e.contentChanges.length > 0)
    this.onDidSaveDocument = fan(vscode.workspace.onDidSaveTextDocument)
    this.onDidRenameFiles = fan(vscode.workspace.onDidRenameFiles)
    this.onDidChangeVisibleEditors = fan(vscode.window.onDidChangeVisibleTextEditors)
    this.onDidChangeActiveEditor = fan(vscode.window.onDidChangeActiveTextEditor)
    this.onDidChangeSelection = fan(vscode.window.onDidChangeTextEditorSelection)
    this.onDidOpenTabs = this.mapEvent(vscode.window.tabGroups.onDidChangeTabs, (e) => (e.opened.length ? e.opened : undefined))
    this.onDidChangeSettings = fan(vscode.workspace.onDidChangeConfiguration)
    this.onDidChangeFolders = fan(vscode.workspace.onDidChangeWorkspaceFolders)
    this.onDidChangeBranch = fan(checkouts.onDidChangeBranch)
    const files = new vscode.EventEmitter<FileOnDisk>()
    this.emitters.push(files)
    this.onDidChangeFileOnDisk = files.event
    const watcher = vscode.workspace.createFileSystemWatcher('**/*')
    const onDisk = (kind: FileOnDisk['kind']) => (uri: vscode.Uri) => {
      if (ignore(uri)) return
      if (kind === 'created') this.created.push({ uri, at: Date.now() })
      files.fire({ uri, kind })
    }
    this.subs.push(watcher, watcher.onDidChange(onDisk('changed')), watcher.onDidCreate(onDisk('created')), watcher.onDidDelete(onDisk('deleted')))
  }

  /** `source`'s events as `map` turns them; undefined: none. */
  private mapEvent<T, U>(source: vscode.Event<T>, map: (e: T) => U | undefined): vscode.Event<U> {
    const out = new vscode.EventEmitter<U>()
    this.emitters.push(out)
    this.subs.push(source((e) => { const u = map(e); if (u !== undefined) out.fire(u) }))
    return out.event
  }

  /** Starts following the branch of these folders (checkout.ts). */
  watchBranches(folders: readonly vscode.WorkspaceFolder[]): Promise<void> { return this.checkouts.watch(folders) }

  /**
   * The first file made just now, in a workspace folder `inFolder` accepts, whose lines `matches` accepts: its uri and
   * what `matches` returned. Where code whose file disappeared went.
   */
  async findMovedFile<T>(
    inFolder: (f: vscode.WorkspaceFolder | undefined) => boolean,
    matches: (lines: string[]) => T | undefined,
  ): Promise<{ uri: vscode.Uri; found: T } | undefined> {
    const cutoff = Date.now() - RECENT_MS
    while (this.created.length && this.created[0].at < cutoff) this.created.shift()
    for (const c of this.created) {
      if (!inFolder(vscode.workspace.getWorkspaceFolder(c.uri))) continue
      const lines = await linesOfUri(c.uri)
      const found = lines && matches(lines)
      if (found) return { uri: c.uri, found }
    }
    return undefined
  }

  dispose(): void {
    for (const s of this.subs) s.dispose()
    for (const e of this.emitters) e.dispose()
  }
}
