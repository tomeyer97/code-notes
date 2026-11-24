import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { Debouncer } from './debounce'

// Development only (F5, "Code Notes (dev)"): when the built extension or the panel's files change, the dev window
// reloads itself, so an edit shows without installing or reloading by hand. Never runs in an installed extension.

/** The compiler writes many files at once: the window reloads once nothing has changed for this long. */
const QUIET_MS = 600

export function devReload(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): void {
  if (context.extensionMode !== vscode.ExtensionMode.Development) return
  const reload = new Debouncer('dev: reload the window')
  context.subscriptions.push(reload)
  const soon = (what: string) => reload.later('', QUIET_MS, () => {
    log.info(`dev: ${what} changed; reloading the window`)
    return vscode.commands.executeCommand('workbench.action.reloadWindow')
  })
  // media/: the pages' styles; out/pages/: their scripts, bundled again by `npm run watch`.
  for (const dir of ['out/src', 'out/pages', 'media']) {
    try {
      const w = fs.watch(path.join(context.extensionPath, dir), (_e, f) => {
        if (f && /\.(js|css)$/.test(String(f))) soon(`${dir}/${f}`)
      })
      context.subscriptions.push({ dispose: () => w.close() })
    } catch (e) {
      log.warn(`dev: can't watch ${dir}: ${e}`)
    }
  }
}
