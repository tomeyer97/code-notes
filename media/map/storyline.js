// The storyline: a row per step (number and title; the current one marked, a stale one's number amber), a check's
// questions between them, the step card under the current row when the card lives here, the animation's toggle on
// the current row. With a podcast the rows are its chapter list (chapters.js).
import { el, button } from '../common.js'
import { QSTATE } from '../../src/protocol/check'
import { mdBlock } from './markdown.js'
import { makeChapters } from './chapters.js'
import { sceneOf } from './state.js'
import { tutorialTarget } from './context.js'

/** What the storyline drew: its rows (steps and parts), the check's questions on it, the current question.
 *  @typedef {{ steps: number, stops: string[], cur?: string }} Drawn */
/** @type {Drawn} */
const NOTHING_DRAWN = Object.freeze({ steps: 0, stops: [], cur: undefined })

/** @param {import('./context.js').PanelContext} ctx */
export function makeStoryline(ctx) {
  const { state, post } = ctx
  const chapters = makeChapters(ctx)
  /** @type {Drawn} */
  let drawn = NOTHING_DRAWN

  /** The storyline, under "Transcript" when it is the podcast's chapter list. */
  function column() {
    const byRow = chapters.start()
    const ol = storyline(byRow)
    if (!byRow) return ol
    const d = el('div', 'storycol')
    d.append(chapters.transcriptHead(), ol)
    return d
  }

  function storyline(byRow) {
    const { journey, tour } = state.walk
    const steps = /** @type {import('./state.js').Journey} */ (journey).steps
    const ol = tutorialTarget(el('ol', 'story'), 'storyline')
    ol.setAttribute('aria-label', 'Steps')
    if (byRow) ol.classList.add('pod-story')
    // Every step, always (no folded "n steps elsewhere"); a check's questions after the step that shows their answer.
    const stopsAfter = (n) => tour.stops.filter((q) => q.step === n)
    const groups = steps.map((s) => [stepItem(s, byRow), ...stopsAfter(s.n).map(stopRow)])
    const parts = byRow ? chapters.addParts(groups, byRow, steps) : 0
    ol.append(...groups.flat())
    const stops = steps.flatMap((s) => stopsAfter(s.n))
    drawn = { steps: steps.length + parts, stops: stops.map((q) => q.id), cur: stops.find((q) => q.cur)?.id }
    return ol
  }

  /** Step `s`'s row: its button (with ▶ and the transcript in a chapter list), the animation's toggle, the card. */
  function stepItem(s, byRow) {
    const { cur, tour } = state.walk
    const li = el('li')
    const b = stepButton(s)
    if (byRow) li.append(...chapters.stepRow(li, b, s.n, byRow))
    else li.append(b)
    if (s.n === cur && showsAnimToggle()) li.append(animToggle())
    // A step with no code to open (file or code gone) shows its card here, in place of the editor jump.
    if (s.n === cur && tour.card) li.append(stepCard())
    return li
  }

  /** Number and title only: no "later", no question marks (they are in the step card), no "stopped here". Only the
   *  current row and a stale one stand out; at a question after the current step, the question's row is current. */
  function stepButton(s) {
    const { cur, tour } = state.walk
    const here = s.n === cur && !tour.stops.some((q) => q.cur)
    const stale = tour.marks[s.n] || ''
    const b = el('button', ['st', here ? 'cur' : '', stale].filter(Boolean).join(' '))
    b.dataset.n = s.n
    b.append(el('span', 'n', String(s.n)), el('span', 't', s.title))
    if (stale) b.title = 'The code changed since this step was written'
    if (here) {
      b.setAttribute('aria-current', 'step')
      tutorialTarget(b, 'current-row')
    }
    b.onclick = () => ctx.goStep(s.n)
    return b
  }

  /** The current step has an animation and it is not playing (under the tutorial it shows, for the card about it). */
  function showsAnimToggle() {
    const { cur } = state.walk
    const playing = state.anim.on && !ctx.tutorial.card
    return !!ctx.scene && !!sceneOf(state, cur) && !playing
  }

  /** The animation's toggle, in words (a ▶ on every row read as "run the test"); while it plays the scene beside the
   *  row is the state, and its Map (or Esc) ends it. */
  function animToggle() {
    const a = tutorialTarget(el('button', 'animbtn', 'Show animation'), 'animation')
    a.title = `Play this step as an animation (${state.walk.key} P)`
    a.onclick = () => ctx.toggleAnim()
    return a
  }

  /** A check's question as a row after the step that shows its answer: "? Why …", its state (src/protocol/check.ts
   *  QSTATE: the icon here is `storyIcon` when it has one). */
  function stopRow(q) {
    const li = el('li', 'cpl')
    const b = el('button', ['cp', q.state, q.cur ? 'cur' : ''].filter(Boolean).join(' '))
    b.dataset.q = q.id
    const st = Object.hasOwn(QSTATE, q.state) ? QSTATE[q.state] : {}
    const icon = el('span', 'n', st.storyIcon || st.icon || '?')
    icon.setAttribute('aria-hidden', 'true')
    b.append(icon, el('span', 't', q.text))
    if (st.word) b.append(el('span', 'w', st.word))
    b.title = `Question ${q.n}: ${q.text}`
    b.setAttribute('aria-label', `Question ${q.n}${st.answered ? ', answered' : ''}: ${q.text}`)
    if (q.cur) b.setAttribute('aria-current', 'step')
    b.onclick = () => { if (!ctx.tutorial.card && !state.walk.deleted) post({ type: 'checkpoint', id: q.id }) }
    li.append(b)
    return li
  }

  /** The step card in the panel: lead, More, refs, ‹ ›, Ask. Links are posted back by index. */
  function stepCard() {
    const card = /** @type {import('../../src/protocol/map').PanelCard} */ (state.walk.tour.card)
    const c = el('div', 'scard')
    c.setAttribute('role', 'region')
    c.setAttribute('aria-label', `Step ${state.walk.cur}`)
    const text = (cls, s) => { const d = el('div', cls); d.innerHTML = mdBlock(s); c.append(d) }
    if (card.staleText) text('sstale', card.staleText)
    if (card.lead) text('slead', card.lead)
    c.append(stepNav(card))
    if (card.open && card.details) text('sdetails', card.details)
    if (card.open && card.refs) text('srefs', card.refs)
    // A notice last, quiet.
    if (card.notice) c.append(el('div', 'snotice', `ℹ ${card.notice}`))
    // A reference reads as its file name; the whole path on hover.
    for (const r of /** @type {NodeListOf<HTMLElement>} */ (c.querySelectorAll('.ref'))) {
      const path = (card.paths || [])[Number(r.dataset.i)]
      if (path) r.title = path
    }
    c.addEventListener('click', (e) => cardLink(/** @type {HTMLElement} */ (e.target), e))
    return c
  }

  /** A click in the card's text on one of its links (mdBlock's buttons): what it posts. */
  function cardLink(on, e) {
    const r = /** @type {HTMLElement | null} */ (on.closest('.ref'))
    if (r) { e.stopPropagation(); post({ type: 'ref', i: Number(r.dataset.i) }) }
    if (on.closest('.askupd')) { e.stopPropagation(); post({ type: 'ask', update: true }) }
    const nq = /** @type {HTMLElement | null} */ (on.closest('.noteq'))
    if (nq) { e.stopPropagation(); post({ type: 'question', id: /** @type {string} */ (nq.dataset.id) }) }
  }

  /** The step card's links: ‹ Previous, Next › (or Finish), the step's questions, Ask, More / Less. */
  function stepNav(card) {
    const { journey, cur, tour } = state.walk
    const last = cur === /** @type {import('./state.js').Journey} */ (journey).steps.length
    const nav = el('div', 'snav')
    if (cur > 1) nav.append(button('link sprev', '‹ Previous', () => ctx.goStep(cur - 1)))
    // A check's tour: Next goes through the extension, which stops at the questions between the steps.
    if (tour.stops.length) nav.append(button('link snext', last ? 'Finish' : 'Next ›', () => post({ type: 'nextStop' })))
    else if (!last) nav.append(button('link snext', 'Next ›', () => ctx.goStep(cur + 1)))
    else nav.append(button('link send', 'Finish', () => post({ type: 'finish' })))
    // The step's questions live here only: a count, the unread colour for a new reply.
    const a = tour.asked[cur]
    if (a) nav.append(button(`link squestion${a.unread ? ' unread' : ''}`, `${a.count || 1} asked ›`, () => post({ type: 'question', id: a.id })))
    // One Ask in a stale card: the banner's, which opens the request prefilled.
    if (!card.staleText) nav.append(button('link sask', 'Ask', () => post({ type: 'ask' })))
    // More holds the details and the references (no bare link row).
    if (card.details || card.refs) nav.append(button('link smore', card.open ? 'Less' : 'More', () => post({ type: 'details', open: !card.open })))
    return nav
  }

  return {
    column,
    /** Nothing drawn yet in this render (the storyline is drawn only in some layouts). */
    reset() { drawn = NOTHING_DRAWN; chapters.start() },
    /** What the last storyline drew (the panel reports it for tests). */
    get drawn() { return drawn },
    /** The podcast's time moved: the rows marked. */
    tick: chapters.tick,
  }
}
