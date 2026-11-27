// The panel context: what the parts of the journey panel (header, storyline, chapters, animation, scroll) are given,
// instead of reaching into journey-map.js's variables. journey-map.js makes the one context and fills it before the
// first message arrives.

/**
 * @typedef {object} PanelContext
 * @property {import('./state.js').PanelState} state everything the panel keeps between renders
 * @property {HTMLElement} app the element the panel is drawn in
 * @property {(m: import('../../src/protocol/map').FromMap) => void} post a message to the extension
 * @property {() => void} render the whole panel again from the state
 * @property {() => void} saveState what the webview keeps over a reload, kept now
 * @property {(n: number) => void} goStep walks to step n (not under the tutorial, not when deleted)
 * @property {() => void} goHome the Journeys list in front
 * @property {() => boolean} inEpisode an episode is on: playing, or paused before its end
 * @property {() => void} toggleAnim the current step's animation on or off
 * @property {any} scene the animation player (journey-scene.js), one kept across renders
 * @property {any} podcast the panel's podcast player (journey-podcast.js)
 * @property {ReturnType<typeof import('../journey-tutorial.js').JourneyTutorial>} tutorial
 */

/** Marks an element as something the tutorial may point at or must not cover (journey-tutorial.js TARGETS). */
export function tutorialTarget(e, name) {
  e.dataset.tutorial = name
  return e
}
