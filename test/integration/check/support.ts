// What several chapters of the check suite need besides context.ts: the links in a comment, the notes made from the
// check, changes to shared state that are undone in `finally` (the check file, the window's size, the remote's hook),
// real clicks in the Check view.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'
import { cdp, checkFrame, ui } from '../devtools'
import { api, checkFile, readCheck } from './context'
import { clickedLink } from '../../../src/platform/commands'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A command link in a comment's markdown: its text (markup taken out), the command and its arguments. */
export type CommandLink = { label: string; command: string; args: unknown[] }

/** The command links in a comment's markdown, as VS Code runs them when clicked (a short link as its own command). */
export function commandLinks(markdown: string): CommandLink[] {
  return [...markdown.matchAll(/\[([^\]]*)\]\(command:([\w.]+)(?:\?([^ )]+))?[^)]*\)/g)].map((m) => {
    let args: unknown = []
    try { if (m[3]) args = JSON.parse(decodeURIComponent(m[3])) } catch { assert.fail(`the arguments of the ${m[2]} link do not parse: ${m[3]}`) }
    const label = m[1].replace(/<[^>]*>/g, '').replace(/\\(.)/g, '$1').trim()
    // A thread's short link (codeNotes.link?<key>) runs the command it stands for.
    return { label, ...clickedLink(m[2], Array.isArray(args) ? args : [args]) }
  })
}

/** The links of a comment (its body is markdown). */
export const linksOf = (c: vscode.Comment): CommandLink[] => commandLinks((c.body as vscode.MarkdownString).value)

/** Notes made from the check (Ask Claude on a question, Suggest a fix): they belong to its branch. */
export const notesFromCheck = () => (api.snapshot().notes as any[]).filter((n) => n.extra?.checkFix || n.extra?.checkAsk)
/** The note asked with Ask Claude on question `q` of feat/limits's check. */
export const noteAskedFrom = (q: string) => {
  const text = readCheck().questions.find((x: any) => x.id === q)?.text
  return notesFromCheck().find((n) => n.extra?.checkAsk === text)
}
/** The note Suggest a fix made for question `q`'s concern. */
export const fixNoteFor = (q: string) => notesFromCheck().find((n) => n.extra?.checkFix === q)

/** Runs `fn` with the check file as `text` on disk, and puts the file back as it was afterwards, failed or not. */
export async function withCheckFile<T>(text: string, fn: () => Promise<T>): Promise<T> {
  const was = fs.readFileSync(checkFile, 'utf8')
  fs.writeFileSync(checkFile, text)
  try { return await fn() } finally { fs.writeFileSync(checkFile, was) }
}

/**
 * Runs `fn` with the workbench at `width`×`height` and zoom 0 (the DevTools window emulation), then puts the zoom and
 * the size back, failed or not.
 */
export async function withWindowSize<T>(width: number, height: number, fn: (page: import('playwright').Page) => Promise<T>): Promise<T> {
  const page = await ui()
  const session = await page.context().newCDPSession(page)
  const window = () => vscode.workspace.getConfiguration('window')
  const zoom = window().inspect<number>('zoomLevel')?.globalValue
  await window().update('zoomLevel', 0, vscode.ConfigurationTarget.Global)
  await session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  try { return await fn(page) } finally {
    await session.send('Emulation.clearDeviceMetricsOverride')
    await window().update('zoomLevel', zoom, vscode.ConfigurationTarget.Global)
    await session.detach()
  }
}

/**
 * Clicks an element of the Check view for real (DevTools), as a person would. `text`: the element must show it (the
 * page draws a new view a moment after the model has it: this waits for the button that view has).
 */
export async function clickInCheckView(selector: string, text?: string | RegExp): Promise<void> {
  await (await checkFrame()).locator(selector, text === undefined ? {} : { hasText: text }).first().click()
}

/**
 * Runs `fn` with a `pre-receive` hook in the bare `remote` that prints how to open a merge request for `branch`, as
 * GitLab does for a branch without one; the hook is gone afterwards. Returns what `fn` returns.
 */
export async function withMergeRequestHint<T>(remote: string, branch: string, url: string, fn: () => Promise<T>): Promise<T> {
  const hook = path.join(remote, 'hooks', 'pre-receive')
  fs.writeFileSync(hook, `#!/bin/sh\necho "To create a merge request for ${branch}, visit:"\necho "  ${url}"\n`, { mode: 0o755 })
  try { return await fn() } finally { fs.rmSync(hook, { force: true }) }
}

/** Tests marked so stand in for a `devtools` one when there is no DevTools connection (a command, not real input). */
export const withoutDevtools = { when: () => !cdp, whenNot: 'DevTools: the test with real input runs instead' }
