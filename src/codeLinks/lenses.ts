// One CodeLens provider for the rows this feature puts above lines: the step's value hints, a chat link's Back row
// and a code link's Back row. A hint never shares a line with the code link's Back row.
import * as vscode from 'vscode'
import type { ClaudeLinks } from './claudeChatLinks'
import type { CodeLinks } from './codeLinks'
import type { ValueHints } from './valueHints'

export function registerLinkLenses(s: { codeLinks: CodeLinks; claudeLinks: ClaudeLinks; valueHints: ValueHints }): vscode.Disposable {
  const changed = new vscode.EventEmitter<void>()
  const provider: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: changed.event,
    provideCodeLenses(doc) {
      const back = s.codeLinks.backAt
      const onBackRow = (l: vscode.CodeLens) => !!back && back.uri === doc.uri.toString() && back.line === l.range.start.line
      // In the order VS Code drew them when each had its own provider (the newest provider's rows first on a line).
      return [...s.valueHints.lenses(doc).filter((l) => !onBackRow(l)), ...s.claudeLinks.lenses(doc), ...s.codeLinks.lenses(doc)]
    },
  }
  const fire = () => changed.fire()
  return vscode.Disposable.from(
    changed,
    s.codeLinks.onDidChange(fire), s.claudeLinks.onDidChange(fire), s.valueHints.onDidChange(fire),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, provider),
  )
}
