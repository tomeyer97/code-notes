// The player's layout as a person would see it, asserted in a page (the Listen view or the journey panel), and every
// control it shows clicked once. The player's parts are found by their roles, labels and data-testid; the panel's
// own parts by pages.mjs PANEL.
import assert from 'node:assert/strict'
import { PANEL } from './pages.mjs'

/** The player's layout in `pg` (`where` names it in the messages; `panel`: the journey panel, with its storyline). */
export async function assertLayout(pg, where, episode, { panel = true } = {}) {
  const L = await pg.evaluate((P) => {
    const W = document.documentElement.clientWidth, H = window.innerHeight
    const vis = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'
    const box = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height } }
    const pod = document.querySelector('[role="region"][aria-label="Listen"]')
    const name = (e) => e.getAttribute('aria-label') || e.dataset.testid || e.getAttribute('role') || e.textContent.trim()
    const isMark = (e) => /^Go to /.test(e.getAttribute('aria-label') || '')
    const controls = [...pod.querySelectorAll('button, [data-testid="time"], [data-testid="note"], [role="status"]')].filter((e) => vis(e) && !isMark(e))
      .map((e) => ({ c: `${e.tagName.toLowerCase()} "${name(e)}"`, ...box(e), cut: e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).textOverflow !== 'ellipsis', text: e.textContent.trim().slice(0, 30) }))
    const marks = [...pod.querySelectorAll('button')].filter(isMark).map((e) => ({ ...box(e), step: e.dataset.step }))
    const track = box(pod.querySelector('[role="slider"]'))
    const capEl = pod.querySelector('[data-testid="caption"]')
    const lineH = parseFloat(getComputedStyle(capEl).lineHeight)
    const cap = vis(capEl) ? { h: capEl.scrollHeight, client: capEl.clientHeight, lineH, text: capEl.textContent } : null
    const shownSel = (s) => vis(pod.querySelector(s))
    const story = [...document.querySelectorAll(P.storyTimes)].filter(vis).map((e) => ({ r: e.getBoundingClientRect().right, cut: e.scrollWidth > e.clientWidth + 1, text: e.textContent }))
    const storyW = document.querySelector(P.story) ? document.querySelector(P.story).getBoundingClientRect().width : 0
    const titles = [...document.querySelectorAll(P.storyTitles)].filter(vis).map((e) => ({ w: e.getBoundingClientRect().width, wraps: e.getBoundingClientRect().height > parseFloat(getComputedStyle(e).lineHeight) * 1.5, text: e.textContent.slice(0, 20) }))
    const head = document.querySelector('header')
    const app = document.getElementById('app')
    const note = pod.querySelector('[data-testid="note"]')
    return {
      W, H, pod: box(pod), podVis: vis(pod), controls, marks, track, cap, story, storyW, titles,
      shown: {
        prev: shownSel('button[aria-label="Previous step"]'), play: shownSel('button[aria-label="Play"], button[aria-label="Pause"]'),
        next: shownSel('button[aria-label="Next step"]'), time: shownSel('[data-testid="time"]'), total: shownSel('[data-testid="total"]'),
        rate: shownSel('button[aria-label^="Speed"]'), mute: shownSel('button[aria-label^="Mute"]'),
      },
      unavail: vis(note) && note.textContent === 'Podcast unavailable', ended: vis(pod.querySelector('[data-testid="end"]')),
      scrollW: document.documentElement.scrollWidth,
      appPad: app ? parseFloat(getComputedStyle(app).paddingBottom) : 0,
      headH: head ? head.getBoundingClientRect().height : 0, listening: !!document.querySelector(P.listeningHeader),
    }
  }, PANEL)
  const say = (m) => `${where}: ${m}`
  assert.ok(L.podVis, say('the player is shown'))
  assert.ok(L.scrollW <= L.W + 0.5, say(`no sideways scroll (${L.scrollW} > ${L.W})`))
  if (panel) assert.ok(L.pod.l >= 0 && L.pod.r <= L.W + 0.5 && Math.abs(L.pod.b - L.H) < 1, say(`the player at the window's bottom, inside it: ${JSON.stringify(L.pod)}`))
  for (const c of L.controls) {
    assert.ok(c.l >= -0.5 && c.r <= L.W + 0.5 && c.t >= -0.5 && c.b <= L.H + 0.5, say(`${c.c} "${c.text}" inside the window (${c.l.toFixed(0)}–${c.r.toFixed(0)} of ${L.W})`))
    assert.ok(c.l >= L.pod.l - 0.5 && c.r <= L.pod.r + 0.5, say(`${c.c} inside the player`))
    assert.ok(!c.cut, say(`${c.c} "${c.text}" not cut`))
  }
  const btns = L.controls.filter((c) => c.c.startsWith('button'))
  for (let i = 0; i < btns.length; i++) for (let j = i + 1; j < btns.length; j++) {
    const a = btns[i], c = btns[j]
    const overlap = Math.min(a.r, c.r) - Math.max(a.l, c.l) > 0.5 && Math.min(a.b, c.b) - Math.max(a.t, c.t) > 0.5
    assert.ok(!overlap, say(`${a.c} and ${c.c} overlap`))
  }
  if (L.unavail) return L
  if (L.ended) {
    assert.ok(!L.shown.play && !L.shown.rate, say(`the end: no transport, no speed: ${JSON.stringify(L.shown)}`))
    return L
  }
  assert.ok(L.track.w >= L.pod.w - 40, say(`the timeline is the player's width (${L.track.w.toFixed(0)} of ${L.pod.w.toFixed(0)})`))
  assert.equal(L.marks.length, episode.chapters.filter((c) => c.step).length, say('a mark per step part'))
  for (const m of L.marks) {
    assert.ok(m.w >= 7.9, say(`step ${m.step}'s mark is a target (${m.w.toFixed(1)} px ≥ 8)`))
    assert.ok(m.l >= L.track.l - 0.5 && m.r <= L.track.r + 0.5, say(`step ${m.step}'s mark on the timeline`))
  }
  for (let i = 1; i < L.marks.length; i++) assert.ok(L.marks[i].l >= L.marks[i - 1].r - 0.5, say(`marks ${L.marks[i - 1].step} and ${L.marks[i].step} don't overlap`))
  // By priority: ▶ always; ⏮ ⏭ before the time; the time before the speed; the speed before mute.
  const s = L.shown
  assert.ok(s.play && s.prev && s.next, say(`▶ ⏮ ⏭ always there: ${JSON.stringify(s)}`))
  assert.ok(!s.rate || s.time, say('the speed only with the time'))
  assert.ok(!s.mute || s.rate, say('mute only with the speed'))
  assert.ok(!s.total || s.rate, say('the total only with the speed'))
  if (L.cap) {
    assert.ok(L.cap.h <= L.cap.lineH * 2 + 2, say(`the caption is two lines at most (${L.cap.h}px, line ${L.cap.lineH}): "${L.cap.text}"`))
    assert.ok(L.cap.h <= L.cap.client + 1, say(`the caption is not cut: "${L.cap.text}"`))
    assert.ok(!/…$/.test(L.cap.text), say('no ellipsis in the caption'))
  }
  if (panel) {
    assert.ok(L.appPad >= L.pod.h, say(`the page's end stays clear of the player (padding ${L.appPad} < ${L.pod.h})`))
    for (const x of L.story) assert.ok(!x.cut && x.r <= L.W + 0.5, say(`the storyline's "${x.text}" not cut`))
    // A row's title that wraps keeps most of the row (the time and the buttons never squeeze it to a column of letters).
    for (const t of L.titles) assert.ok(!t.wraps || t.w >= Math.min(120, L.storyW * 0.5), say(`the storyline title "${t.text}" has room (${t.w.toFixed(0)} px of ${L.storyW.toFixed(0)})`))
  }
  return L
}

/** Every control the player shows, clicked once (`restore` after each), the pointer away after; no click raises an
 *  error in the page. */
export async function clickEverything(pg, where, restore) {
  const targets = await pg.evaluate(() => {
    const pod = document.querySelector('[role="region"][aria-label="Listen"]')
    for (const e of pod.querySelectorAll('[data-ck]')) delete e.dataset.ck
    const all = [...pod.querySelectorAll('button')].filter((e) => e.getClientRects().length)
    return all.map((e, i) => { e.dataset.ck = String(i); return { sel: `[role="region"][aria-label="Listen"] [data-ck="${i}"]`, name: e.getAttribute('aria-label') || e.textContent.trim() } })
  })
  for (const t of targets) {
    const before = await pg.evaluate(() => window.__harness.errors.length)
    try {
      await pg.click(t.sel, { timeout: 2000 })
    } catch (e) {
      const over = await pg.evaluate((sel) => {
        const e = document.querySelector(sel)
        if (!e) return 'gone'
        const r = e.getBoundingClientRect()
        const x = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return `${JSON.stringify(r.toJSON())} under ${x && x.tagName} connected ${e.isConnected}`
      }, t.sel)
      assert.fail(`${where}: can't click "${t.name}": ${e instanceof Error ? e.message.split('\n')[0] : e} (${over})`)
    }
    // The click handled and drawn: two frames.
    await pg.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(undefined)))))
    assert.equal(await pg.evaluate(() => window.__harness.errors.length), before, `${where}: clicking "${t.name}" raised an error`)
    if (restore) await restore(t)
  }
  await pg.mouse.move(2, 2)
}
