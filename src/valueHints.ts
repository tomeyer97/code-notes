import * as vscode from 'vscode'
import { fileLines } from './wfs'
import { LineEdit, findLine, followLine, shiftLine } from './beatLine'
import { capValue } from './journeys/textFormat'
import { EditFollower } from './followEdits'
import type { ValueHint } from './journeyModel'

// Value hints: while a step is open, a faint line right above the code where a value is declared or used
// says what it holds in the example run: `objs = [Secret run-…, Pod run-…]`. Like a debugger's inline values, but
// written by the journey's author (not captured). One row each (a CodeLens is the only text an extension can put
// above a line, and it is a single row): the value, then a few words on what it is. Nothing is highlighted.

export class ValueHints implements vscode.Disposable {
  private key = ''
  /** By file URI: 0-based line, the hint's text and its line's text (to find it again after an edit). */
  private at = new Map<string, { line: number; title: string; text: string }[]>()
  private readonly changed = new vscode.EventEmitter<void>()
  private readonly subs: vscode.Disposable[]
  private seq = 0

  /** `back`: where the code link's way back is shown; no hint shares its row. */
  constructor(private log: vscode.LogOutputChannel, private back: () => { uri: string; line: number } | undefined, backChanged: vscode.Event<void>) {
    this.subs = [this.changed, backChanged(() => this.changed.fire()), vscode.languages.registerCodeLensProvider({ scheme: 'file' }, {
      onDidChangeCodeLenses: this.changed.event,
      provideCodeLenses: (doc) => {
        const u = doc.uri.toString(), b = this.back()
        return (this.at.get(u) ?? []).filter((h) => h.line < doc.lineCount && !(b && b.uri === u && b.line === h.line))
          .map((h) => new vscode.CodeLens(new vscode.Range(h.line, 0, h.line, 0), { title: h.title, command: '' }))
      },
    }),
    // The hints follow edits to their file.
    new EditFollower((uri) => this.at.has(uri), (edits, uri) => this.shift(uri, edits), (doc, lines) => this.refind(doc, lines))]
  }

  private shift(uri: string, edits: LineEdit[]): void {
    for (const h of this.at.get(uri) ?? []) h.line = shiftLine(h.line, edits)
    this.changed.fire()
  }

  private refind(doc: vscode.TextDocument, lines: string[]): void {
    const u = doc.uri.toString(), hs = this.at.get(u)
    if (!hs) return
    const found = hs.map((h) => ({ ...h, line: followLine(lines, h.line, h.text, []) }))
    this.at.set(u, found.filter((h) => h.line >= 0))
    this.changed.fire()
  }

  /** For tests: "file name:line: text". */
  get state(): string[] { return [...this.at].flatMap(([u, hs]) => hs.map((h) => `${u.split('/').pop()}:${h.line}: ${h.title}`)).sort() }

  /** The step shown: its values appear above their lines. The same step again changes nothing. */
  present(key: string, folder: vscode.Uri, values: ValueHint[], renames: Map<string, string>): void {
    const k = `${key}|${JSON.stringify(values)}`
    if (k === this.key) return
    this.key = k
    const mine = ++this.seq
    void (async () => {
      const at = new Map<string, { line: number; title: string; text: string }[]>()
      // Read at once, without opening documents (each open is a round trip to the window).
      const files = await Promise.all(values.map((v) => fileLines(vscode.Uri.joinPath(folder, renames.get(v.file) ?? v.file))))
      for (const [k, v] of values.entries()) {
        const uri = vscode.Uri.joinPath(folder, renames.get(v.file) ?? v.file)
        const lines = files[k]
        if (!lines) continue
        const line = v.text.trim() ? findLine(lines, v.line, v.text) : Math.min(v.line, lines.length) - 1
        if (line < 0) { this.log.info(`value hint ${v.name}: the line at ${v.file}:${v.line} changed; not shown`); continue }
        const list = at.get(uri.toString()) ?? []
        // The value cut to about 40 characters, so the note after it stays on screen.
        list.push({ line, title: `${v.name} = ${capValue(v.value)}${v.note ? `  ·  ${v.note}` : ''}`, text: v.text })
        at.set(uri.toString(), list)
      }
      if (mine !== this.seq) return
      this.at = at
      this.changed.fire()
    })()
  }

  clear(): void { if (!this.key && !this.at.size) return; this.seq++; this.key = ''; this.at = new Map(); this.changed.fire() }

  dispose(): void { for (const s of this.subs) s.dispose() }
}
