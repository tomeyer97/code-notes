// The Check view's answer box (loaded after common.js, before check.js, which calls window.checkAnswer): under the selected
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
//   (src/check/viewMessages.ts lists these with check.js's; test/checkViewMessages.test.ts compares them.)
;(function () {
  /** What was typed here, newer than the drafts the extension sends back. */
  const drafts = {}
  let timer
  /** The question whose answer was just sent from its box: once graded, the keyboard goes back into it (or onto "Next"). */
  let sent
  const { el, button, joinDots, watched } = window.common
  /** Question `id`'s box (null: not drawn). */
  const boxOf = (id) => document.querySelector(`.answer[data-id="${CSS.escape(id)}"]`)
  /** Element `e` is in question `id`'s box. */
  const inBox = (e, id) => {
    const w = boxOf(id)
    return !!w && !!e && w.contains(e)
  }
  /** The answer box shows two lines and grows with the answer up to this many: the other questions stay in view. */
  const MAX_LINES = 6
  /** How long a draft waits for typing to pause before it is sent (ms). */
  const DRAFT_DEBOUNCE_MS = 300
  /** After a { type: 'focus' }: when to report whether the keyboard reached the box (ms). */
  const FOCUS_CHECK_MS = 1200
  /** Its box may still be being drawn: tried this many times, this far apart (ms): about a second. */
  const FOCUS_TRIES = 10, FOCUS_RETRY_MS = 100

  /** The keyboard into box `w`: its textarea, the caret at `caret` ([start, end]; undefined: the end; null: left as
   *  it is), or else its "Next question ›". Whether there was one. */
  function focusBox(w, caret) {
    const t = w.querySelector('textarea')
    const target = t || w.querySelector('.next')
    if (!target) return false
    target.focus()
    if (t && caret !== null) {
      const [start, end] = caret || [t.value.length, t.value.length]
      t.setSelectionRange(start, end)
    }
    return true
  }

  /** Grade text: plain text and code links (a click lights the code; the keyboard stays in the box). */
  function parts(ps, id, post, w) {
    const s = el('span')
    for (const p of ps) {
      if (p.link === undefined) { s.append(p.text); continue }
      const b = button('codelink', p.text, () => {
        post({ type: 'link', id, i: p.link })
        const t = w.querySelector('textarea')
        if (t) t.focus()
      })
      b.title = 'Show this code'
      s.append(b)
    }
    return s
  }

  /** The textarea of answer `a` (row `r`): the draft kept, Ctrl+Enter sends it, Esc goes back to the code. */
  function answerArea(a, r, post) {
    const t = watched(el('textarea', 'box'))
    t.placeholder = 'Answer in 1–3 sentences'
    t.rows = 2
    const grow = () => {
      t.style.height = ''
      const lh = parseFloat(getComputedStyle(t).lineHeight) || 18
      if (t.scrollHeight > t.clientHeight) t.style.height = `${Math.min(t.scrollHeight + 2, MAX_LINES * lh + 10)}px`
    }
    t.setAttribute('aria-label', `Your answer to question ${a.n}: ${r.text.replace(/`/g, '')} (Ctrl+Enter sends it)`)
    t.value = drafts[a.id] ?? a.draft
    // Never disabled while checking: a disabled box drops the keyboard, and what is typed next after the grade
    // would go nowhere. It can't be sent again until the grade is in.
    if (a.checking) t.setAttribute('aria-busy', 'true')
    requestAnimationFrame(grow)
    // What is typed: kept here at once, sent to the extension once typing pauses.
    t.oninput = () => {
      grow()
      drafts[a.id] = t.value
      clearTimeout(timer)
      timer = setTimeout(() => post({ type: 'draft', id: a.id, text: t.value }), DRAFT_DEBOUNCE_MS)
    }
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
    return t
  }

  /** The latest grade: ✓ and the feedback, a hint, what to say back. */
  function gradeBlock(a, post, w) {
    const g = el('div', `grade${a.grade.pass ? ' pass' : ''}`)
    const f = watched(el('p'))
    if (a.grade.pass) f.append(el('span', 'mark', '✓ '))
    f.append(parts(a.grade.feedback, a.id, post, w))
    g.append(f)
    if (a.grade.hint) {
      const h = watched(el('p', 'hint'))
      h.append(el('b', null, 'Hint: '), parts(a.grade.hint, a.id, post, w))
      g.append(h)
    }
    if (a.grade.say) g.append(watched(el('p', 'say', a.grade.say)))
    return g
  }

  /** A concern about the code and its actions (also here: the box may be closed after a pass). Its fix is in the
   *  code: said; it goes with Commit & push. */
  function concernBlock(a, post) {
    const c = el('div', 'concern')
    c.append(el('p', null, `⚠ ${a.concern.text}`))
    const acts = el('p', 'acts')
    const act = (label, action) => button('link', label, () => post({ type: 'concern', id: a.id, action }))
    if (a.concern.applied) {
      acts.append(...joinDots(
        el('span', 'applied', 'Fix applied · not committed'),
        act('Dismiss', 'dismiss'),
      ))
    } else {
      acts.append(...joinDots(
        act('Suggest a fix', 'fix'),
        act('Add TODO', 'todo'),
        act(a.concern.flagged ? 'Flagged ✓' : 'Flag for reviewer', 'flag'),
        act('Dismiss', 'dismiss'),
      ))
    }
    c.append(acts)
    return c
  }

  window.checkAnswer = {
    /** The box of answer view `a` (src/check/viewModel.ts AnswerBox), for row `r`. */
    box(a, r, post) {
      const w = el('div', 'answer')
      w.dataset.id = a.id
      if (a.open) w.append(answerArea(a, r, post))
      if (a.checking) w.append(el('p', 'checking', 'Checking…'))
      // Couldn't grade it (the answer is kept): why, and Try again.
      else if (a.error) {
        const p = watched(el('p', 'failed'))
        p.append(`⚠ ${a.error} `, button('link', 'Try again', () => post({ type: 'regrade', id: a.id })))
        w.append(p)
      } else if (a.grade) w.append(gradeBlock(a, post, w))
      if (a.concern) w.append(concernBlock(a, post))
      if (a.next) w.append(watched(button('link next', 'Next question ›', () => post({ type: 'next' }))))
      return w
    },
    /** Before the view is drawn again: where the keyboard is in a box ({ id, inBox: in its textarea, caret:
     *  [start, end] }), or undefined. */
    before() {
      const focused = document.activeElement
      const w = focused && focused.closest && focused.closest('.answer')
      if (!w) return undefined
      const caret = [focused.selectionStart, focused.selectionEnd]
      return { id: w.dataset.id, inBox: focused.tagName === 'TEXTAREA', caret }
    },
    /** After: the keyboard back where it was (the box gone after a pass: on "Next question ›"). */
    after(k) {
      // Graded after an answer sent from here: the keyboard back in the box (a retry, say it back) or on "Next", also
      // when it was lost meanwhile (nothing else took it: the body has it).
      if (sent) {
        const w = boxOf(sent), focused = document.activeElement
        const lost = !focused || focused === document.body
        if (w && !w.querySelector('.checking') && (lost || (k && k.id === sent))) {
          sent = undefined
          if (focusBox(w)) return
        } else if (!w) sent = undefined
      }
      if (!k) return
      const w = boxOf(k.id)
      if (w) focusBox(w, k.inBox ? k.caret : null)
    },
    message(m, post) {
      if (m.type !== 'focus') return false
      // Did the keyboard arrive? (The view may have been focused late, or not at all: then the extension tries again.)
      setTimeout(() => {
        const ok = document.hasFocus() && inBox(document.activeElement, m.id)
        post({ type: 'focused', id: m.id, ok })
      }, FOCUS_CHECK_MS)
      const go = () => {
        const w = boxOf(m.id)
        if (!w) return false
        focusBox(w)
        w.scrollIntoView({ block: 'nearest' })
        return true
      }
      // The view may still be drawing this question's box (its view update can come a moment later): keep trying.
      let tries = 0
      const again = () => { if (!go() && ++tries < FOCUS_TRIES) setTimeout(again, FOCUS_RETRY_MS) }
      requestAnimationFrame(again)
      return true
    },
  }
})()
