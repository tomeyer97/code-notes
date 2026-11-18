// The DevTools connection to VS Code's workbench (Playwright over the Chrome DevTools Protocol). No VS Code API here:
// run.ts (plain node, watching the workbench console) and devtools.ts (inside VS Code, clicking and typing) both use it.
import type { Browser } from 'playwright'

/**
 * The workbench at DevTools port `port`, connected with Playwright: up to `tries` attempts 0.2 s apart (VS Code may
 * still be starting), fewer once `stopped()` says so. Throws the last attempt's error when none connects.
 */
export async function connectCdp(port: number | string, tries = 1, stopped = () => false): Promise<Browser> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { chromium } = require('playwright') as typeof import('playwright')
  for (let attempt = 1; ; attempt++) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    } catch (e) {
      if (attempt >= tries || stopped()) throw e
      await new Promise((r) => setTimeout(r, 200))
    }
  }
}
