// What is wrong with the journey: why readers can't read it, and author mode (rule breaks only its author can fix,
// shown while `codeNotes.journeys.authorMode` is on).

import * as vscode from 'vscode'
import type { ProblemsInfo } from '../../../protocol/map'
import type { LoadedJourney } from '../../steps'
import type { PanelFeature } from '../controller'
import { journeys, mapPanel } from '../../../tour/ports'
import { cfg } from '../../../platform/settings'
import { log } from '../../../platform/host'
import { relPath } from '../../../platform/documents'
import { fireAndForget } from '../../../platform/run'
import { wfs } from '../../../platform/workspaceFs'

/** The author mode setting: the one place its name is spelled. The setting is the state. */
export const authorMode = {
  key: 'journeys.authorMode',
  on: (): boolean => cfg().get<boolean>(authorMode.key) ?? false,
  /** Off for the user, and in the workspace too when it is set there. */
  async turnOff(): Promise<void> {
    await cfg().update(authorMode.key, false, vscode.ConfigurationTarget.Global)
    if (cfg().inspect(authorMode.key)?.workspaceValue) await cfg().update(authorMode.key, false, vscode.ConfigurationTarget.Workspace)
  },
}

export function authorFeature(): PanelFeature {
  return {
    name: 'author mode',
    handlers: {
      authors: (lj) => showRuleBreaks(lj),
      restore: (lj) => restoreLastGood(lj),
    },
    slice: (lj): ProblemsInfo => ({
      problems: lj.readError ? [lj.readError] : [],
      authors: authorMode.on() ? lj.j.problems.length : 0,
    }),
  }
}

/** The command (shown only while author mode is on) turns it off. */
export async function toggleAuthorMode(): Promise<void> {
  await authorMode.turnOff()
  vscode.window.setStatusBarMessage('$(info) Journey author mode off', 2500)
  mapPanel().update()
}

/** Author mode: the journey's rule breaks, in the Output channel. */
function showRuleBreaks(lj: LoadedJourney): void {
  const list = lj.j.problems.map((p) => `  - ${p}`).join('\n')
  log().info(`journey ${lj.j.id} (${relPath(lj.folder, lj.uri)}): ${lj.j.problems.length} rule break(s) for its author:\n${list}`)
  log().show(true)
}

/** A journey file that can't be read: back to its last good version. */
function restoreLastGood(lj: LoadedJourney): void {
  const raw = journeys().lastGood.get(lj.key)
  // Nothing to write back: said, not a click that does nothing.
  if (!raw) {
    vscode.window.setStatusBarMessage(`$(info) No earlier version of ${lj.j.title} to restore`, 4000)
    return
  }
  const restored = () => vscode.window.setStatusBarMessage(`$(check) Restored ${lj.j.title}`, 4000)
  const failed = (e: unknown) => {
    log().warn(`journey ${lj.j.id}: restoring its last good version failed: ${e}`)
    const why = e instanceof Error ? e.message : String(e)
    fireAndForget(vscode.window.showErrorMessage(`Couldn't restore ${lj.j.title}: ${why}`), 'panel: restore failed message')
  }
  fireAndForget(wfs.writeFile(lj.uri, new TextEncoder().encode(raw)).then(restored, failed), 'panel: restore the last good version')
}
