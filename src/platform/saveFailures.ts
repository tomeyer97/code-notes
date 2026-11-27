import type * as vscode from 'vscode'
import { baseName } from '../core/paths'
import { fireAndForget, showError } from './run'

// Note files that could not be saved, said once each and together: the store reports each failure, this shows them.
// No vscode at run time (only its types): unit-tested.

/** A failure batch is shown this long after its first failure (a folder written by another user fails every save). */
const BATCH_MS = 500

/** The codes of a write refused for want of permission: Node's (a `file:` URI), VS Code's FileSystemError's (others). */
const NO_PERMISSION = new Set(['EACCES', 'EPERM', 'NoPermissions'])

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
  private denied = false
  private timer: ReturnType<typeof setTimeout> | undefined

  /** `folderName`: the notes folder's name, for the message. */
  constructor(private log: Pick<vscode.LogOutputChannel, 'error'>, private folderName: () => string) {}

  /** `e.code`: Node's or FileSystemError's (a permission error is said as such). */
  report(uri: vscode.Uri, e: Error & { code?: string }): void {
    this.log.error(`${uri.fsPath}: couldn't save: ${e.message}`)
    if (this.failed.has(uri.toString())) return
    this.failed.add(uri.toString())
    this.names.push(baseName(uri.path))
    this.why = e.message
    this.denied = NO_PERMISSION.has(e.code ?? '')
    this.timer ??= setTimeout(() => this.show(), BATCH_MS)
  }

  /** A save of `uri` worked: a later failure is said again. */
  saved(uri: vscode.Uri): void { this.failed.delete(uri.toString()) }

  private show(): void {
    const names = this.names.splice(0)
    this.timer = undefined
    const why = this.denied ? 'permission denied (written by another user?)' : this.why
    const folder = this.folderName()
    const text = names.length === 1 ? `couldn't save ${folder}/${names[0]}: ${why}` : `couldn't save ${names.length} notes in ${folder}/: ${why}`
    fireAndForget(showError(text), 'notes: save failure message')
  }
}
