// What goes where at the panel's width: the map beside the storyline (wide) or above it (narrow, foldable under
// "Map"), the step's animation in place of the map, or (while an episode plays) the box alone. Pure: tested in
// test/journeyMapPage.test.ts.
import { JourneyWidths } from '../journey-splitter.js'

/**
 * @typedef {object} LayoutInput
 * @property {number} panelW the panel's width (px)
 * @property {boolean} animReady the current step has an animation and it is switched on
 * @property {boolean} tutorialUp a tutorial card is up (it may point at the map: the map is shown)
 * @property {boolean} deleted the journey's file is gone
 * @property {boolean} mapShut narrow: the reader folded the map away
 * @property {boolean} hasSteps the journey has steps
 * @property {boolean} boxOnly an episode is playing: the map (or the animation) alone, no storyline
 */

/**
 * @typedef {object} Layout
 * @property {boolean} wide the map beside the storyline (else above it)
 * @property {boolean} hasMap the panel has room for the map's boxes
 * @property {boolean} anim the step's animation in place of the map
 * @property {boolean} shown the map (or the animation) is on screen
 */

/** @param {LayoutInput} o @returns {Layout} */
export function layout({ panelW, animReady, tutorialUp, deleted, mapShut, hasSteps, boxOnly }) {
  // The animation plays only when nothing is in front of it.
  const animOnStep = animReady && !tutorialUp && !deleted
  // A card that points at the map shows it at any width.
  const hasMap = JourneyWidths.mapFits(panelW) || tutorialUp
  const anim = animOnStep && hasMap
  // The box alone: no storyline to go beside, nothing to fold.
  if (boxOnly) return { wide: false, hasMap, anim, shown: hasMap }
  const wide = JourneyWidths.besideFits(panelW, animOnStep)
  // Narrow: folded under "Map" by hand, but never while the tutorial points at it, with no steps, or animating.
  const shown = hasMap && (wide || !mapShut || tutorialUp || !hasSteps || anim)
  return { wide, hasMap, anim, shown }
}
