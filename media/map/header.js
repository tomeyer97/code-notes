// The panel's sticky header: where the reader is. Walking: "‹ Journeys", the short title with End beside it, the
// question, one byline (or "Deleted · Restore"), a problem line. While an episode is on: one line naming where the
// voice is.
import { el, button } from '../common.js'
import { chapterAt } from './episode.js'
import { tutorialTarget } from './context.js'

/** @param {import('./context.js').PanelContext} ctx */
export function makeHeader(ctx) {
  const { state, post } = ctx

  /** "‹ Journeys" (`compact`: only "‹", while an episode is paused). */
  function homeButton(compact) {
    const b = el('button', 'link homeb', compact ? '‹' : '‹ Journeys')
    b.title = 'All journeys'
    if (compact) b.setAttribute('aria-label', 'All journeys')
    b.onclick = ctx.goHome
    return b
  }

  /** The heading, its whole text on hover when `tip`. */
  function title(text, tip) {
    const q = tutorialTarget(el('h1', 'q', text), 'title')
    if (tip) q.title = text
    return q
  }

  /** An episode on: "Step 6 of 14 · title" (or Intro, Map, Recap); ‹ and End only on pause. The question and the
   *  byline come back once the episode is over. */
  function listeningHeader() {
    const h = el('header', 'listening')
    const top = el('div', 'top')
    const playing = state.listen.playing
    if (!playing) top.append(homeButton(true))
    top.append(title(listeningTitle(), true), ...(playing ? [] : [stepControls()]))
    h.append(top)
    return h
  }

  /** Walking (or not yet): the short title, as in the lists and the tab, the question under it; the byline, or
   *  "Deleted · Restore"; the problems. No summary: the storyline is the answer. */
  function walkHeader() {
    const j = /** @type {import('./state.js').Journey} */ (state.walk.journey)
    const h = el('header')
    const top = el('div', 'top')
    h.append(homeButton(false))
    top.append(title(j.title || j.question, false), stepControls())
    h.append(top)
    if (j.title && j.question && j.question.toLowerCase() !== j.title.toLowerCase()) {
      const sq = el('p', 'qsub', j.question)
      sq.title = j.question
      h.append(sq)
    }
    if (state.walk.deleted) h.append(deletedLine())
    else {
      const by = byline()
      if (by) h.append(by)
      if (state.walk.tour.problems.length) h.append(problemLine())
    }
    return h
  }

  /** "Deleted · Restore": the tab closes like any tab, the picker is a command. */
  function deletedLine() {
    const g = el('p', 'gone', 'Deleted')
    g.append(el('span', 'sep', ' · '), button('link restore', 'Restore', () => post({ type: 'restore' })))
    return g
  }

  /** One muted line: who wrote it, when; amber "out of date" (not "changed since": since what?) when steps are. */
  function byline() {
    const prov = state.walk.tour.prov
    if (!prov || !(prov.text || prov.changed)) return undefined
    const p = tutorialTarget(el('p', 'prov', prov.text || ''), 'byline')
    if (prov.tip) p.title = prov.tip
    if (prov.changed) {
      const steps = `${prov.changed} step${prov.changed === 1 ? '' : 's'}`
      const c = el('span', 'changed', `${prov.text ? ' · ' : ''}⚠ ${steps} out of date`)
      c.title = 'The code changed after this journey was written'
      p.append(c)
    }
    return p
  }

  /** While listening: the step the voice is on ("Step 6 of 14 · title"), or the part on the map. */
  function listeningTitle() {
    const { journey, cur } = state.walk
    if (journey && cur) return `Step ${cur} of ${journey.steps.length} · ${journey.steps[cur - 1].title}`
    const podcast = ctx.podcast
    const { part } = chapterAt(podcast && podcast.episode, podcast ? podcast.now.t : 0)
    return part === 'intro' ? 'Intro' : part === 'recap' ? 'Recap' : 'Map'
  }

  /** One short line when the journey can't be read (readers see only what affects reading); the list on hover. */
  function problemLine() {
    const { problems } = state.walk.tour
    const d = el('div', 'problems')
    const b = el('span', 'plink', `⚠ ${problems[0]} `)
    b.title = problems.join('\n')
    d.append(b, button('link openfile', 'Open file', () => post({ type: 'openFile' })))
    return d
  }

  /** End, while walking. No Start or Resume: opening a journey walks it; after End a step in the storyline walks on.
   *  The position is on the card and the status bar. On the last step the card's Finish is the one way to end. */
  function stepControls() {
    const t = tutorialTarget(el('div', 'tour'), 'controls')
    const { journey, cur, deleted } = state.walk
    if (!journey || !journey.steps.length || deleted || !cur || cur === journey.steps.length) return t
    // It says what it closes.
    const end = el('button', 'tbtn end', 'End')
    end.title = 'Stop walking this journey'
    end.onclick = () => { state.listen.session = ''; post({ type: 'end' }) }
    t.append(end)
    return t
  }

  return {
    /** The header for what is shown now. */
    header: () => (ctx.inEpisode() && !state.walk.deleted ? listeningHeader() : walkHeader()),
  }
}
