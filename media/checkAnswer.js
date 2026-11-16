// The Check view's answer box (loaded before check.js, which calls these hooks): under the selected question, a
// textarea for the answer (Ctrl+Enter sends it, Esc goes back to the code), its latest grade with the code links
// clickable, and "Next question ›" once it is done. Plain DOM, textContent only.
// In:  { type: 'focus', id } (the keyboard into that question's box)
// Out: { type: 'answer', id, text } { type: 'draft', id, text } { type: 'link', id, i } { type: 'next' } { type: 'escape' }
//      { type: 'focused', id, ok } (whether the keyboard reached the box) { type: 'concern', id, action }
;(function () {
  /** What was typed here, newer than the drafts the extension sends back. */
  const drafts = {}
  let timer
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e }
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
        t.rows = 3
        t.setAttribute('aria-label', `Your answer to question ${a.n}: ${r.text.replace(/`/g, '')} (Ctrl+Enter sends it)`)
        t.value = drafts[a.id] ?? a.draft
        t.disabled = !!a.checking
        t.oninput = () => { drafts[a.id] = t.value; clearTimeout(timer); timer = setTimeout(() => post({ type: 'draft', id: a.id, text: t.value }), 300) }
        t.onkeydown = (e) => {
          e.stopPropagation() // the arrows move the caret here, not between the questions
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            const text = t.value.trim()
            if (!text || a.checking) return
            drafts[a.id] = ''; clearTimeout(timer)
            post({ type: 'answer', id: a.id, text })
          } else if (e.key === 'Escape') { e.preventDefault(); post({ type: 'escape' }) }
        }
        w.append(t)
      }
      if (a.checking) w.append(el('p', 'checking', 'Checking…'))
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
        acts.append(act('Suggest a fix', 'fix'), ' · ', act('Add TODO', 'todo'), ' · ', act(a.concern.flagged ? 'Flagged ✓' : 'Flag for reviewer', 'flag'), ' · ', act('Dismiss', 'dismiss'))
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
      if (!k) return
      const w = boxOf(k.id)
      const t = w && w.querySelector('textarea:not([disabled])')
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
