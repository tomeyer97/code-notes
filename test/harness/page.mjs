// Starting Chromium and opening a harness page (a webview's page outside VS Code) the same way in every harness
// script, so that what differs between them (which console messages fail a run, the size, the waits) is an option.
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** Chromium from Playwright: PLAYWRIGHT=<playwright's index.mjs> when it is not in node_modules; CHROME=<a binary> to run instead of Playwright's own. */
export async function launchChromium() {
  const pw = await import(process.env.PLAYWRIGHT ? pathToFileURL(path.resolve(process.env.PLAYWRIGHT)).href : 'playwright')
  const chromium = pw.chromium ?? pw.default.chromium
  return chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--mute-audio'] })
}

/**
 * A new page of `browser`, `width` × `height`, on `url`?theme=`theme`. `errors` collects what the page reports while
 * it runs: console errors (with `warnings`, warnings too), page errors and (with `failedRequests`) requests that
 * failed. `context`: more options for its browser context (reducedMotion, deviceScaleFactor); `timeout`: the page's
 * default timeout, set before it loads; `initScripts`: files run in the page before its own scripts; with `ready`,
 * waits until the page has posted "ready".
 */
export async function openHarness(browser, url, { width, height, theme, warnings = false, failedRequests = false, context = {}, timeout, initScripts = [], ready = false }) {
  const ctx = await browser.newContext({ viewport: { width, height }, ...context })
  const page = await ctx.newPage()
  // The page owns its context (as browser.newPage's does): closing it closes both.
  page.on('close', () => { ctx.close().catch(() => { /* the browser closed first: already gone */ }) })
  if (timeout) page.setDefaultTimeout(timeout)
  for (const f of initScripts) await page.addInitScript({ path: f })
  const errors = []
  page.on('console', (m) => {
    if (m.type() === 'error' || (warnings && m.type() === 'warning')) errors.push(`${m.type()}: ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  if (failedRequests) page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()}`))
  await page.goto(`${url}?theme=${theme}`)
  if (ready) await page.waitForFunction(() => window.__harness.posted.some((m) => m.type === 'ready'))
  return { page, errors }
}
