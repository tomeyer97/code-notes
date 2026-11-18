import * as vscode from 'vscode'
import { fileName } from './jsonFolder'

// Note files that could not be saved, said once each and together: the store reports each failure, this shows them.

/** A failure batch is shown this long after its first failure (a folder written by another user fails every save). */
const BATCH_MS = 500

/**
 * Not writable (an agent running as root wrote it, a read-only mount): said once per file, never silently. Several
 * at once (a folder written by another user): one message, not a stack of toasts.
 */
export class SaveFailures {
  /** Files a save failed for (reported once until a save works again). */
  private readonly failed = new Set<string>()
  /** Failures not shown yet: one message for those of the next half second. */
  private names: string[] = []
  private why = ''
  private timer: ReturnType<typeof setTimeout> | undefined

  /** `folderName`: the notes folder's name, for the message. */
  constructor(private log: vscode.LogOutputChannel, private folderName: () => string) {}

  report(uri: vscode.Uri, e: Error): void {
    this.log.error(`${uri.fsPath}: couldn't save: ${e.message}`)
    if (this.failed.has(uri.toString())) return
    this.failed.add(uri.toString())
    this.names.push(fileName(uri))
    this.why = e.message
    this.timer ??= setTimeout(() => this.show(), BATCH_MS)
  }

  /** A save of `uri` worked: a later failure is said again. */
  saved(uri: vscode.Uri): void { this.failed.delete(uri.toString()) }

  private show(): void {
    const names = this.names.splice(0)
    this.timer = undefined
    const why = /EACCES|EPERM|permission/i.test(this.why) ? 'permission denied (written by another user?)' : this.why
    const folder = this.folderName()
    const text = names.length === 1 ? `Code Notes: couldn't save ${folder}/${names[0]}: ${why}`
      : `Code Notes: couldn't save ${names.length} notes in ${folder}/: ${why}`
    this.log.error(text.replace(/^Code Notes: /, '')) // every error shown is in the Output channel too
    vscode.window.showErrorMessage(text)
  }
}
