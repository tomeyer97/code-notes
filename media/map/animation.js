// The step's animation in the panel (journey-scene.js plays it): on and off, placed once it is in the page, and moved
// by the podcast to the beat the voice is on. Who moved it (the reader or the podcast) is said where it is moved:
// the podcast's moves keep the keyboard where it is and are not reported as the reader's.
import { el } from '../common.js'
import { create as createScene } from '../journey-scene.js'
// The web-app actor: adds itself to the scene's actors.
import '../journey-scene-app.js'
import { sceneOf } from './state.js'

/** @param {import('./context.js').PanelContext} ctx @param {{ isHome: () => boolean }} o */
export function makeAnimation(ctx, { isHome }) {
  const { state, post, app } = ctx
  const anim = state.anim
  /** Who is moving the scene to a beat right now (scene.go reports the beat back while it runs). */
  let goingBy = 'reader'

  /** The animation player: one, kept across renders (its beat and its transitions survive them). */
  const scene = createScene({
    onBeat: (i, how) => {
      if (anim.sceneKey) anim.beatAt[anim.sceneKey] = i
      // `user`: moved by the reader (‹ ›, the keys), not shown with the step nor set by the podcast.
      const byReader = how === 'go' && goingBy === 'reader'
      post({ type: 'beat', n: state.walk.cur, i, ...(byReader ? { user: true } : {}) })
    },
    onClose: () => toggle(),
    // At the last beat › walks on, the animation still on.
    onNextStep: () => { anim.focusScene = true; ctx.goStep(state.walk.cur + 1) },
  })

  /** The current step's animation on or off: the row's toggle, the scene's Map and Esc, Ctrl+' P. */
  function toggle() {
    const { journey, cur, deleted } = state.walk
    if (!journey || !cur || !sceneOf(state, cur) || ctx.tutorial.card || deleted || isHome()) return
    anim.on = !anim.on
    if (anim.on) { anim.focusScene = true; ctx.tutorial.dropOffer() }
    ctx.render()
    // Off: the keyboard stays on the row's toggle, where it can start it again.
    if (!anim.on) /** @type {HTMLElement | null} */ (app.querySelector('.animbtn'))?.focus({ preventScroll: true })
  }

  /** The scene's box, in place of the map's. */
  function box() {
    const wrap = el('div', 'mapwrap scnwrap')
    wrap.append(scene.el)
    return wrap
  }

  /** Shows the step's scene once it is in the page (a packet only flies in a laid-out scene). */
  function place() {
    const { journey, cur } = state.walk
    const j = /** @type {import('./state.js').Journey} */ (journey)
    const k = `${j.id}|${cur}`
    const fresh = k !== anim.sceneKey
    anim.sceneKey = k
    scene.layout()
    const still = !!anim.stillAt[k]
    delete anim.stillAt[k]
    scene.show(sceneOf(state, cur), k, { file: j.steps[cur - 1].file, next: cur < j.steps.length, beat: anim.beatAt[k] || 0, still })
    // The podcast moved it: the keyboard stays where it was (Space keeps pausing).
    if ((fresh || anim.focusScene) && anim.movedBy !== 'podcast') scene.focus()
    anim.focusScene = false
    anim.movedBy = 'reader'
  }

  /** No animation on screen any more (layout `L`): the editor's highlight of its beat goes too. */
  function gone(L) {
    if ((L.shown && L.anim) || !anim.sceneKey) return
    anim.sceneKey = ''
    scene.forget()
    post({ type: 'beat', n: 0, i: -1 })
  }

  /**
   * The podcast is on step n, beat i (-1: the step without its animation). Sent before the step opens, so the step
   * comes up on that beat (never its first beat, then a jump); `still`: a seek, the beat is shown without its flight.
   */
  function podcastBeat(m) {
    const { journey, cur } = state.walk
    if (!journey) return
    const k = `${journey.id}|${m.n}`
    const on = m.i >= 0 && !!sceneOf(state, m.n)
    if (on) {
      anim.beatAt[k] = m.i
      if (m.still) anim.stillAt[k] = true
    }
    const was = anim.on
    anim.on = on
    anim.movedBy = 'podcast'
    // Another step: the tour message that follows draws it, and the page scrolls to it.
    if (m.n !== cur) { state.listen.scrollToVoice = true; return }
    if (on && was && anim.sceneKey === k) {
      goingBy = 'podcast'
      try { scene.go(m.i, false, !!m.still) } finally { goingBy = 'reader' }
      delete anim.stillAt[k]
      anim.movedBy = 'reader'
      return
    }
    if (on !== was) ctx.render()
    else anim.movedBy = 'reader'
  }

  /** The scene keeps the keyboard across a re-render (its element is taken out and put back). */
  function keepFocus() {
    if (scene.el.contains(document.activeElement)) anim.focusScene = true
  }

  return { scene, toggle, box, place, gone, podcastBeat, keepFocus }
}
