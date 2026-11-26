// The main suite's window: the workspace run.ts made (src/app.ts and nothing else at first), the extension's test API,
// and short ways to read its state. Every test file of the main suite imports these; suite.ts fills `ctx` once, from
// `createSuiteContext` (helpers.ts), before any test runs.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import type { TestApi } from '../../../src/testApi'
import { clickedLink } from '../../../src/platform/commands'
import type { SuiteContext } from '../helpers'
import { waiter } from '../helpers'

/* eslint-disable @typescript-eslint/no-explicit-any */
let suite: SuiteContext | undefined
/** The suite context, or a clear error when a test file uses it before suite.ts has set it up. */
const ready = (): SuiteContext => {
  if (!suite) throw new Error('main/context.ts: ctx used before suite.ts set it up (setMainContext)')
  return suite
}

/** Sets `ctx` from the suite's context (suite.ts, once the extension is active). */
export function setMainContext(context: SuiteContext): void { suite = context }

export const ctx = {
  /** The extension's test API (src/testApi.ts: what `activate` returns). */
  get api(): TestApi { return ready().api },
  get folder(): vscode.WorkspaceFolder { return ready().folder },
  /** The workspace folder on disk. */
  get ws(): string { return ready().ws },
  /** <ws>/.code-notes */
  get notesDir(): string { return ready().notesDir },
}

/** The editor groups as "column: tab, tab" (* the active tab, ! the active group): where the code and the map are. */
const groupsNow = () => vscode.window.tabGroups.all.map((g) =>
  `${g.isActive ? '!' : ''}${g.viewColumn}: ${g.tabs.map((t) => `${t.isActive ? '*' : ''}${t.label}`).join(', ')}`)

/** The main suite's wait (6 s by default): on a timeout it prints the tour's state (most waits are on it), where the
 *  active editor is and the editor groups. */
export const until = waiter({ dump: () => {
  try {
    const s = suite?.api.snapshot()
    return s && { at: suite ? at() : '', groups: groupsNow(), journeys: s.journeys.map((j: { id: string; steps: number }) => `${j.id} (${j.steps} steps)`), tour: s.tour && { ...s.tour, story: undefined } }
  } catch { return undefined }
} })

/** Everything the extension shows, as data (notes, journeys, the tour, counts). */
export const snap = () => ctx.api.snapshot()
/** The tour/journey panel's state: the walk, the step card, the map, the tutorial. */
export const tour = () => snap().tour
export const noteById = (id: string): any => snap().notes.find((n: any) => n.id === id)
export const noteAtPath = (p: string): any => snap().notes.find((n: any) => n.path === p)
export const journeyById = (id: string): any => snap().journeys.find((j: any) => j.id === id)
/** The Notes view, one line per row. */
export const notesTree = (): string[] => snap().tree()
/** The Journeys view, one line per row. */
export const journeysTree = (): string[] => ctx.api.journeysTree()

export const wsPath = (...p: string[]) => path.join(ctx.ws, ...p)
export const notePath = (id: string) => path.join(ctx.notesDir, `${id}.json`)
/** The personal journeys folder, <ws>/.code-notes/journeys. */
export const journeysDir = () => path.join(ctx.notesDir, 'journeys')

/** Where the active editor is: "src/flow.ts:2" (1-based), '' with none. */
export const at = () => { const e = vscode.window.activeTextEditor; return e ? `${path.relative(ctx.ws, e.document.uri.fsPath)}:${e.selection.active.line + 1}` : '' }

/** Puts the caret at the start of `line` (0-based) in `editor`. */
export const caretAt = (editor: vscode.TextEditor, line: number) => { editor.selection = new vscode.Selection(line, 0, line, 0) }

/** The workspace setting codeNotes.<key> (undefined removes it). */
export const setting = (key: string, value: unknown) => vscode.workspace.getConfiguration('codeNotes').update(key, value, vscode.ConfigurationTarget.Workspace)

/** A thread's first comment as markdown. */
export const bodyOf = (c: vscode.Comment) => (c.body as vscode.MarkdownString).value

/** The command links in Markdown as a click runs them: label, command and arguments (a thread's short link
 *  `codeNotes.link?<key>` as the command it stands for). */
export function commandLinksIn(markdown: string): { label: string; command: string; args: unknown[] }[] {
  return [...markdown.matchAll(/\[([^\]]*)\]\(command:([\w.]+)(?:\?([^ )]+))?/g)].map((m) => {
    const args = m[3] ? JSON.parse(decodeURIComponent(m[3])) : []
    return { label: m[1], ...clickedLink(m[2], Array.isArray(args) ? args : [args]) }
  })
}

export const closeAllEditors = () => vscode.commands.executeCommand('workbench.action.closeAllEditors')

/** Is a text tab whose path matches `re` open in any group? */
export const tabOpen = (re: RegExp) => vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputText && re.test(t.input.uri.path)))

/** The CodeLenses VS Code gets for `uri` (always named: while a panel has the focus there is no active editor). */
export async function codeLenses(uri: vscode.Uri): Promise<vscode.CodeLens[]> {
  return (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri)) ?? []
}

/** The CodeLenses of `uri` as "line:title", the line 1-based as the editor shows it. */
export async function lenses(uri: vscode.Uri): Promise<string[]> {
  return (await codeLenses(uri)).map((l) => `${l.range.start.line + 1}:${l.command?.title ?? ''}`)
}

/** The fake claude CLI (test/fixtures/fake-claude.js). */
const FAKE_CLAUDE = path.join(__dirname, '../../../../test/fixtures/fake-claude.js')

/**
 * The fake claude CLI as codeNotes.claude.path, logging its runs to a file of this workspace's (other test runs on
 * this machine share the temp folder), which `fakeCalls` reads. The notes chapter wires it up in its own test (the
 * notes it creates before must not be asked to Claude: src/notes/create.ts); every chapter after it calls this in its
 * setup (suite.ts), so it runs alone too. Calling it again changes nothing.
 */
export async function useFakeClaude(): Promise<void> {
  const log = path.join(ctx.ws, '..', `fake-claude-${path.basename(ctx.ws)}.log`)
  const config = vscode.workspace.getConfiguration('codeNotes').inspect<string>('claude.path')?.workspaceValue
  if (process.env.FAKE_CLAUDE_LOG === log && config === FAKE_CLAUDE) return
  process.env.FAKE_CLAUDE_LOG = log
  await setting('claude.path', FAKE_CLAUDE)
}

/**
 * The notes folder there and watched by the window, as the notes chapter leaves it: a chapter run alone starts from
 * it. A folder made together with its parent (mkdir -p .code-notes/journeys) can be missed by the window's file
 * watcher for good (it watches a new folder once it has seen it, and the inner one came first); then no change in it
 * is ever reported. A probe file in it is written until the watcher reports it.
 */
export async function notesFolderWatched(): Promise<void> {
  if (fs.existsSync(ctx.notesDir)) return
  fs.mkdirSync(ctx.notesDir)
  const probe = path.join(ctx.notesDir, '.watched')
  const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(ctx.folder, path.relative(ctx.ws, probe)))
  let seen = false
  w.onDidCreate(() => { seen = true })
  w.onDidChange(() => { seen = true })
  try {
    await until('the notes folder watched by the window', () => {
      if (!seen) fs.writeFileSync(probe, String(Date.now()))
      return seen
    })
  } finally {
    w.dispose()
    fs.rmSync(probe, { force: true })
  }
}
