// Driving the podcast as a listener does: start it, pause, play, seek, the panel and the Listen view; the camera's
// waits set for one test only; and `podTest`, which every podcast test is written with.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'
import { sleep, test, windowShot } from '../../helpers'
import { ui } from '../../devtools'
import { ctx, tour } from '../context'
import { podcastFile } from './fixtures'
import { codeFile, litLine, LOAD_MS, MOVE_MS, pod, podUntil, QUICK_MS } from './state'
import { frameOf, realClick, watchConsole } from './webview'

/* eslint-disable @typescript-eslint/no-explicit-any */
/** A command to the player that has the audio (the Listen view, or the panel when only it may play), as the
 *  extension passes on a button's. */
export const send = (m: { action: string; [k: string]: unknown }) => ctx.api.hostSend({ type: 'podcastCmd', ...m })
export const seek = (to: number) => send({ action: 'seek', to })
/** Ctrl+' Space: play or pause. */
export const toggle = () => vscode.commands.executeCommand('codeNotes.podcastToggle')

export async function pause(): Promise<void> {
  await toggle()
  await podUntil('paused', () => !pod().playing)
}
export async function play(): Promise<void> {
  await toggle()
  await podUntil('playing', () => pod().playing)
}

/** The walk at `step` (0: none), the code group on `file`, the animation's line `line` lit (0: none), no move on its way. */
export const at = (step: number, file?: string, line = 0) => () =>
  tour().step === step && (!file || codeFile() === file) && litLine() === line && !pod().applying

/** A seek to `t` s, then a wait for `where` (what the walk shows at that time), `what` naming it. */
export async function seekTo(t: number, what: string, where: () => boolean): Promise<void> {
  await seek(t)
  await podUntil(what, where, MOVE_MS)
}

// Fixed waits, each for one of the extension's timers (a wait for a state uses podUntil). Not scaled: the timers aren't.
/** Outlasts src/podcast/follow.ts NO_WAIT_AFTER_SEEK_S (1.5 s): after it, a camera move may wait again. */
export const AFTER_SEEK_MS = 1600
/** Outlasts src/platform/timings.ts OWN_MOVE_MS (1.5 s): after it, a scroll is the reader's, not the walk's. */
export const AFTER_OWN_MOVE_MS = 1700
/** Waits `ms` for one of the extension's timers (`why`) to run out. */
export const outlast = (ms: number, why: string) => { void why; return sleep(ms) }
/** Waits `ms` before asserting that something (`what`) did not happen: time for a wrong reaction to show up. */
export const noChangeFor = (ms: number, what: string) => { void what; return sleep(ms) }

/**
 * Starts journey `id`'s podcast from a command (a Journeys row's ▶ Listen) and waits until it plays.
 *
 * VS Code lets a webview's audio play only after a click or a key in that webview (a click in the workbench or in
 * another webview does not count), once per webview. A Listen view that has had one plays at once. One that hasn't
 * refuses: the audio goes to the journey panel, paused, its ▶ focused, and Space there plays it (once the panel has
 * had its own click, a command plays there at once). A Listen view that has the audio but no click yet waits for a
 * click on its own ▶. `ownMs`: how long it may take to play on its own (a long recording loads a while first).
 */
export async function startPlaying(id: string, { ownMs = 3000 } = {}): Promise<void> {
  await vscode.commands.executeCommand('codeNotes.playPodcast', id)
  await podUntil('the panel shows it', () => tour().map === id && pod().mapVisible, LOAD_MS)
  const playing = () => pod().playing && pod().session === id
  if (!(await podUntil('playing on its own', playing, ownMs).catch(() => false))) {
    if (await podUntil('the audio moved to the panel', () => pod().hostIn === 'panel', QUICK_MS).catch(() => false)) {
      const tab = () => vscode.window.tabGroups.activeTabGroup.activeTab?.input
      await podUntil('the panel is the active editor', () => tab() instanceof vscode.TabInputWebview && /codeNotes\.journey/.test((tab() as vscode.TabInputWebview).viewType), QUICK_MS)
      await sleep(500) // the focus inside the panel settles on its ▶ (no event for it)
      await (await ui()).keyboard.press('Space')
    } else {
      const f = await frameOf('listen')
      await podUntil('▶ has the keyboard', async () => (await f.evaluate(() => (globalThis as any).document.activeElement?.className)) === 'pod-b play', QUICK_MS)
      await f.click('.pod-b.play')
    }
  }
  await podUntil('playing', playing, LOAD_MS)
}

/**
 * Journey `id`'s podcast loaded (`write` writes it when missing) and paused, its session the one listened to: where
 * most tests start. Started (and paused) only when another journey's podcast is the one listened to, or (`panel`)
 * when the journey panel isn't on screen; otherwise it stays where the test before left it.
 */
export async function listenTo(id: string, write: () => void, { panel = true } = {}): Promise<void> {
  write()
  await podUntil('its podcast is found', () => pod().journeys.includes(id), LOAD_MS)
  if (pod().session !== id || (panel && !pod().mapVisible)) await startPlaying(id)
  if (pod().playing) await pause()
}

/**
 * The Listen view there and unlocked, as the first playback test leaves it, with journey `id` paused in it. The
 * view goes 3 s after nothing is listened to (src/podcast/statusItem.ts LISTENING_OFF_MS), and a new one is locked
 * until a click in it: a test whose podcast is unavailable for longer (a slow machine) puts it back with this.
 */
export async function listenViewUnlocked(id: string): Promise<void> {
  if (pod().unlocked.listen && pod().listenAlive) return
  await startPlaying(id)
  if (pod().playing) await pause()
  if (pod().mapVisible) await closePanel()
  await podUntil('the audio in the Listen view', () => pod().hostIn === 'listen' && pod().hostAlive && pod().hostVisible, MOVE_MS)
  await realClick(await frameOf('listen'), '.pod-b.play')
  await podUntil('the Listen view\'s ▶ plays there; the view unlocked', () => pod().playing && pod().hostIn === 'listen' && pod().unlocked.listen, MOVE_MS)
  await pause()
}

/** Every editor closed but the journey panel. */
export async function closeAllButPanel(): Promise<void> {
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => !(t.input instanceof vscode.TabInputWebview && /codeNotes\.journey/.test(t.input.viewType)))
  if (tabs.length) await vscode.window.tabGroups.close(tabs, true)
}
/** The journey panel closed (the audio plays on in the Listen view). */
export async function closePanel(): Promise<void> {
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputWebview && /codeNotes\.journey/.test(t.input.viewType))
  if (tabs.length) await vscode.window.tabGroups.close(tabs, true)
  await podUntil('the panel closed', () => !pod().mapVisible, QUICK_MS)
}
/** The panel open on journey `id`, the one listened to (the status item's click). */
export async function openPanel(id: string): Promise<void> {
  await vscode.commands.executeCommand('codeNotes.podcastOpen')
  await podUntil('the panel shows it', () => tour().map === id && pod().mapVisible, LOAD_MS)
}
/** The Listen view's section collapsed (or open again) in the side bar, as a click on its header does. */
export async function setListenCollapsed(collapsed: boolean): Promise<void> {
  await vscode.commands.executeCommand('codeNotes.listen.focus')
  const h = (await ui()).locator('.pane-header', { hasText: /^\s*listen/i }).first()
  if (((await h.getAttribute('aria-expanded')) === 'true') === collapsed) await h.click()
  await podUntil(`the Listen view ${collapsed ? 'collapsed' : 'open'}`, async () => ((await h.getAttribute('aria-expanded')) === 'true') !== collapsed, 3000)
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup')
}

/** The editor groups' widths (px), side by side. */
export async function editorLayout(): Promise<number[]> {
  const l = await vscode.commands.executeCommand<{ groups: { size?: number }[] }>('vscode.getEditorLayout')
  return l.groups.map((g) => Math.round(g.size ?? 0))
}
/** The groups with a tab on a file named `name`. */
export const groupsShowing = (name: string) => vscode.window.tabGroups.all.filter((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputText && path.basename(t.input.uri.fsPath) === name))

/** Journey `id`'s podcast file's problems in the Problems view. */
export const diagnostics = (id: string) => vscode.languages.getDiagnostics(vscode.Uri.file(podcastFile(id)))
/** The 0-based line of the first line of `file` with `text`. */
export const lineOf = (file: string, text: string) => fs.readFileSync(file, 'utf8').split('\n').findIndex((l) => l.includes(text))

/**
 * Global settings `values` in `section` for the length of `fn`, put back as they were afterwards (also when `fn`
 * fails: a timed-out test leaves no setting behind for the tests after it).
 */
export async function withSettings<T>(section: string, values: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const c = vscode.workspace.getConfiguration(section)
  const before = Object.keys(values).map((k) => [k, c.inspect(k)?.globalValue] as const)
  try {
    for (const [k, v] of Object.entries(values)) await c.update(k, v, vscode.ConfigurationTarget.Global)
    return await fn()
  } finally {
    for (const [k, v] of before) await c.update(k, v, vscode.ConfigurationTarget.Global)
  }
}

/**
 * A podcast test. The camera's waits (codeNotes.listen.readBeforeMove, settleAfterMove: s, 0 off) are `waits` for its
 * length only (off unless given: the walk's own timing is tested without them). `consoleClean`: the workbench console is
 * watched while it runs and must show no error from the extension's pages.
 */
export function podTest(name: string, fn: () => Promise<void | string>, { waits = [0, 0] as [number, number], consoleClean = false } = {}) {
  return test(name, () => withSettings('codeNotes.listen', { readBeforeMove: waits[0], settleAfterMove: waits[1] }, async () => {
    const watched = consoleClean ? watchConsole() : undefined
    try {
      const detail = await fn()
      const errors = watched?.errors() ?? []
      assert.deepEqual(errors, [], `console errors from the extension's pages:\n${errors.join('\n')}`)
      return detail
    } finally { watched?.dispose() }
  }))
}

/**
 * Pictures for a person to look at (CODE_NOTES_SHOTS): the window as it is, and with `palette` the palette filtered
 * to "Listen" and the journey picker open.
 */
export async function shots(tag: string, palette = false): Promise<void> {
  if (!process.env.CODE_NOTES_SHOTS) return
  await windowShot(tag, { wait: 600 })
  if (!palette) return
  await vscode.commands.executeCommand('workbench.action.quickOpen', '>Listen')
  await windowShot(`${tag}-palette`, { wait: 800 })
  await vscode.commands.executeCommand('workbench.action.closeQuickOpen')
  const picked = vscode.commands.executeCommand('codeNotes.openJourney')
  await windowShot(`${tag}-picker`, { wait: 800 })
  await vscode.commands.executeCommand('workbench.action.closeQuickOpen')
  await picked
}
