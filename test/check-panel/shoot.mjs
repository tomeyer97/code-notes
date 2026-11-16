// The understanding check's panel in Chromium (Playwright) at three widths, dark and light: nothing wider than the
// panel, no console errors, rows and the Stage button click through. Screenshots go to the folder given (optional).
// Usage: node test/check-panel/shoot.mjs [screenshot-dir]   (PLAYWRIGHT=<path to playwright's index.mjs> if needed)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pw = await import(process.env.PLAYWRIGHT ? pathToFileURL(path.resolve(process.env.PLAYWRIGHT)).href : 'playwright')
const chromium = pw.chromium ?? pw.default.chromium
const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : ''
if (OUT) fs.mkdirSync(OUT, { recursive: true })
const long = 'What happens to an already-charged order\'s result when the API answers the report with a 4xx other than 409, such as 401 for a wrong WORKER_KEY, while replayUnreportedResultsFromTheLocalFile is still running?'
const views = {
  answering: { branch: 'feat/retry-charges', file: 'understanding/feat-retry-charges.json', progress: '1 of 3 passed · 2 needed', met: false, rows: [
    { id: 'q1', n: 1, kind: 'Failure', text: 'What happens to the saved results if replayUnreported throws or the worker dies halfway through the loop?', where: 'worker/worker.js:42', state: 'pass', word: '✓' },
    { id: 'q2', n: 2, kind: 'Why', text: 'Why is it safe for chargeOrder to retry after a timeout when the first attempt may already have charged the card?', where: 'worker/charge.js:19', state: 'retry', word: 'try again' },
    { id: 'q3', n: 3, kind: 'Edge case', text: long, where: 'payments/a-very-long-folder-name/with-more-levels/client-with-a-long-name.js:32', state: 'todo', word: 'to answer' }] },
  passed: { branch: 'feat/a-branch-with-a-rather-long-name-for-testing', file: 'understanding/feat-a-branch-with-a-rather-long-name-for-testing.json', progress: 'Passed · 3 of 4', met: true,
    rows: ['pass', 'pass', 'explained', 'pass'].map((s, i) => ({ id: `q${i + 1}`, n: i + 1, kind: 'How', text: `Question ${i + 1}: how does the worker stop a second charge for the same job?`, where: 'api/orders.js:12', state: s, word: s === 'explained' ? 'explained' : '✓' })),
    next: { text: 'Commit understanding/feat-a-branch-with-a-rather-long-name-for-testing.json and push.', action: 'stage', button: 'Stage it' } },
  writing: { branch: 'feat/x', file: 'understanding/feat-x.json', progress: '', met: false, rows: [], busy: 'Writing questions · 0:42 · reading the change' },
}
const fails = []
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {})
for (const theme of ['dark', 'light']) for (const w of [280, 480, 900]) for (const [name, view] of Object.entries(views)) {
  const page = await browser.newPage({ viewport: { width: w, height: 520 } })
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`${pathToFileURL(path.join(HERE, 'harness.html')).href}?theme=${theme}`)
  await page.evaluate((v) => window.postMessage({ type: 'check', view: v }, '*'), view)
  await page.waitForFunction(() => window.__posted.some((m) => m.type === 'rendered'))
  const r = await page.evaluate(() => window.__posted.filter((m) => m.type === 'rendered').pop())
  const tag = `${name} ${w}px ${theme}`
  if (r.overflow.length) fails.push(`${tag}: ${r.overflow.join('; ')}`)
  if (errors.length) fails.push(`${tag}: console: ${errors.join('; ')}`)
  // Every row is clickable and says which question; Stage posts once.
  if (view.rows.length) {
    await page.click('button.open[data-id="q2"]')
    if (!(await page.evaluate(() => window.__posted.some((m) => m.type === 'open' && m.id === 'q2')))) fails.push(`${tag}: a row click didn't open its question`)
  }
  if (view.next?.action) {
    await page.click('footer button.primary')
    if (!(await page.evaluate(() => window.__posted.some((m) => m.type === 'stage')))) fails.push(`${tag}: Stage it didn't post`)
  }
  // A clamped question keeps its whole text in the tooltip of its row? No: the code thread shows it. Check the clamp is not more than 3 lines.
  const tall = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll('.text')].map((e) => e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight || '18'))))
  if (tall > 3.2) fails.push(`${tag}: a question takes ${tall.toFixed(1)} lines (at most 3)`)
  if (OUT) await page.screenshot({ path: path.join(OUT, `check-${name}-${w}-${theme}.png`), fullPage: true })
  await page.close()
}
await browser.close()
for (const f of fails) console.log(`✗ ${f}`)
console.log(fails.length ? `${fails.length} problems` : 'check panel: all widths and themes fine')
process.exit(fails.length ? 1 : 0)
