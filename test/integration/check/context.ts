// The understanding check suite's window (see index.ts): the workspace (examples/shop on feat/limits), the extension's
// test API, short ways to read the check's state and answer its questions, and what earlier tests leave for later
// ones. Every chapter file of this folder imports these.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { REFRESH_SOON_MS } from '../../../src/check/constants'
import type { TestApi } from '../../../src/testApi'
import { activate, waiter } from '../helpers'
import { cdp, checkFrame, ui } from '../devtools'

/* eslint-disable @typescript-eslint/no-explicit-any */
/** What a timed-out wait prints: the check's state, or what the test running wants to see instead (`setDumpState`). */
export let dumpState: () => unknown = () => undefined
export function setDumpState(dump: () => unknown): void { dumpState = dump }
/** This suite's waits, until's and untilEqual's: 10 s by default (questions are written and graded by a script). */
export const CHECK_WAIT_MS = 10000
/** This suite's wait, the state printed on a timeout (main/context.ts has the main suite's). */
export const until = waiter({ ms: CHECK_WAIT_MS, dump: () => dumpState() })

/** The extension's check refresh debounce: file events, focus and saves wait this long (src/check/constants.ts). */
export const CHECK_DEBOUNCE_MS = REFRESH_SOON_MS

export const ws = vscode.workspace.workspaceFolders![0].uri.fsPath
/** The extension's test API (src/testApi.ts), set by `activateCheck` before the first test. */
export let api: TestApi
export async function activateCheck(): Promise<void> { api = await activate() }
export const checkFile = path.join(ws, 'understanding/feat-limits.json')
export const limitsPath = path.join(ws, 'api/limits.js')
export const understandingCli = path.join(__dirname, '../../../../cli/understanding.mjs')

/** The check's state (the extension has one: this window's folder is a git checkout). */
export const chk = () => api.check()!
/** What the Check view shows now. */
export const view = () => chk().view!
export const readCheck = () => JSON.parse(fs.readFileSync(checkFile, 'utf8'))
export const readCheckOr = () => { try { return readCheck() } catch { return undefined } }
export const checkNotes = () => (api.snapshot().notes as any[]).filter((n) => n.session === 'Check · feat/limits')
export const noteOf = (q: string) => checkNotes().find((n) => n.extra?.check?.q === q)
export const noteById = (id: string) => (api.snapshot().notes as any[]).find((n) => n.id === id)
export const git = (...a: string[]) => execFileSync('git', a, { cwd: ws, encoding: 'utf8' }).trim()
export const ciOutput = () => execFileSync('node', [understandingCli, 'ci', '--base', 'main'], { cwd: ws, encoding: 'utf8', env: { PATH: process.env.PATH } })
// The code editor's caret (the keyboard may be in the Check view's box, where there is no active editor).
export const codeEditor = () => { const a = vscode.window.activeTextEditor; return a?.document.uri.scheme === 'file' ? a : vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'file') }
export const editorLine = () => codeEditor()?.selection.active.line
export const inLines = (a: number, b: number) => { const l = editorLine(); return l !== undefined && l >= a && l <= b }
export const limitsEditor = () => vscode.window.visibleTextEditors.find((x) => x.document.uri.fsPath === limitsPath)
export const commentBody = (c: vscode.Comment) => (c.body as vscode.MarkdownString).value
export const threadComments = (id: string) => api.thread(id)!.comments as vscode.Comment[]

/** Answers a check question through its thread's reply (the command the Answer button runs). */
export async function answer(q: string, text: string): Promise<void> {
  await vscode.commands.executeCommand('codeNotes.answerCheck', { thread: api.thread(noteOf(q).id), text })
}
export const lastBody = (q: string) => { const m = noteOf(q).messages; return m[m.length - 1].body as string }

/** The Check view's main button shows `label`, on screen and clickable (nothing over it). */
export const buttonShown = async (label: string) => (await checkFrame()).evaluate((l) => {
  const d = (globalThis as any).document, b = d.querySelector('footer button.primary')
  if (!b || b.textContent !== l) return false
  const r = b.getBoundingClientRect()
  return r.top >= 0 && r.bottom <= (globalThis as any).innerHeight && d.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === b
}, label)

// The check's tour (feat/tour).
export const tourFile = path.join(ws, 'understanding/feat-tour.json')
export const readTour = () => JSON.parse(fs.readFileSync(tourFile, 'utf8'))
export const tourNote = (q: string) => (api.snapshot().notes as any[]).find((n) => n.session === 'Check · feat/tour' && n.extra?.check?.q === q)
export const tour = () => api.snapshot().tour

/** What earlier tests leave for later ones (other chapters read them). */
export const left = {
  /** Question 1's thread note, as Start made it (start.ts); branches.ts looks for its thread on main. */
  q1Note: undefined as any,
  /** The note asked from q1 (Ask Claude on a check question): hidden on other branches (askAndFix.ts, branches.ts). */
  askedNote: undefined as any,
  /** The note from Suggest a fix: hidden on other branches too. */
  fixNote: undefined as any,
}

/** Tests marked so need the DevTools connection (real clicks and keys) and are skipped without it. */
export const devtools = { when: () => cdp, whenNot: 'no DevTools' }

/** Types `text` into the box that has the keyboard (the Check view's answer box) and sends it with Ctrl+Enter. */
export async function typeAnswer(text: string): Promise<void> {
  const page = await ui()
  await page.keyboard.type(text)
  await page.keyboard.press('Control+Enter')
}

/** Clicks the link `text` in a comment thread for real with DevTools; otherwise runs `command` (what the link runs). */
export async function clickLinkOr(text: string, command: () => Thenable<unknown>): Promise<void> {
  if (cdp) await (await ui()).locator('.review-widget .comment-body a', { hasText: text }).first().click()
  else await command()
}

/** With DevTools: waits until the Check view's main button shows `label`, on screen and clickable. Without: no screen. */
export async function untilButtonShown(what: string, label: string): Promise<void> {
  if (cdp) await until(what, () => buttonShown(label))
}
