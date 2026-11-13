import * as vscode from 'vscode'
import { capValue, findLine, followLine, shiftLine } from './beatLine'

// Value hints: while a step is open, a faint line right above the code where a value is declared or used
// says what it holds in the example run: `objs = [Secret run-…, Pod run-…]`. Like a debugger's inline values, but
// written by the journey's author (not captured). One row each (a CodeLens is the only text an extension can put
// above a line, and it is a single row): the value, then a few words on what it is. Nothing is highlighted.

/** `name`: the variable; `value`: what it holds, on one line; `text`: the line it is on (to find it again). */
/** `note`: a few words on what the value is, after it on the same row. */
export interface ValueHint { name: string; value: string; note?: string; file: string; line: number; text: string }

export function readValues(v: unknown): ValueHint[] {
  if (!Array.isArray(v)) return []
  return v.filter((x) => x && typeof x.name === 'string' && x.name.trim() && typeof x.value === 'string' && typeof x.file === 'string' && Number.isInteger(x.line) && x.line >= 1)
    .map((x) => ({ name: x.name.trim(), value: x.value.replace(/\s+/g, ' ').trim(), file: x.file.trim(), line: x.line, text: typeof x.text === 'string' ? x.text : '',
      ...(typeof x.note === 'string' && x.note.trim() ? { note: x.note.replace(/\s+/g, ' ').trim() } : {}) }))
}

export class ValueHints implements vscode.Disposable {
  private key = ''
  /** By file URI: 0-based line, the hint's text and its line's text (to find it again after an edit). */
  private at = new Map<string, { line: number; title: string; text: string }[]>()
  private readonly changed = new vscode.EventEmitter<void>()
  private readonly subs: vscode.Disposable[]
  private seq = 0
  private follow: ReturnType<typeof setTimeout> | undefined

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
    // The hints follow edits to their file: moved at once, their lines' text checked once the typing pauses.
    vscode.workspace.onDidChangeTextDocument((e) => {
      const hs = this.at.get(e.document.uri.toString())
      if (!hs || !e.contentChanges.length) return
      const edits = e.contentChanges.map((c) => ({ start: c.range.start.line, end: c.range.end.line, text: c.text }))
      for (const h of hs) h.line = shiftLine(h.line, edits)
      this.changed.fire()
      clearTimeout(this.follow)
      this.follow = setTimeout(() => this.refind(e.document), 150)
    })]
  }

  private refind(doc: vscode.TextDocument): void {
    const u = doc.uri.toString(), hs = this.at.get(u)
    if (!hs) return
    const lines = Array.from({ length: doc.lineCount }, (_, i) => doc.lineAt(i).text)
    this.at.set(u, hs.flatMap((h) => { const line = followLine(lines, h.line, h.text, []); return line < 0 ? [] : [{ ...h, line }] }))
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
      for (const v of values) {
        const uri = vscode.Uri.joinPath(folder, renames.get(v.file) ?? v.file)
        let doc: vscode.TextDocument
        try { doc = await vscode.workspace.openTextDocument(uri) } catch { continue }
        const lines = Array.from({ length: doc.lineCount }, (_, i) => doc.lineAt(i).text)
        const line = v.text.trim() ? findLine(lines, v.line, v.text) : Math.min(v.line, doc.lineCount) - 1
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

  dispose(): void { clearTimeout(this.follow); for (const s of this.subs) s.dispose() }
}
