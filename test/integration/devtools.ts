// The workbench page over the DevTools protocol (run.ts opens the port): real clicks, real keys, the webviews'
// frames, measurements of the page, whole-window pictures. Every probe of VS Code's own DOM is in the section
// "workbench DOM" below.
import * as path from 'path'
import { SCALE, settle, waiter } from './helpers'
import { connectCdp } from './connectCdp'
import { testEnv } from './support/testEnv'

/* eslint-disable @typescript-eslint/no-explicit-any */
/** How long the workbench page may take to load a webview's frames (× SCALE): a cold webview takes several seconds. */
const PAGE_LOAD_MS = 10000
/** Waits for the workbench page. */
const untilPage = waiter({ ms: PAGE_LOAD_MS })

/** Whether run.ts opened a DevTools port (CODE_NOTES_CDP): without it the tests that need real input are skipped. */
export const cdp = !!testEnv.cdpPort

let pagePromise: Promise<import('playwright').Page> | undefined
/** The workbench page (not a DevTools page), connected once. */
export function ui(): Promise<import('playwright').Page> {
  return pagePromise ??= (async () => {
    const browser = await connectCdp(testEnv.cdpPort!)
    return browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith('devtools'))!
  })()
}

/**
 * The frame of the webview whose page has an element matching `marker` (a webview's page is an iframe in an iframe).
 * On a timeout the error says what the frames looked like (how many, how many detached while looked at, how many
 * without the marker), so a frame that is not the one says why.
 */
export async function webviewFrame(marker: string, what = `the webview with ${marker}`): Promise<import('playwright').Frame> {
  const page = await ui()
  let seen = ''
  try {
    return await untilPage(what, async () => {
      let frames = 0, detached = 0, without = 0
      for (const f of page.frames()) {
        frames++
        let has = false
        try { has = await f.evaluate((m) => !!(globalThis as any).document.querySelector(m), marker) } catch { detached++; continue }
        if (has) return f
        without++
      }
      seen = `${frames} frames: ${without} without ${marker}${detached ? `, ${detached} detached while looked at` : ''}`
      return undefined
    })
  } catch (e) {
    throw new Error(`${(e as Error).message} (${seen})`, { cause: e })
  }
}

/** The Check view's frame: the one whose page runs the Check view's bundle (out/pages/check.js). */
export function checkFrame(): Promise<import('playwright').Frame> {
  return webviewFrame('script[src*="/pages/check.js"]', 'the Check view frame')
}

/** Which answer box in the Check view has the keyboard: its question id, '' for none. */
export async function boxFocused(): Promise<string> {
  return (await checkFrame()).evaluate(() => { const d = (globalThis as any).document; const a = d.activeElement; return d.hasFocus() && a?.classList?.contains('box') ? a.closest('.answer').dataset.id : '' })
}

/** How long a picture waits for the page to paint (a view redraws a moment after its model changes). */
const SHOT_PAINT_MS = 400
/** How long a notification may take to show (× SCALE). */
const TOAST_MS = 10000

/** A whole-window picture over DevTools, into CODE_NOTES_SHOTS (the page gets a moment to paint first). */
export async function pageShot(name: string): Promise<void> {
  const d = testEnv.shots
  if (!d || !cdp) return
  await settle(SHOT_PAINT_MS, 'the page painting before the picture')
  await (await ui()).screenshot({ path: path.join(d, `${name}.png`) })
}

// ---------- workbench DOM ----------
// VS Code's own DOM is not an API: its class names (.notification-toast, .monaco-button, .editor-group-container,
// .monaco-editor, .editor-scrollable, .scrollbar.vertical, .minimap, .zone-widget, .view-line) were read off VS Code
// 1.147. Every probe of it lives here, so a VS Code update that renames one is fixed in one place. A probe that finds
// none of what it looks for says so in the log.

/** The element that has the keyboard in the workbench page, as `TAG.class` (for a log line when focus is lost). */
export async function focusedElement(): Promise<string> {
  return (await ui()).evaluate(() => { const a = (globalThis as any).document.activeElement; return `${a?.tagName}.${a?.className}`.slice(0, 120) })
}

/**
 * The visible columns of each code editor in the workbench: its text area (after the gutter, before the minimap and
 * the scrollbar) in characters of its first line with some text. Editors inside peeks and other editors are skipped.
 */
export async function codeColumns(page: import('playwright').Page): Promise<number[]> {
  const cols = await page.evaluate(() => {
    const d = (globalThis as any).document
    const out: number[] = []
    for (const e of d.querySelectorAll('.editor-group-container .monaco-editor')) {
      if (e.closest('.zone-widget') || e.parentElement.closest('.monaco-editor')) continue
      const r = e.getBoundingClientRect()
      if (r.width < 50 || r.height < 50) continue
      const scrollable = e.querySelector('.editor-scrollable')
      if (!scrollable) continue
      let right = r.right
      const minimap = e.querySelector('.minimap')
      const scrollbar = scrollable.querySelector(':scope > .scrollbar.vertical')
      for (const x of [minimap, scrollbar]) {
        const b = x && x.getBoundingClientRect()
        if (b && b.width > 0) right = Math.min(right, b.left)
      }
      const line = [...e.querySelectorAll('.view-line')].find((l: any) => !l.closest('.zone-widget') && (l.textContent || '').trim().length > 10)
      if (!line) continue
      const span = line.firstElementChild
      const charWidth = span.getBoundingClientRect().width / span.textContent.length
      out.push(Math.floor((right - scrollable.getBoundingClientRect().left) / charWidth))
    }
    return out
  })
  if (!cols.length && (await page.locator('.editor-group-container .monaco-editor').count())) {
    console.log('    (codeColumns: editors on screen but none measured: has VS Code renamed a class this reads?)')
  }
  return cols
}

/** Clicks a notification's button (the real toast in the workbench). */
export async function clickToast(text: RegExp, button: string): Promise<void> {
  const page = await ui()
  const toast = page.locator('.notification-toast', { hasText: text }).first()
  await toast.waitFor({ timeout: TOAST_MS * SCALE })
  await toast.locator('.monaco-button', { hasText: button }).first().click()
}
