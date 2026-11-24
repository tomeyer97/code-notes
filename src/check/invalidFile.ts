// A check file that can't be read: where it stops being JSON, opening it there (or at its first conflict marker), and
// a merge conflict's two sides kept (each question once, from the side with more graded answers).
import * as vscode from 'vscode'
import * as fs from 'fs'
import { jsonErrorAt } from './failures'
import type { CheckCore } from './state'
import type { Check, Question } from './types'

export class InvalidFile {
  constructor(private ports: Pick<CheckCore, 'state' | 'cli' | 'log' | 'refresh'>) {}

  /** Where an invalid check file stops being JSON (not a conflict: that has its own words). */
  parseError(): { line: number; col: number; text: string } | undefined {
    const st = this.ports.state.st, abs = this.ports.state.abs
    if (st?.state.phase !== 'invalid' || st.conflict || !abs) return undefined
    let text: string | undefined
    try {
      text = fs.readFileSync(abs, 'utf8')
      JSON.parse(text)
      return undefined
    } catch (e) {
      return jsonErrorAt(String((e as Error).message), text)
    }
  }

  /** The check file, at its first conflict marker when it has one (else where it stops being JSON). */
  async open(): Promise<void> {
    const abs = this.ports.state.abs
    if (!abs) return
    const pe = this.parseError()
    const line = Math.max(0, (this.ports.state.st?.conflict?.line ?? pe?.line ?? 1) - 1), col = Math.max(0, (pe?.col ?? 1) - 1)
    const at = new vscode.Selection(line, col, line, col)
    const ed = await vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: false, selection: at })
    ed.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter)
  }

  /** Keep both answers: each question once, from the side with more graded answers. */
  async keepBoth(): Promise<void> {
    const ports = this.ports, abs = ports.state.abs
    if (!abs) return
    const text = fs.readFileSync(abs, 'utf8')
    const c = ports.cli.conflictOf(text)
    if (!c?.merged) { await this.open(); return }
    const kept = keepFlags(c.merged, ports.cli.conflictSides(text).map(parseCheck))
    // Not relocated (save() would): the merged questions keep the lines their sides gave them.
    ports.cli.writeCheck(abs, ports.cli.stamp(c.merged, ports.cli.loadConfig(ports.state.repo!)))
    ports.state.say(`Both answers kept.${kept.length ? ` Question ${kept.join(', ')}: its concern stays flagged (one side flagged it).` : ''}`)
    ports.log.info(`merge conflict in ${ports.state.st?.file} resolved: both answers kept${kept.length ? `; flags kept on ${kept.join(', ')}` : ''}`)
    await ports.refresh()
  }
}

/** A side of a conflict as a check (undefined: it doesn't read). */
function parseCheck(text: string): Check | undefined {
  try { return JSON.parse(text) as Check } catch { return undefined }
}

/**
 * A concern flagged on either side of a conflict stays flagged in the merge (a flag is a request to a reviewer; a
 * dismissal can be redone). Returns the numbers of the questions whose flag was kept that way.
 */
function keepFlags(merged: Check, sides: (Check | undefined)[]): number[] {
  const flagged = new Map<string, NonNullable<Question['concern']>>()
  for (const side of sides) {
    for (const q of side?.questions ?? []) if (q.concern?.flagged) flagged.set(q.id, q.concern)
  }
  const kept: number[] = []
  merged.questions.forEach((q, i) => {
    const f = flagged.get(q.id)
    if (!f || q.concern?.flagged) return
    q.concern = f
    kept.push(i + 1)
  })
  return kept
}
