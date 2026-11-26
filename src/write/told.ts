// What writing journeys tells the person outside its own pages (a status bar line, a notification), the newest kept
// for the integration tests to read.
import * as vscode from 'vscode'

/** How many lines `told` keeps (the newest). */
const KEPT = 50

/** What was said, oldest first. */
export const told: string[] = []

function keep(text: string): void {
  told.push(text)
  if (told.length > KEPT) told.splice(0, told.length - KEPT)
}

/** A status bar line for `ms`. */
export function sayInStatusBar(text: string, ms = 3000): void {
  keep(text)
  vscode.window.setStatusBarMessage(text, ms)
}

/** A notification; resolves to the button clicked. */
export function notify(text: string, ...items: string[]): Thenable<string | undefined> {
  keep(text)
  return vscode.window.showInformationMessage(text, ...items)
}

/** A warning notification; resolves to the button clicked. */
export function warn(text: string, ...items: string[]): Thenable<string | undefined> {
  keep(text)
  return vscode.window.showWarningMessage(text, ...items)
}
