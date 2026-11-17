// The workbench page over the DevTools protocol (run.ts opens the port for the understanding check): real clicks,
// real keys, the Check view's frame, whole-window pictures.
import * as path from 'path'
import { sleep, SCALE, waiter } from './helpers'

const until = waiter({ ms: 10000 })

/** Whether run.ts opened a DevTools port (CODE_NOTES_CDP): without it the tests that need real input are skipped. */
export const cdp = !!process.env.CODE_NOTES_CDP

let pagePromise: Promise<import('playwright').Page> | undefined
/** The workbench page (not a DevTools page), connected once. */
export function ui(): Promise<import('playwright').Page> {
  return pagePromise ??= (async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { chromium } = require('playwright') as typeof import('playwright')
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.CODE_NOTES_CDP}`)
    return browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith('devtools'))!
  })()
}

/** The Check view's frame (a webview: an iframe in an iframe). */
export async function checkFrame(): Promise<import('playwright').Frame> {
  const page = await ui()
  return until('the Check view frame', async () => {
    for (const f of page.frames()) { try { if (await f.evaluate(() => !!(globalThis as any).checkAnswer)) return f } catch { /* detached */ } }
    return undefined
  })
}

/** Which answer box in the Check view has the keyboard: its question id, '' for none. */
export async function boxFocused(): Promise<string> {
  return (await checkFrame()).evaluate(() => { const d = (globalThis as any).document; const a = d.activeElement; return d.hasFocus() && a?.classList?.contains('box') ? a.closest('.answer').dataset.id : '' })
}

/** The element that has the keyboard in the workbench page, as `TAG.class` (for a log line when focus is lost). */
export async function focusedElement(): Promise<string> {
  return (await ui()).evaluate(() => { const a = (globalThis as any).document.activeElement; return `${a?.tagName}.${a?.className}`.slice(0, 120) })
}

/** A whole-window picture over DevTools, into CODE_NOTES_SHOTS (the page gets 0.4 s to paint first). */
export async function pageShot(name: string): Promise<void> {
  const d = process.env.CODE_NOTES_SHOTS
  if (!d || !cdp) return
  await sleep(400)
  await (await ui()).screenshot({ path: path.join(d, `${name}.png`) })
}

/** Clicks a notification's button (the real toast in the workbench). */
export async function clickToast(text: RegExp, button: string): Promise<void> {
  const page = await ui()
  const toast = page.locator('.notification-toast', { hasText: text }).first()
  await toast.waitFor({ timeout: 10000 * SCALE })
  await toast.locator('.monaco-button', { hasText: button }).first().click()
}
