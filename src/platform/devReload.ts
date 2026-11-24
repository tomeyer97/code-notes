import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'

// Development only (F5, "Code Notes (dev)"): when the built extension or the panel's files change, the dev window
// reloads itself, so an edit shows without installing or reloading by hand. Never runs in an installed extension.

export function devReload(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): void {
  if (context.extensionMode !== vscode.ExtensionMode.Development) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const soon = (what: string) => {
    clearTimeout(timer)
    // The compiler writes many files at once: one reload when it has gone quiet.
    timer = setTimeout(() => { log.info(`dev: ${what} changed; reloading the window`); void vscode.commands.executeCommand('workbench.action.reloadWindow') }, 600)
  }
  for (const dir of ['out/src', 'media']) {
    try {
      const w = fs.watch(path.join(context.extensionPath, dir), (_e, f) => { if (f && /\.(js|css)$/.test(String(f))) soon(`${dir}/${f}`) })
      context.subscriptions.push({ dispose: () => w.close() })
    } catch (e) { log.warn(`dev: can't watch ${dir}: ${e}`) }
  }
}
