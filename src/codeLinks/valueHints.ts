import * as vscode from 'vscode'
import { fileLines } from '../platform/documents'
import { findLine } from '../core/anchors/lineFollow'
import { capValue } from '../journeys/textFormat'
import { TrackedLine, TrackedLines } from '../platform/followEdits'
import { stepFileUri } from '../journeys/codeGroup'
import type { ValueHint } from '../core/format/journeyModel'
import { baseName } from '../core/paths'
import { fireAndForget } from '../platform/run'

// Value hints: while a step is open, a faint line right above the code where a value is declared or used
// says what it holds in the example run: `objs = [Secret run-…, Pod run-…]`. Like a debugger's inline values, but
// written by the journey's author (not captured). One row each (a CodeLens is the only text an extension can put
// above a line, and it is a single row): the value, then a few words on what it is. Nothing is highlighted.

/** A hint shown: its file and 0-based line, its row's text (`title`) and its line's text (to find it again after an edit). */
interface ShownHint extends TrackedLine { title: string }

export class ValueHints implements vscode.Disposable {
  private key = ''
  /** The hints shown; they follow edits to their files. */
  private readonly hints = new TrackedLines<ShownHint>(() => this.changed.fire())
  private readonly changed = new vscode.EventEmitter<void>()
  private readonly subs: vscode.Disposable[]
  private seq = 0

  /** `back`: where the code link's way back is shown; no hint shares its row. */
  constructor(private log: vscode.LogOutputChannel, private back: () => { uri: string; line: number } | undefined, backChanged: vscode.Event<void>) {
    const provider = { onDidChangeCodeLenses: this.changed.event, provideCodeLenses: (doc: vscode.TextDocument) => this.lenses(doc) }
    this.subs = [
      this.changed,
      backChanged(() => this.changed.fire()),
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, provider),
      this.hints,
    ]
  }

  /** The rows above `doc`'s lines: each hint in it, except on the way back's row. */
  private lenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const u = doc.uri.toString()
    const b = this.back()
    const onBackRow = (h: ShownHint) => !!b && b.uri === u && b.line === h.line
    return this.hints.items
      .filter((h) => h.uri === u && h.line < doc.lineCount && !onBackRow(h))
      .map((h) => new vscode.CodeLens(new vscode.Range(h.line, 0, h.line, 0), { title: h.title, command: '' }))
  }

  /** For tests: "file name:line: text". */
  get state(): string[] { return this.hints.items.map((h) => `${baseName(h.uri)}:${h.line}: ${h.title}`).sort() }

  /** The step shown: its values appear above their lines. The same step again changes nothing. */
  present(key: string, folder: vscode.Uri, values: ValueHint[], renames: Map<string, string>): void {
    const k = `${key}|${JSON.stringify(values)}`
    if (k === this.key) return
    this.key = k
    fireAndForget(this.place(++this.seq, folder, values, renames), 'valueHints: place')
  }

  /** Finds each value's line and shows the hints, unless a newer step was presented meanwhile (`mine`). */
  private async place(mine: number, folder: vscode.Uri, values: ValueHint[], renames: Map<string, string>): Promise<void> {
    const uris = values.map((v) => stepFileUri(folder, renames, v.file))
    // Read at once, without opening documents (each open is a round trip to the window).
    const files = await Promise.all(uris.map((u) => fileLines(u)))
    const shown: ShownHint[] = []
    for (const [k, v] of values.entries()) {
      const lines = files[k]
      if (!lines) continue
      const line = v.text.trim() ? findLine(lines, v.line - 1, v.text) : Math.min(v.line, lines.length) - 1
      if (line < 0) {
        this.log.info(`value hint ${v.name}: the line at ${v.file}:${v.line} changed; not shown`)
        continue
      }
      // The value cut to about 40 characters, so the note after it stays on screen.
      const title = `${v.name} = ${capValue(v.value)}${v.note ? `  ·  ${v.note}` : ''}`
      shown.push({ uri: uris[k].toString(), line, title, text: v.text })
    }
    if (mine !== this.seq) return
    this.hints.set(shown)
    this.changed.fire()
  }

  clear(): void {
    if (!this.key && !this.hints.items.length) return
    this.seq++
    this.key = ''
    this.hints.set([])
    this.changed.fire()
  }

  dispose(): void { for (const s of this.subs) s.dispose() }
}
