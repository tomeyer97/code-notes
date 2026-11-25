import * as vscode from 'vscode'
import { fileLines } from '../platform/documents'
import { capValue } from '../journeys/textFormat'
import { TrackedLine, TrackedLines } from '../platform/followEdits'
import { stepFileUri } from '../journeys/codeGroup'
import type { ValueHint } from '../core/format/journeyModel'
import { baseName } from '../core/paths'
import { fireAndForget } from '../platform/run'
import { Latest, Run } from './latest'
import { lineChanged, locateStepLine, sameValues } from './lines'

// Value hints: while a step is open, a faint line right above the code where a value is declared or used
// says what it holds in the example run: `objs = [Secret run-…, Pod run-…]`. Like a debugger's inline values, but
// written by the journey's author (not captured). One row each (a CodeLens is the only text an extension can put
// above a line, and it is a single row): the value, then a few words on what it is. Nothing is highlighted.

/** A hint shown: its file and 0-based line, its row's text (`title`) and its line's text (to find it again after an edit). */
interface ShownHint extends TrackedLine { title: string }

export class ValueHints implements vscode.Disposable {
  /** The step shown and its values (the same again changes nothing). */
  private step: { key: string; values: ValueHint[] } | undefined
  /** The hints shown; they follow edits to their files. */
  private readonly hints = new TrackedLines<ShownHint>(() => this.changed.fire())
  private readonly changed = new vscode.EventEmitter<void>()
  /** The hints changed (the one lens provider asks again: lenses.ts). */
  readonly onDidChange = this.changed.event
  private readonly subs: vscode.Disposable[]
  private readonly latest = new Latest()

  constructor(private log: vscode.LogOutputChannel) {
    this.subs = [this.changed, this.hints]
  }

  /** The rows above `doc`'s lines: each hint in it (lenses.ts leaves out the one on a code link's Back row). */
  lenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const u = doc.uri.toString()
    return this.hints.items
      .filter((h) => h.uri === u && h.line < doc.lineCount)
      .map((h) => new vscode.CodeLens(new vscode.Range(h.line, 0, h.line, 0), { title: h.title, command: '' }))
  }

  /** For tests: "file name:line: text". */
  get state(): string[] { return this.hints.items.map((h) => `${baseName(h.uri)}:${h.line}: ${h.title}`).sort() }

  /** The step shown: its values appear above their lines. The same step again changes nothing. */
  present(key: string, folder: vscode.Uri, values: ValueHint[], renames: Map<string, string>): void {
    if (this.step?.key === key && sameValues(this.step.values, values)) return
    this.step = { key, values }
    fireAndForget(this.place(this.latest.begin(), folder, values, renames), 'valueHints: place')
  }

  /** Finds each value's line and shows the hints, unless a newer step was presented meanwhile. */
  private async place(run: Run, folder: vscode.Uri, values: ValueHint[], renames: Map<string, string>): Promise<void> {
    const uris = values.map((v) => stepFileUri(folder, renames, v.file))
    // Read at once, without opening documents (each open is a round trip to the window).
    const files = await Promise.all(uris.map((u) => fileLines(u)))
    const shown: ShownHint[] = []
    for (const [k, v] of values.entries()) {
      const lines = files[k]
      if (!lines) continue
      const line = locateStepLine(lines, v)
      if (line < 0) {
        this.log.info(lineChanged(`value hint ${v.name}`, `the line at ${v.file}:${v.line}`, 'not shown'))
        continue
      }
      // The value cut to about 40 characters, so the note after it stays on screen.
      const title = `${v.name} = ${capValue(v.value)}${v.note ? `  ·  ${v.note}` : ''}`
      shown.push({ uri: uris[k].toString(), line, title, text: v.text })
    }
    if (!run.current) return
    this.hints.set(shown)
    this.changed.fire()
  }

  clear(): void {
    if (!this.step && !this.hints.items.length) return
    this.latest.cancel()
    this.step = undefined
    this.hints.set([])
    this.changed.fire()
  }

  dispose(): void { for (const s of this.subs) s.dispose() }
}
