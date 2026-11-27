// The Check view (the understanding check's list in the sidebar) in Chromium (Playwright) at three widths, dark and
// light, for every state in views.mjs (made by the extension's view model: `npm run build` first): nothing wider than
// the panel, no console errors, rows, ↓, the answer box, the links and the button work. Screenshots go to the folder
// given (optional).
// Usage: node test/check-panel/shoot.mjs [screenshot-dir]   (PLAYWRIGHT=<path to playwright's index.mjs> if needed)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { launchChromium, openHarness } from '../harness/page.mjs'
import { views } from './views.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HARNESS = pathToFileURL(path.join(HERE, 'harness.html')).href
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : ''
if (OUT) fs.mkdirSync(OUT, { recursive: true })

/** Has the page posted a message of `type` whose fields include `fields`? */
function postedType(page, type, fields = {}) {
  return page.evaluate(([t, f]) => {
    const has = (m) => Object.entries(f).every(([k, v]) => m[k] === v)
    return window.__harness.posted.some((m) => m.type === t && has(m))
  }, [type, fields])
}
/** Forgets what the page posted so far: each check sees only what its own actions posted. */
const forgetPosted = (page) => page.evaluate(() => { window.__harness.posted.length = 0 })
/** Draws `view` (as the extension posts it). */
const draw = (page, view) => page.evaluate((v) => window.postMessage({ type: 'check', view: v }, '*'), view)

// ---------- the checks: each looks at one part of the view, when the view has it; `fail` records a problem ----------

/** ↓ moves from a row to the next. */
async function arrowDown(page, view, fail) {
  if (view.rows.length <= 1) return
  await page.focus('button.open[data-id="q1"]')
  await page.keyboard.press('ArrowDown')
  if (!(await page.evaluate(() => document.activeElement?.dataset?.id === 'q2'))) fail('↓ didn\'t move to the next question')
}

/** Every row is clickable and opens its question. */
async function rowClick(page, view, fail) {
  if (!view.rows.length) return
  await page.click('button.open[data-id="q2"]')
  if (!(await postedType(page, 'open', { id: 'q2' }))) fail('a row click didn\'t open its question')
}

/** The answer box: the draft in it; Ctrl+Enter sends; a code link in the grade posts it and keeps the box focused; Esc goes back; a redraw keeps the keyboard there. */
async function answerBox(page, view, fail) {
  if (!view.answer?.open) return
  const box = page.locator('.answer textarea')
  if ((await box.inputValue()) !== view.answer.draft) fail('the draft is not in the box')
  if ((await box.getAttribute('placeholder')) !== 'Answer in 1–3 sentences') fail('placeholder')
  await box.focus()
  await page.keyboard.type(' it never charges twice.')
  await page.keyboard.press('Control+Enter')
  const sent = await page.evaluate((id) => window.__harness.posted.some((m) => m.type === 'answer' && m.id === id && /it never charges twice\.$/.test(m.text)), view.answer.id)
  if (!sent) fail('Ctrl+Enter didn\'t send the answer')
  if (view.answer.grade) {
    await page.click('.answer .codelink')
    const stays = await page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA')
    if (!(await postedType(page, 'link', { id: 'q2', i: 0 })) || !stays) fail('the code link didn\'t post, or the box lost the keyboard')
  }
  await page.keyboard.press('Escape')
  if (!(await postedType(page, 'escape'))) fail('Esc didn\'t go back to the code')
  // Drawn again (a new grade arrives): the keyboard stays in the box.
  await box.focus()
  await draw(page, view)
  await page.waitForTimeout(50)
  if (!(await page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA'))) fail('a redraw took the keyboard out of the box')
}

/** A concern under a passed question: its action posts. */
async function concernAction(page, view, fail) {
  if (!view.answer?.concern) return
  await page.click('.answer .concern .link:last-child')
  if (!(await postedType(page, 'concern', { action: 'dismiss' }))) fail('a concern action didn\'t post')
}

/** A passed question: no box; "Next question ›" posts. */
async function nextQuestion(page, view, fail) {
  if (!view.answer?.next) return
  if (await page.locator('.answer textarea').count()) fail('a passed question still has its box')
  await page.click('.answer .next')
  if (!(await postedType(page, 'next'))) fail('Next question didn\'t post')
}

/** A file offered with Commit & push: ticking it posts. */
async function alsoTick(page, view, fail) {
  if (!view.also) return
  const { file, on } = view.also[0]
  await page.click('footer .also input')
  if (!(await postedType(page, 'include', { file, on: !on }))) fail(`ticking ${file} didn't post`)
}

/** The tour: its link posts and the rows say their step; while it is written, one muted line. */
async function tourLink(page, view, fail) {
  if (!view.tour) return
  if (view.tour.action) {
    await page.click('button.tour')
    if (!(await postedType(page, 'tour'))) fail('the tour link didn\'t post')
    const meta = await page.evaluate(() => document.querySelector('button.open[data-id="q1"] .meta')?.textContent)
    if (!/^Failure · step 4 · orders\.js/.test(meta ?? '')) fail(`q1's row says "${meta}" (want its step)`)
    return
  }
  const muted = await page.evaluate(() => !document.querySelector('button.tour') && /Writing the tour/.test(document.querySelector('.tour')?.textContent ?? ''))
  if (!muted) fail('the tour being written is not one muted line')
}

/** A merge request link: it posts. */
async function mergeRequest(page, view, fail) {
  if (!view.mr) return
  await page.click('.mr button.link')
  if (!(await postedType(page, 'openMr'))) fail('Open merge request didn\'t post')
}

/** Claude Code not found: each way on posts. */
async function notFoundLinks(page, view, fail) {
  if (!view.failed?.path) return
  for (const [label, type] of [['Install ↗', 'install'], ['Set its path', 'pathSetting'], ['Retry', 'retry']]) {
    await page.click(`.failed button.link:text-is("${label}")`)
    if (!(await postedType(page, type))) fail(`${label} didn't post`)
  }
}

/** Grading failed: Try again posts. */
async function gradeRetry(page, view, fail) {
  if (!view.answer?.error) return
  await page.click('.answer .failed button.link')
  if (!(await postedType(page, 'regrade', { id: 'q1' }))) fail('Try again didn\'t post')
}

/** The one button sits right under where the check stands, above the questions (never out of sight below them), and posts its action. */
async function mainButton(page, view, fail) {
  if (!view.action) return
  const above = () => page.evaluate(() => document.querySelector('footer').getBoundingClientRect().bottom <= document.querySelector('.rows').getBoundingClientRect().top + 1)
  if (view.rows.length && !(await above())) fail('the button is not above the questions')
  await page.click('footer button.primary')
  if (!(await postedType(page, view.action.id))) fail(`${view.action.label} didn't post`)
}

/** A question's text is clamped at 3 lines (its thread in the code shows it whole). */
async function clampedQuestions(page, view, fail) {
  const tall = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll('.text')].map((e) => e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight || '18'))))
  if (tall > 3.2) fail(`a question takes ${tall.toFixed(1)} lines (at most 3)`)
}

/** A redraw keeps the keyboard on the focused row, even when its question id has a quote or a backslash in it (ids come
 *  from the check file). Runs once per page, on views with rows; it draws the view again afterwards. */
async function oddIdRedraw(page, view, fail) {
  if (!view.rows.length) return
  const id = 'q"\\1]'
  const odd = { ...view, answer: undefined, rows: view.rows.map((r, i) => (i ? r : { ...r, id })) }
  await draw(page, odd)
  await page.waitForTimeout(50)
  await page.evaluate((v) => [...document.querySelectorAll('button.open')].find((b) => b.dataset.id === v)?.focus(), id)
  const errors = []
  const onError = (e) => errors.push(e.message)
  page.on('pageerror', onError)
  await draw(page, odd)
  await page.waitForTimeout(50)
  page.off('pageerror', onError)
  const kept = await page.evaluate((v) => document.activeElement?.dataset?.id === v, id)
  if (errors.length || !kept) fail(`a redraw lost the keyboard on a row whose id has a quote${errors.length ? ` (${errors.join('; ')})` : ''}`)
  await draw(page, view)
  await page.waitForTimeout(50)
}

/** In the order they run on each drawn view; what the page posted is forgotten before each, so a check passes only on
 *  what its own actions posted. */
const CHECKS = [arrowDown, rowClick, answerBox, concernAction, nextQuestion, alsoTick, tourLink, mergeRequest, notFoundLinks, gradeRetry, mainButton, clampedQuestions, oddIdRedraw]

// ---------- main ----------

const fails = []
const browser = await launchChromium()
for (const theme of ['dark', 'light']) for (const w of [280, 480, 900]) for (const [name, view] of Object.entries(views)) {
  const tag = `${name} ${w}px ${theme}`
  const fail = (what) => fails.push(`${tag}: ${what}`)
  const { page, errors } = await openHarness(browser, HARNESS, { width: w, height: 520, theme })
  await draw(page, view)
  await page.waitForFunction(() => window.__harness.posted.some((m) => m.type === 'rendered'))
  const r = await page.evaluate(() => window.__harness.posted.filter((m) => m.type === 'rendered').pop())
  if (r.overflow.length) fail(r.overflow.join('; '))
  if (errors.length) fail(`console: ${errors.join('; ')}`)
  for (const check of CHECKS) {
    await forgetPosted(page)
    await check(page, view, fail)
  }
  if (OUT) await page.screenshot({ path: path.join(OUT, `check-${name}-${w}-${theme}.png`), fullPage: true })
  await page.close()
}
await browser.close()
for (const f of fails) console.log(`✗ ${f}`)
console.log(fails.length ? `${fails.length} problems` : 'Check view: all widths and themes fine')
process.exit(fails.length ? 1 : 0)
