// The preview tabs a walk opened, closed when it finishes (the map gets its width back).
import * as vscode from 'vscode'
import { journeys } from './ports'
import { fileOf, LoadedJourney } from '../journeys/steps'

/** The walk's own preview tab in `column` (the code group it used), not one you kept open or edited: closed. */
export async function closeWalkTabs(lj: LoadedJourney, column: vscode.ViewColumn | undefined): Promise<void> {
  const tabs = column ? walkPreviewTabs(lj, column) : []
  if (tabs.length) await vscode.window.tabGroups.close(tabs, true)
}

/** Preview tabs in `column` showing one of the journey's step files (or a file its animations show), not edited. */
function walkPreviewTabs(lj: LoadedJourney, column: vscode.ViewColumn): vscode.Tab[] {
  const renames = journeys().renames(lj)
  const beatFiles = lj.j.steps.flatMap((s) => (s.scene?.beats ?? []).map((b) => b.code?.file).filter((f): f is string => typeof f === 'string'))
  const stepFiles = new Set([
    ...lj.j.steps.map((s) => vscode.Uri.joinPath(lj.folder.uri, fileOf(lj, s.n)).toString()),
    ...beatFiles.map((f) => vscode.Uri.joinPath(lj.folder.uri, renames.get(f) ?? f).toString()),
  ])
  return vscode.window.tabGroups.all.filter((g) => g.viewColumn === column).flatMap((g) => g.tabs)
    .filter((t) => t.isPreview && !t.isDirty && t.input instanceof vscode.TabInputText && stepFiles.has(t.input.uri.toString()))
}
