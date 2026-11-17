// The Check view's answer box (loaded after common.js, before check.js, which calls these hooks): under the selected
// question, a textarea for the answer (Ctrl+Enter sends it, Esc goes back to the code), its latest grade with the code
// links clickable, and "Next question ›" once it is done. Plain DOM, textContent only.
// In:
//   { type: 'focus', id }            the keyboard into that question's box
// Out:
//   { type: 'answer', id, text }     Ctrl+Enter
//   { type: 'draft', id, text }      what is typed, kept by the extension
//   { type: 'link', id, i }          a code link in the grade
//   { type: 'next' }  { type: 'escape' }  { type: 'regrade', id }
//   { type: 'focused', id, ok }      whether the keyboard reached the box
//   { type: 'concern', id, action }  'fix' | 'todo' | 'flag' | 'dismiss'
;(function () {
  /** What was typed here, newer than the drafts the extension sends back. */
  const drafts = {}
  let timer
  /** The question whose answer was just sent from its box: once graded, the keyboard goes back into it (or onto "Next"). */
  let sent
  const { el } = window.common
  const boxOf = (id) => document.querySelector(`.answer[data-id="${CSS.escape(id)}"]`)

  function parts(ps, id, post, w) {
    const s = el('span')
    for (const p of ps) {
      if (p.link === undefined) { s.append(p.text); continue }
      const b = el('button', 'codelink', p.text)
      b.title = 'Show this code'
      // The code lights up; the keyboard stays in the box.
      b.onclick = () => { post({ type: 'link', id, i: p.link }); const t = w.querySelector('textarea'); if (t) t.focus() }
      s.append(b)
    }
    return s
  }

  window.checkAnswer = {
    /** The box of answer view `a` (src/checkModel.ts AnswerBox), for row `r`. */
    box(a, r, post) {
      const w = el('div', 'answer')
      w.dataset.id = a.id
      if (a.open) {
        const t = el('textarea', 'box')
        t.placeholder = 'Answer in 1–3 sentences'
        // Two lines, growing with the answer (up to six): the other questions stay in view.
        t.rows = 2
        const grow = () => { t.style.height = ''; const lh = parseFloat(getComputedStyle(t).lineHeight) || 18; if (t.scrollHeight > t.clientHeight) t.style.height = `${Math.min(t.scrollHeight + 2, 6 * lh + 10)}px` }
        t.setAttribute('aria-label', `Your answer to question ${a.n}: ${r.text.replace(/`/g, '')} (Ctrl+Enter sends it)`)
        t.value = drafts[a.id] ?? a.draft
        // Never disabled while checking: a disabled box drops the keyboard, and what is typed next after the grade
        // would go nowhere. It can't be sent again until the grade is in.
        if (a.checking) t.setAttribute('aria-busy', 'true')
        requestAnimationFrame(grow)
        t.oninput = () => { grow(); drafts[a.id] = t.value; clearTimeout(timer); timer = setTimeout(() => post({ type: 'draft', id: a.id, text: t.value }), 300) }
        // Keys bubble on to VS Code (its shortcuts work from here: Ctrl+G, Ctrl+P, Ctrl+' D); check.js leaves the
        // arrows in a box alone.
        t.onkeydown = (e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            const text = t.value.trim()
            if (!text || a.checking) return
            drafts[a.id] = ''; clearTimeout(timer)
            sent = a.id
            post({ type: 'answer', id: a.id, text })
          } else if (e.key === 'Escape') { e.preventDefault(); post({ type: 'escape' }) }
        }
        w.append(t)
      }
      if (a.checking) w.append(el('p', 'checking', 'Checking…'))
      // Couldn't grade it (the answer is kept): why, and Try again.
      else if (a.error) { const p = el('p', 'failed'), b = el('button', 'link', 'Try again'); b.onclick = () => post({ type: 'regrade', id: a.id }); p.append(`⚠ ${a.error} `, b); w.append(p) }
      else if (a.grade) {
        const g = el('div', `grade${a.grade.pass ? ' pass' : ''}`)
        const f = el('p')
        if (a.grade.pass) f.append(el('span', 'mark', '✓ '))
        f.append(parts(a.grade.feedback, a.id, post, w))
        g.append(f)
        if (a.grade.hint) { const h = el('p', 'hint'); h.append(el('b', null, 'Hint: '), parts(a.grade.hint, a.id, post, w)); g.append(h) }
        if (a.grade.say) g.append(el('p', 'say', a.grade.say))
        w.append(g)
      }
      // A concern about the code: its actions here too (the box may be closed after a pass).
      if (a.concern) {
        const c = el('div', 'concern')
        c.append(el('p', null, `⚠ ${a.concern.text}`))
        const acts = el('p', 'acts')
        const act = (label, action) => { const b = el('button', 'link', label); b.onclick = () => post({ type: 'concern', id: a.id, action }); return b }
        // Its fix is in the code: said; it goes with Commit & push.
        if (a.concern.applied) acts.append(el('span', 'applied', 'Fix applied · not committed'), ' · ', act('Dismiss', 'dismiss'))
        else acts.append(act('Suggest a fix', 'fix'), ' · ', act('Add TODO', 'todo'), ' · ', act(a.concern.flagged ? 'Flagged ✓' : 'Flag for reviewer', 'flag'), ' · ', act('Dismiss', 'dismiss'))
        c.append(acts); w.append(c)
      }
      if (a.next) { const n = el('button', 'next', 'Next question ›'); n.onclick = () => post({ type: 'next' }); w.append(n) }
      return w
    },
    /** Before the view is drawn again: where the keyboard is in a box. */
    before() {
      const e = document.activeElement
      const w = e && e.closest && e.closest('.answer')
      return w ? { id: w.dataset.id, box: e.tagName === 'TEXTAREA', s: e.selectionStart, e: e.selectionEnd } : undefined
    },
    /** After: the keyboard back where it was (the box gone after a pass: on "Next question ›"). */
    after(k) {
      // Graded after an answer sent from here: the keyboard back in the box (a retry, say it back) or on "Next", also
      // when it was lost meanwhile (nothing else took it: the body has it).
      if (sent) {
        const w = boxOf(sent), a = document.activeElement
        if (w && !w.querySelector('.checking') && (!a || a === document.body || (k && k.id === sent))) {
          const t = w.querySelector('textarea'), target = t || w.querySelector('.next')
          sent = undefined
          if (target) { target.focus(); if (t) t.setSelectionRange(t.value.length, t.value.length); return }
        } else if (!w) sent = undefined
      }
      if (!k) return
      const w = boxOf(k.id)
      const t = w && w.querySelector('textarea')
      if (t) { t.focus(); if (k.box) t.setSelectionRange(k.s, k.e) } else if (w && w.querySelector('.next')) w.querySelector('.next').focus()
    },
    message(m, post) {
      if (m.type !== 'focus') return false
      // Did the keyboard arrive? (The view may have been focused late, or not at all: then the extension tries again.)
      setTimeout(() => {
        const a = document.activeElement
        post({ type: 'focused', id: m.id, ok: document.hasFocus() && !!a && !!a.closest && !!a.closest(`.answer[data-id="${CSS.escape(m.id)}"]`) })
      }, 1200)
      const go = () => {
        const w = boxOf(m.id)
        if (!w) return false
        const t = w.querySelector('textarea')
        const target = t || w.querySelector('.next')
        if (target) { target.focus(); if (t) t.setSelectionRange(t.value.length, t.value.length) }
        w.scrollIntoView({ block: 'nearest' })
        return true
      }
      // The view may still be drawing this question's box (its view update can come a moment later): keep trying, 1 s.
      let tries = 0
      const again = () => { if (!go() && ++tries < 10) setTimeout(again, 100) }
      requestAnimationFrame(again)
      return true
    },
  }
})()
