// A check file that can't be read: where it stops being JSON, opening it there (or at its first conflict marker), and
// a merge conflict's two sides kept (each question once, from the side with more graded answers).
import * as vscode from 'vscode'
import * as fs from 'fs'
import { checkOfText, keepFlags, keptBothLine } from './checkText'
import { jsonErrorAt } from './failures'
import type { CheckCore } from './state'
import type { BranchStatus } from './types'

/** Where a file stops being JSON, in words. */
type ParseError = { line: number; col: number; text: string }

export class InvalidFile {
  /** The last parse error found, and the refresh's status it was found for (read once per refresh). */
  private found: { st: BranchStatus; error: ParseError | undefined } | undefined

  constructor(private ports: Pick<CheckCore, 'state' | 'cli' | 'log' | 'refresh'>) {}

  /**
   * Where an invalid check file stops being JSON (not a conflict: that has its own words). The file is read once per
   * refresh (each refresh's status is a new one), not on every drawing of the view.
   */
  parseError(): ParseError | undefined {
    const st = this.ports.state.st, abs = this.ports.state.abs
    if (st?.state.phase !== 'invalid' || st.conflict || !abs) return undefined
    if (this.found?.st !== st) this.found = { st, error: readError(abs) }
    return this.found.error
  }

  /** The check file, at its first conflict marker when it has one (else where it stops being JSON). */
  async open(): Promise<void> {
    const abs = this.ports.state.abs
    if (!abs) return
    const pe = this.parseError()
    const line = Math.max(0, (this.ports.state.st?.conflict?.line ?? pe?.line ?? 1) - 1)
    const col = Math.max(0, (pe?.col ?? 1) - 1)
    const at = new vscode.Selection(line, col, line, col)
    const ed = await vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: false, selection: at })
    ed.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter)
  }

  /** Keep both answers: each question once, from the side with more graded answers. */
  async keepBoth(): Promise<void> {
    const { state, cli, log } = this.ports, abs = state.abs
    if (!abs) return
    const text = await fs.promises.readFile(abs, 'utf8')
    const c = cli.conflictOf(text)
    if (!c?.merged) { await this.open(); return }
    const kept = keepFlags(c.merged, cli.conflictSides(text).map(checkOfText))
    // Not relocated (save() would): the merged questions keep the lines their sides gave them.
    cli.writeCheck(abs, cli.stamp(c.merged, cli.loadConfig(state.repo!)))
    state.say(keptBothLine(kept))
    const flags = kept.length ? `; flags kept on ${kept.join(', ')}` : ''
    log.info(`merge conflict in ${state.st?.file} resolved: both answers kept${flags}`)
    await this.ports.refresh()
  }
}

/** Where the check file at `abs` stops being JSON; undefined: it reads (or can't be read at all: no line to show). */
function readError(abs: string): ParseError | undefined {
  let text: string | undefined
  try {
    text = fs.readFileSync(abs, 'utf8')
    JSON.parse(text)
    return undefined
  } catch (e) {
    return jsonErrorAt(String((e as Error).message), text)
  }
}
