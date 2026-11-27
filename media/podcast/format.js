// The player's words for times and speeds. `clock` is the extension's own (src/core/format/podcast/model.ts), so the
// player and the extension print a time the same way.
import { clock } from '../../src/core/format/podcast/model'
import { CYCLE, RATES } from './constants.js'

export { clock }

/** "11 minutes 59 seconds": a time as a screen reader should say it. */
export function spoken(t) {
  const s = Math.max(0, Math.floor(t || 0))
  const m = Math.floor(s / 60), r = s % 60
  const unit = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`
  return m ? `${unit(m, 'minute')}${r ? ` ${unit(r, 'second')}` : ''}` : unit(r, 'second')
}

/** "1.25×" */
export const rateText = (r) => `${r}×`

/** The speed after `r` on the speed button: the next usual one up, from 2× back to 1×. */
export const nextRate = (r) => CYCLE.find((x) => x > r + 0.001) || CYCLE[0]

/** The speed one step slower (dir -1) or faster (1) than `r` (< >), kept inside RATES; from an unusual speed, 1×'s. */
export function stepRate(r, dir) {
  const i = RATES.indexOf(r)
  return RATES[Math.max(0, Math.min(RATES.length - 1, (i < 0 ? 1 : i) + dir))]
}

/** `r` when it is one of the player's speeds, else 1×. */
export const knownRate = (r) => (RATES.includes(r) ? r : 1)
