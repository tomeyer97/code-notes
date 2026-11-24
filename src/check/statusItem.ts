// The understanding check's status bar item: what it shows, sent to the window only when it changed (each change is a
// message to the window), read out as words.
import * as vscode from 'vscode'
import { Cmd } from '../platform/commands'
import { STATUS_ITEM_ID } from './constants'

/** What the item shows: viewModel.ts statusText's text and tooltip, amber when `warn`. */
export interface StatusLook { text: string; tip: string; warn: boolean }

/** The tooltip read out as words: without the ✓ and with sentences, not " · " (VS Code would read the icon's id). */
export const spokenLabel = (tip: string): string => `Understanding check: ${tip.replace(/^✓\s*/, '').replace(/ · /g, '. ')}`

export class CheckStatusItem implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(STATUS_ITEM_ID, vscode.StatusBarAlignment.Left, 48)
  /** What it shows now ('hidden', or unknown: undefined, as at first and while the questions are written). */
  private shown: StatusLook | 'hidden' | undefined

  constructor() {
    this.item.name = 'Understanding check'
    this.item.command = Cmd.checkUnderstanding
  }

  /** `look`, or hidden (undefined). */
  show(look: StatusLook | undefined): void {
    const was = this.shown
    if (look ? was !== 'hidden' && was !== undefined && sameLook(was, look) : was === 'hidden') return
    this.shown = look ?? 'hidden'
    if (!look) { this.item.hide(); return }
    this.item.text = look.text
    this.item.tooltip = look.tip
    this.item.accessibilityInformation = { label: spokenLabel(look.tip), role: 'button' }
    this.item.backgroundColor = look.warn ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined
    this.item.show()
  }

  /** While the questions are written (show() takes over again after). */
  writing(): void {
    this.shown = undefined
    this.item.text = '$(sync~spin) Understanding'
    this.item.accessibilityInformation = { label: 'Understanding check: writing questions', role: 'button' }
    this.item.show()
  }

  /** For the integration test: what the window has. */
  state(): { label?: string; text: string; warn: boolean } {
    return { label: this.item.accessibilityInformation?.label, text: this.item.text, warn: !!this.item.backgroundColor }
  }

  dispose(): void { this.item.dispose() }
}

const sameLook = (a: StatusLook, b: StatusLook) => a.text === b.text && a.tip === b.tip && a.warn === b.warn
