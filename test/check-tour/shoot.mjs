// The tour of an understanding check in the journey panel (outside VS Code, in the harness of test/journey-map): the
// storyline with the check's questions as rows between the steps, at 320/600/1000 px, dark and light. Asserts what a
// person would notice: every question row after the step that shows its answer, nothing wider than the panel or cut
// sideways, the current row (a step, or a question) marked once, a click on a row asks for that question, no console
// errors. Exits 1 on any failure.
//
// Usage (after `npm run build`): node test/check-tour/shoot.mjs [screenshot-dir]
// PLAYWRIGHT: path to playwright's index.mjs when it is not installed in node_modules.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pw = await import(process.env.PLAYWRIGHT ? pathToFileURL(path.resolve(process.env.PLAYWRIGHT)).href : 'playwright')
const chromium = pw.chromium ?? pw.default.chromium
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : ''
if (OUT) fs.mkdirSync(OUT, { recursive: true })
const HARNESS = pathToFileURL(path.join(ROOT, 'test/journey-map/harness.html')).href
const fx = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/check-tour/refunds.json'), 'utf8'))
// As the extension sends it (journeyModel.parseJourney): steps carry their number.
const journey = { ...fx.journey, id: 'check-feat-refunds', steps: fx.journey.steps.map((s, i) => ({ ...s, n: i + 1 })), problems: [] }
const states = ['todo', 'retry', 'pass']
const stops = (cur) => fx.questions.map((q, i) => ({ ...q, state: states[i % states.length], ...(q.id === cur ? { cur: true } : {}) }))
const tour = (x) => ({ current: 0, marks: {}, resume: 0, legendHidden: true, problems: [], key: "Ctrl+'", tutorial: false, list: [], ...x })
const failures = []
const fail = (m) => { failures.push(m); console.log(`  ✗ ${m}`) }

const b = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--mute-audio'] })
for (const width of [320, 600, 1000]) for (const theme of ['dark', 'light']) {
  const tag = `${width}-${theme}`
  const page = await (await b.newContext({ viewport: { width, height: 760 }, deviceScaleFactor: 1 })).newPage()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${HARNESS}?theme=${theme}`)
  await page.waitForFunction(() => window.__posted.some((m) => m.type === 'ready'))
  const send = (m) => page.evaluate((x) => window.postMessage(x, '*'), m)
  const posted = () => page.evaluate(() => window.__posted.splice(0))
  const show = async (t) => {
    await posted()
    await send({ type: 'journey', journey, ...tour(t) })
    await page.waitForFunction(() => window.__posted.some((m) => m.type === 'story'), null, { timeout: 15000 })
    await page.waitForTimeout(150)
  }
  /** What the storyline shows: rows in order (step n / question id), the current ones, what sticks out or is cut. */
  const look = () => page.evaluate(() => {
    const W = document.documentElement.clientWidth
    const rows = [...document.querySelectorAll('.story > li > button')].map((e) => (e.classList.contains('cp') ? `q:${e.dataset.q}` : `s:${e.dataset.n}`))
    const cur = [...document.querySelectorAll('.story .cur')].map((e) => (e.classList.contains('cp') ? `q:${e.dataset.q}` : `s:${e.dataset.n}`))
    const out = []
    if (document.documentElement.scrollWidth > W + 1) out.push(`the page scrolls sideways (${document.documentElement.scrollWidth} > ${W})`)
    for (const e of document.querySelectorAll('.story .cp, .story .st')) {
      const r = e.getBoundingClientRect()
      if (r.right > W + 1) out.push(`${e.className} sticks out (${Math.round(r.right)} > ${W})`)
      for (const c of e.children) { const q = c.getBoundingClientRect(); if (q.right > r.right + 1 || q.left < r.left - 1) out.push(`${e.className} > ${c.className}: cut sideways`) }
      const t = e.querySelector('.t')
      if (t && t.getBoundingClientRect().height < 10) out.push(`${e.className}: its text has no height`)
    }
    // A question's text: at most two lines, the rest on hover (its title).
    for (const t of document.querySelectorAll('.story .cp .t')) { const lh = parseFloat(getComputedStyle(t).lineHeight) || 17; if (t.getBoundingClientRect().height > lh * 2 + 2) out.push(`question text over two lines: ${t.textContent.slice(0, 30)}`) }
    return { rows, cur, out, icons: [...document.querySelectorAll('.story .cp .n')].map((e) => e.textContent) }
  })
  const want = journey.steps.flatMap((s) => [`s:${s.n}`, ...fx.questions.filter((q) => q.step === s.n).map((q) => `q:${q.id}`)])

  // At a step: every question after the step that shows its answer; the step is the current row.
  await show({ current: 2, stops: stops() })
  let l = await look()
  if (l.rows.join() !== want.join()) fail(`${tag}: rows ${l.rows.join()} (want ${want.join()})`)
  if (l.cur.join() !== 's:2') fail(`${tag}: current ${l.cur.join()} (want s:2)`)
  const icon = { todo: '?', retry: '↻', pass: '✓' }
  const wantIcons = want.filter((r) => r.startsWith('q:')).map((r) => icon[stops().find((x) => `q:${x.id}` === r).state]).join()
  if (l.icons.join() !== wantIcons) fail(`${tag}: question icons ${l.icons.join()} (want ${wantIcons})`)
  for (const o of l.out) fail(`${tag} (step 2): ${o}`)
  if (OUT) await page.screenshot({ path: path.join(OUT, `tour-${tag}-step.png`), fullPage: true })

  // At a question: its row is the current one, not its step's.
  const q = fx.questions[0]
  await show({ current: q.step, stops: stops(q.id) })
  l = await look()
  if (l.cur.join() !== `q:${q.id}`) fail(`${tag}: at ${q.id}: current ${l.cur.join()}`)
  for (const o of l.out) fail(`${tag} (at ${q.id}): ${o}`)
  const story = (await posted()).filter((m) => m.type === 'story').pop()
  if (!story || story.cur !== q.id || story.stops.length !== fx.questions.length || story.overflow.length) fail(`${tag}: reported ${JSON.stringify(story)}`)
  if (OUT) await page.screenshot({ path: path.join(OUT, `tour-${tag}-question.png`), fullPage: true })

  // A click on a question's row asks for it (the extension opens its step and its thread).
  const other = fx.questions[fx.questions.length - 1]
  await posted()
  await page.click(`.story .cp[data-q="${other.id}"]`)
  await page.waitForTimeout(100)
  if (!(await posted()).some((m) => m.type === 'checkpoint' && m.id === other.id)) fail(`${tag}: a click on ${other.id}'s row posted nothing`)
  for (const e of errors) fail(`${tag}: ${e}`)
  console.log(`  ${failures.length ? '·' : '✓'} ${tag}: ${journey.steps.length} steps, ${fx.questions.length} questions between them`)
  await page.close()
}
await b.close()
if (failures.length) { console.log(`${failures.length} problem(s)`); process.exit(1) }
console.log('✓ the check tour\'s storyline: questions after their steps, nothing cut, one current row, a click asks for the question, no console errors')
