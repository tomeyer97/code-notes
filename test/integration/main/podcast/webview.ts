// The podcast's two webviews over the DevTools connection (run.ts opens the port): finding their frames, reading
// their players, real clicks, the console errors of their pages, and one probe of VS Code's own editor DOM.
import assert from 'assert'
import { sleep } from '../../helpers'
import { ui } from '../../devtools'
import { LOAD_MS, podUntil } from './state'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Frame = import('playwright').Frame

/**
 * The frame of one of the podcast's webviews: 'journey' (the journey panel, its remote player) or 'listen' (the Listen
 * view, where the audio is). One way to find both: a webview's page is a frame inside the webview's own iframe; of
 * those, the journey panel's iframe sits over the editor part and the Listen view's does not (or is hidden, while its
 * section is collapsed); then the page's own marker (`.pod` without `.ls-player` in the panel, `.ls-player .pod audio`
 * in the Listen view) tells a loaded page from one still loading.
 *
 * `quiet`: run no script inside (geometry only). A script the test runs in a webview (Playwright's evaluate) counts
 * there as a click, which unlocks its audio: the tests of the locked state may not do that.
 *
 * On a timeout the error says how far the search got: how many webview pages, how many in the right place, how many
 * with the marker.
 */
export async function frameOf(which: 'journey' | 'listen', { quiet = false } = {}): Promise<Frame> {
  const page = await ui()
  const editor = await page.locator('.part.editor').boundingBox()
  assert.ok(editor, 'the editor part on screen')
  let seen = ''
  try {
    return await podUntil(`the ${which} frame`, async () => {
      let pages = 0, placed = 0, marked = 0, detached = 0
      for (const f of page.frames()) {
        const outer = f.parentFrame()
        if (!outer || !outer.parentFrame()) continue
        pages++
        let box: { x: number; height: number } | null = null
        try { box = await (await outer.frameElement()).boundingBox() } catch { detached++; continue }
        const inEditor = !!box && box.height > 50 && box.x >= editor.x - 1
        if (inEditor !== (which === 'journey')) continue
        placed++
        if (quiet) { seen = `${pages} webview pages, ${placed} placed`; return f }
        let ok = false
        try {
          ok = await f.evaluate((w) => {
            const d = (globalThis as any).document
            return w === 'journey' ? !!d.querySelector('.pod') && !d.querySelector('.ls-player') : !!d.querySelector('.ls-player .pod audio')
          }, which)
        } catch { detached++; continue }
        if (ok) { marked++; seen = `${pages} webview pages, ${placed} placed, ${marked} with the marker`; return f }
      }
      seen = `${pages} webview pages, ${placed} ${which === 'journey' ? 'over the editor part' : 'outside it'}, ${marked} with the ${which} page's marker${detached ? `, ${detached} detached while looked at` : ''}`
      return undefined
    }, LOAD_MS)
  } catch (e) {
    throw new Error(`${(e as Error).message} (${seen})`, { cause: e })
  }
}

/** What the audio itself says (in the Listen view): its time, paused, the player's note or error, loaded whole. */
export async function listenAudio(): Promise<{ t: number; paused: boolean; note: string; blob: boolean }> {
  return (await frameOf('listen')).evaluate(() => {
    const d = (globalThis as any).document
    const a = d.querySelector('.pod audio')
    const e = d.querySelector('.pod-err')
    return { t: a.currentTime, paused: a.paused, note: e.hidden ? '' : e.textContent, blob: a.src.startsWith('blob:') }
  })
}

/** The text of `sel` in the journey panel, '' while it is hidden or missing. */
export async function panelText(sel: string): Promise<string> {
  return (await frameOf('journey')).evaluate((s) => { const e = (globalThis as any).document.querySelector(s); return e && !e.hidden ? e.textContent : '' }, sel)
}

/** Is `sel` laid out (shown) in the journey panel? */
export async function panelVisible(sel: string): Promise<boolean> {
  return (await frameOf('journey')).evaluate((s) => { const e = (globalThis as any).document.querySelector(s); return !!e && e.getClientRects().length > 0 }, sel)
}

/** The play button's state in a player (its data-on: 'true' shows ⏸). */
export async function playButtonOn(f: Frame): Promise<string> {
  return f.evaluate(() => (globalThis as any).document.querySelector('.pod-b.play').dataset.on)
}

/**
 * Chromium's transient user activation lasts 5 s. Reading where a button is runs a script in its webview, which
 * counts as a click there; a real click that comes later than this proves the click itself unlocked the audio.
 */
const OUTLAST_ACTIVATION_MS = 5500

/** A real click (the mouse, through the window) on `sel` in frame `f`, once the reading of its place has expired. */
export async function realClick(f: Frame, sel: string): Promise<void> {
  const b = await f.locator(sel).boundingBox()
  assert.ok(b, `${sel} on screen`)
  await sleep(OUTLAST_ACTIVATION_MS)
  await (await ui()).mouse.click(b.x + b.width / 2, b.y + b.height / 2)
}

/** The audio in frame `f` plays: its own clock moves (over 1.2 s, by more than 0.6 s). */
export async function audioMoves(f: Frame, what: string): Promise<void> {
  const t = () => f.evaluate(() => { const a = (globalThis as any).document.querySelector('.pod audio'); return a && a.getAttribute('src') ? a.currentTime : -1 })
  const t0 = await t()
  await sleep(1200)
  const t1 = await t()
  assert.ok(t0 >= 0 && t1 > t0 + 0.6, `${what}: the audio's clock moves (${t0} → ${t1})`)
}

/** The extension's own pages and files, by URL: its webviews (vscode-webview://), its media (journey-*, podcast*). */
const OURS = /vscode-webview|code-notes|journey-|podcast/i

/**
 * Collects the workbench's console errors and uncaught errors (the webviews' frames included) from now until
 * `dispose()`; `errors()` returns those that come from the extension (OURS).
 */
export function watchConsole(): { errors(): string[]; dispose(): void } {
  const log: string[] = []
  const onConsole = (m: import('playwright').ConsoleMessage) => { if (m.type() === 'error') log.push(`${m.location().url}: ${m.text()}`) }
  const onError = (e: Error) => log.push(`uncaught: ${e.message}`)
  const page = ui().then((p) => { p.on('console', onConsole); p.on('pageerror', onError); return p })
  return {
    errors: () => log.filter((e) => OURS.test(e)),
    dispose: () => { void page.then((p) => { p.off('console', onConsole); p.off('pageerror', onError) }) },
  }
}

/**
 * The workbench's code editor showing the text `tag`: how far it is scrolled right (px), its text area's left and
 * right edge, and where the first character of `marker` is drawn (-1: not drawn). Reads VS Code's own editor DOM (as
 * of 1.100: .monaco-editor, .view-lines, .overflow-guard, .minimap, .lines-content's style.left), which is no API:
 * a VS Code update may move it. 14 px: the vertical scrollbar's width.
 */
export async function editorBox(tag: string, marker: string): Promise<{ scrollLeft: number; left: number; right: number; markLeft: number }> {
  return (await ui()).evaluate(([tg, mk]) => {
    const d = (globalThis as any).document
    for (const ed of d.querySelectorAll('.monaco-editor')) {
      const lines = ed.querySelector('.view-lines')
      if (!lines || !lines.textContent.includes(tg)) continue
      const box = ed.querySelector('.overflow-guard').getBoundingClientRect()
      const mini = ed.querySelector('.minimap')
      const right = box.right - (mini ? mini.getBoundingClientRect().width : 0) - 14
      let markLeft = -1
      const w = d.createTreeWalker(lines, 4)
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const k = n.textContent.indexOf(mk)
        if (k < 0) continue
        const r = d.createRange()
        r.setStart(n, k)
        r.setEnd(n, k + 1)
        markLeft = r.getBoundingClientRect().left
      }
      return { scrollLeft: -parseFloat(ed.querySelector('.lines-content').style.left || '0'), left: box.left, right, markLeft }
    }
    return { scrollLeft: -1, left: 0, right: 0, markLeft: -1 }
  }, [tag, marker] as const)
}

/** How far the code editor showing `tag` is scrolled right (px; -1: no such editor). */
export const scrollLeft = async (tag: string) => (await editorBox(tag, tag)).scrollLeft
