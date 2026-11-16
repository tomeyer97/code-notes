// The Check view (the understanding check's list in the sidebar) in Chromium (Playwright) at three widths, dark and light: nothing wider than the
// panel, no console errors, rows, ↓ and the button work. Screenshots go to the folder given (optional).
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
const row = (id, n, kind, text, where, state, word, extra = {}) => ({ id, n, kind, text, where, also: [], state, word, ...extra })
const views = {
  answering: { branch: 'feat/retry-charges', file: 'understanding/feat-retry-charges.json', tone: 'todo', title: '1 of 3 done', line: 'Answer all 3 · 2 must pass.', notice: 'Not asked about (uncommitted): README.md, allowlist.js', setup: 'Collapse check files in diffs:', rows: [
    row('q1', 1, 'Failure', 'What happens to the saved results if replayUnreported throws or the worker dies halfway through the loop?', 'worker/worker.js:42', 'pass', ''),
    row('q2', 2, 'Why', 'Why is it safe for chargeOrder to retry after a timeout when the first attempt may already have charged the card?', 'worker/charge.js:19', 'retry', 'try again', { also: ['worker/queue.js:84-96'] }),
    row('q3', 3, 'Edge case', long, 'payments/a-very-long-folder-name/with-more-levels/client-with-a-long-name.js:32', 'todo', '', { flag: 'may be a bug' })] },
  done: { branch: 'feat/a-branch-with-a-rather-long-name-for-testing', file: 'understanding/feat-a-branch-with-a-rather-long-name-for-testing.json', tone: 'ok', title: '✓ Done', line: 'Commit and push.',
    rows: ['pass', 'restated', 'explained', 'pass'].map((s, i) => row(`q${i + 1}`, i + 1, 'How', `Question ${i + 1}: how does the worker stop a second charge for the same job?`, 'api/orders.js:12', s, s === 'explained' ? 'explained · say it back' : s === 'restated' ? 'in your words' : '', i === 2 ? { flag: 'flagged for review' } : {})),
    action: { id: 'commitPush', label: 'Commit & push' }, who: "Ada's check: your answers are recorded as yours.",
    commits: 'Commits feat-a-branch-with-a-rather-long-name-for-testing.json, .gitattributes, .ignore', also: [{ file: 'services/api/src/refunds.js', label: 'also refunds.js (TODO added)', on: false }] },
  // The answer box under the selected question: a miss with a hint and a code link, a draft in the box.
  answer: { branch: 'feat/x', file: 'understanding/feat-x.json', tone: 'todo', title: '1 of 3 done', line: 'Answer all 3 · 2 must pass.', rows: [
    row('q1', 1, 'Failure', 'What happens to the saved results if replayUnreported throws?', 'worker/worker.js:42', 'pass', ''),
    row('q2', 2, 'Why', 'Why is it safe for chargeOrder to retry after a timeout when the first attempt may already have charged the card?', 'worker/charge.js:19', 'retry', 'try again'),
    row('q3', 3, 'Edge case', 'What does `takeJob` return when two workers take the same job?', 'worker/queue.js:7', 'todo', '')],
    answer: { id: 'q2', n: 2, open: true, draft: 'It checks the idempotency key first, so', grade: { pass: false, feedback: [{ text: 'Not quite: right about the key; re-check when it is written.' }], hint: [{ text: 'What does ' }, { text: 'the INSERT after the charge', link: 0 }, { text: ' do on a retry?' }] } } },
  // A pass: the box is gone, the grade and "Next question ›".
  passed: { branch: 'feat/x', file: 'understanding/feat-x.json', tone: 'todo', title: '2 of 3 done', line: 'Answer all 3 · 2 must pass.', rows: [
    row('q1', 1, 'Failure', 'What happens to the saved results if replayUnreported throws?', 'worker/worker.js:42', 'pass', ''),
    row('q2', 2, 'Why', 'Why is the charge retried?', 'worker/charge.js:19', 'pass', ''), row('q3', 3, 'Edge case', 'What happens when two workers take the same job?', 'worker/queue.js:7', 'todo', '')],
    answer: { id: 'q2', n: 2, open: false, draft: '', grade: { pass: true, feedback: [{ text: 'Right: ' }, { text: 'the unique key', link: 0 }, { text: ' turns the second charge into an error, not a double charge.' }] }, next: true,
      concern: { text: 'The retry after a timeout charges again when the first attempt went through: no idempotency key is sent.', flagged: false } } },
  drift: { branch: 'feat/x', file: 'understanding/feat-x.json', tone: 'warn', title: 'Needs top-up: +46 lines', line: 'Add 1–2 questions about the new lines.', rows: [row('q1', 1, 'How', 'How does it work?', 'a.js:1', 'pass', ''), row('q2', 2, 'Why', 'Why so?', 'a.js:9', 'pass', '')], action: { id: 'topUp', label: 'Add questions' } },
  none: { branch: 'feat/x', file: 'understanding/feat-x.json', tone: 'todo', title: 'No check yet for feat/a-branch-with-a-rather-long-name-for-testing', line: '28 code lines changed.', rows: [], action: { id: 'start', label: 'Start' } },
  // The tour of the change: the rows say their step; one link walks it (or one muted line while it is written).
  tour: { branch: 'feat/refunds', file: 'understanding/feat-refunds.json', tone: 'todo', title: '1 of 3 done', line: 'Answer all 3 · 2 must pass.', tour: { label: 'Walk the tour · 9 steps', action: 'walk' }, rows: [
    row('q1', 1, 'Failure', 'What happens to an order in refund_pending if the API restarts before the worker takes its refund job?', 'api/orders.js:44', 'todo', '', { step: 4 }),
    row('q2', 2, 'Edge case', 'After a failed refund, what happens when the customer asks again for a different amount, given the idempotency key?', 'worker/refund.js:7', 'retry', 'try again', { step: 9, flag: 'may be a bug' }),
    row('q3', 3, 'Why', 'Why does startRefund check the status inside its UPDATE instead of relying on the status read in refundOrder?', 'api/store.js:44', 'pass', '', { step: 2 })] },
  tourWriting: { branch: 'feat/refunds', file: 'understanding/feat-refunds.json', tone: 'todo', title: '0 of 3 done', line: 'Answer all 3 · 2 must pass.', tour: { label: 'Writing the tour · 1:20' }, rows: [
    row('q1', 1, 'Failure', 'What happens to an order in refund_pending if the API restarts?', 'api/orders.js:44', 'todo', ''), row('q2', 2, 'Why', 'Why is the status checked in the UPDATE?', 'api/store.js:44', 'todo', '')] },
  writing: { branch: 'feat/x', file: 'understanding/feat-x.json', tone: 'todo', title: 'No check yet for feat/x', line: '28 code lines changed.', rows: [], busy: 'Writing questions · 0:42 · reading the change' },
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
  // Every row is clickable and says which question; the button posts its action; ↓ moves between rows.
  if (view.rows.length > 1) {
    await page.focus('button.open[data-id="q1"]'); await page.keyboard.press('ArrowDown')
    if (!(await page.evaluate(() => document.activeElement?.dataset?.id === 'q2'))) fails.push(`${tag}: ↓ didn't move to the next question`)
  }
  if (view.rows.length) {
    await page.click('button.open[data-id="q2"]')
    if (!(await page.evaluate(() => window.__posted.some((m) => m.type === 'open' && m.id === 'q2')))) fails.push(`${tag}: a row click didn't open its question`)
  }
  if (view.answer?.open) {
    // The box: the draft in it; Ctrl+Enter sends; Esc goes back; a code link in the grade posts it and keeps the box focused.
    const box = page.locator('.answer textarea')
    if ((await box.inputValue()) !== view.answer.draft) fails.push(`${tag}: the draft is not in the box`)
    if ((await box.getAttribute('placeholder')) !== 'Answer in 1–3 sentences') fails.push(`${tag}: placeholder`)
    await box.focus(); await page.keyboard.type(' it never charges twice.'); await page.keyboard.press('Control+Enter')
    if (!(await page.evaluate(() => window.__posted.some((m) => m.type === 'answer' && m.id === 'q2' && /so it never charges twice\.$/.test(m.text))))) fails.push(`${tag}: Ctrl+Enter didn't send the answer`)
    await page.click('.answer .codelink')
    if (!(await page.evaluate(() => window.__posted.some((m) => m.type === 'link' && m.id === 'q2' && m.i === 0) && document.activeElement?.tagName === 'TEXTAREA'))) fails.push(`${tag}: the code link didn't post, or the box lost the keyboard`)
    await page.keyboard.press('Escape')
    if (!(await page.evaluate(() => window.__posted.some((m) => m.type === 'escape')))) fails.push(`${tag}: Esc didn't go back to the code`)
    // Drawn again (a new grade arrives): the keyboard stays in the box.
    await box.focus()
    await page.evaluate((v) => window.postMessage({ type: 'check', view: v }, '*'), view)
    await page.waitForTimeout(50)
    if (!(await page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA'))) fails.push(`${tag}: a redraw took the keyboard out of the box`)
  }
  if (view.answer?.concern) {
    await page.click('.answer .concern .link:last-child')
    if (!(await page.evaluate(() => window.__posted.some((m) => m.type === 'concern' && m.action === 'dismiss')))) fails.push(`${tag}: a concern action didn't post`)
  }
  if (view.answer?.next) {
    if (await page.locator('.answer textarea').count()) fails.push(`${tag}: a passed question still has its box`)
    await page.click('.answer .next')
    if (!(await page.evaluate(() => window.__posted.some((m) => m.type === 'next')))) fails.push(`${tag}: Next question didn't post`)
  }
  if (view.also) {
    await page.click('footer .also input')
    if (!(await page.evaluate(() => window.__posted.some((m) => m.type === 'include' && m.file === 'services/api/src/refunds.js' && m.on === true)))) fails.push(`${tag}: ticking the TODO file didn't post`)
  }
  if (view.tour?.action) {
    await page.click('button.tour')
    if (!(await page.evaluate(() => window.__posted.some((m) => m.type === 'tour')))) fails.push(`${tag}: the tour link didn't post`)
    const meta = await page.evaluate(() => document.querySelector('button.open[data-id="q1"] .meta')?.textContent)
    if (!/^Failure · step 4 · orders\.js/.test(meta ?? '')) fails.push(`${tag}: q1's row says "${meta}" (want its step)`)
  }
  if (view.tour && !view.tour.action && !(await page.evaluate(() => !document.querySelector('button.tour') && /Writing the tour/.test(document.querySelector('.tour')?.textContent ?? '')))) fails.push(`${tag}: the tour being written is not one muted line`)
  if (view.action) {
    await page.click('footer button.primary')
    if (!(await page.evaluate((id) => window.__posted.some((m) => m.type === id), view.action.id))) fails.push(`${tag}: ${view.action.label} didn't post`)
  }
  // A clamped question keeps its whole text in the tooltip of its row? No: the code thread shows it. Check the clamp is not more than 3 lines.
  const tall = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll('.text')].map((e) => e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight || '18'))))
  if (tall > 3.2) fails.push(`${tag}: a question takes ${tall.toFixed(1)} lines (at most 3)`)
  if (OUT) await page.screenshot({ path: path.join(OUT, `check-${name}-${w}-${theme}.png`), fullPage: true })
  await page.close()
}
await browser.close()
for (const f of fails) console.log(`✗ ${f}`)
console.log(fails.length ? `${fails.length} problems` : 'Check view: all widths and themes fine')
process.exit(fails.length ? 1 : 0)
