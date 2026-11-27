// A controller's explanation in the editor: a short label after the first revealed line, the whole text in a hover on
// the lines. Transient (core/bridge/hint.ts says what ends it): no comment thread, no CodeLens, nothing saved. Drawn
// in the inlay hints' colours, so it follows the theme; the label is one line, cut, so it fits a narrow editor.
import * as vscode from 'vscode'
import { HintState, hintLabel, TransientHint } from '../core/bridge/hint'
import { setCtx } from '../platform/context'
import { setDecorations } from '../platform/editorDecorations'
import { fireAndForget } from '../platform/run'

/** True while a hint is shown: Esc dismisses it then (the manifest's key). */
export const HINT_SHOWN_KEY = 'codeNotes.explanationShown'

const hintType = () => vscode.window.createTextEditorDecorationType({
  after: {
    color: new vscode.ThemeColor('editorInlayHint.foreground'),
    backgroundColor: new vscode.ThemeColor('editorInlayHint.background'),
    fontStyle: 'italic',
    margin: '0 0 0 2em',
  },
})

export class ExplanationHint implements vscode.Disposable {
  private readonly type = hintType()
  private readonly hint = new TransientHint(() => this.changed())
  private readonly subs: vscode.Disposable[] = [
    vscode.window.onDidChangeVisibleTextEditors(() => this.paint()),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length) this.hint.notice({ kind: 'edit', uri: e.document.uri.toString() })
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      const caret = e.selections[0]?.active
      if (caret) this.hint.notice({ kind: 'selection', uri: e.textEditor.document.uri.toString(), line: caret.line })
    }),
  ]

  /** Shows `text` (Markdown, its links and HTML not run) beside lines start..end (0-based) of `uri`. */
  show(uri: vscode.Uri, start: number, end: number, text: string, author: string): void {
    this.hint.show({ uri: uri.toString(), start, end, text, author })
  }

  /** Esc, a reveal without text, or the command. */
  dismiss(): void { this.hint.dismiss() }

  /** For tests: what is shown (none: dismissed). */
  get state(): HintState | undefined { return this.hint.state }

  dispose(): void {
    this.hint.dismiss()
    this.type.dispose()
    for (const s of this.subs) s.dispose()
  }

  private changed(): void {
    fireAndForget(setCtx(HINT_SHOWN_KEY, !!this.hint.state), 'bridge: setCtx codeNotes.explanationShown')
    this.paint()
  }

  private paint(): void {
    const shown = this.hint.state
    for (const ed of vscode.window.visibleTextEditors) {
      const here = shown && ed.document.uri.toString() === shown.uri
      setDecorations(ed, this.type, here ? decorations(shown, ed.document) : [])
    }
  }
}

/** The label at the end of the first line (no hover of its own), and the hover over all the lines. */
function decorations(s: HintState, doc: vscode.TextDocument): vscode.DecorationOptions[] {
  const last = Math.min(s.end, doc.lineCount - 1)
  const firstEnd = doc.lineAt(Math.min(s.start, last)).range.end
  return [
    { range: new vscode.Range(firstEnd, firstEnd), renderOptions: { after: { contentText: hintLabel(s.text) } } },
    { range: new vscode.Range(s.start, 0, last, doc.lineAt(last).range.end.character), hoverMessage: hover(s) },
  ]
}

/** The author, then the text as Markdown that runs nothing: no command links, no HTML. */
function hover(s: HintState): vscode.MarkdownString {
  const md = new vscode.MarkdownString()
  md.isTrusted = false
  md.supportHtml = false
  return md.appendText(`${s.author}:`).appendMarkdown(`\n\n${s.text}`)
}
