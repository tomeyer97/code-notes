// The player's keys anywhere in its page: one table, each key with where it may act. Space and K play and pause,
// M mutes, < > change the speed, ← → skip and Shift+← → go a step (K, M, < >: unadvertised). K and M go by the key's
// place (Caps Lock, any layout); the others by the character.
import { SKIP_S } from './constants.js'

/** Elements a press of Space would activate. */
const CONTROL = 'button, a, [role="button"], [role="link"], summary'

/**
 * What the keys act on.
 * @typedef {object} KeyActions
 * @property {() => void} toggle
 * @property {() => void} toggleMute
 * @property {(dir: number) => void} speed  one speed slower (-1) or faster (1)
 * @property {(by: number) => void} skip
 * @property {(dir: number) => void} part
 */

/**
 * Where a key is pressed: its event, whether its target is in the player, and the control last pressed with the
 * pointer (it keeps the focus, but not Space).
 * @typedef {{ e: KeyboardEvent, target: HTMLElement | null, inPlayer: boolean, clicked: Element | undefined }} KeyPlace
 */

/** Where a key may act. */
const when = {
  always: () => true,
  /** K and M: not with Shift. */
  unshifted: (/** @type {KeyPlace} */ k) => !k.e.shiftKey,
  /** Space: not on a button the keyboard went to (Tab: it presses that button). One clicked with the mouse doesn't
   *  keep Space: after a beat's ‹ › clicked, Space pauses, it doesn't step back again. */
  notOnTabbedControl: (/** @type {KeyPlace} */ k) => {
    const control = k.target && k.target.closest && k.target.closest(CONTROL)
    return !control || control === k.clicked
  },
  /** ← →: in the player, or with nothing focused (the animation and the map keep their own arrows). */
  inPlayerOrNothingFocused: (/** @type {KeyPlace} */ k) =>
    k.inPlayer || !k.target || k.target === document.body || k.target === document.documentElement,
}

/** @type {{ code?: string, key?: string, when: (k: KeyPlace) => boolean, run: (a: KeyActions, e: KeyboardEvent) => void }[]} */
export const KEYMAP = [
  { code: 'KeyK', when: when.unshifted, run: (a) => a.toggle() },
  { code: 'KeyM', when: when.unshifted, run: (a) => a.toggleMute() },
  { key: ' ', when: when.notOnTabbedControl, run: (a) => a.toggle() },
  { key: '<', when: when.always, run: (a) => a.speed(-1) },
  { key: '>', when: when.always, run: (a) => a.speed(1) },
  { key: 'ArrowLeft', when: when.inPlayerOrNothingFocused, run: (a, e) => (e.shiftKey ? a.part(-1) : a.skip(-SKIP_S)) },
  { key: 'ArrowRight', when: when.inPlayerOrNothingFocused, run: (a, e) => (e.shiftKey ? a.part(1) : a.skip(SKIP_S)) },
]

/** Typing in a field: the keys are the field's. */
const typing = (t) => !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)

/**
 * The table on the document while the player has an episode (`active`); a key it runs goes no further.
 * @param {HTMLElement} root  the player
 * @param {() => boolean} active
 * @param {KeyActions} actions
 * @param {AbortSignal} signal
 */
export function bindKeys(root, active, actions, signal) {
  /** @type {Element | undefined} the control last pressed with the pointer; Tab forgets it */
  let clicked
  document.addEventListener('pointerdown', (e) => {
    const t = /** @type {HTMLElement | null} */ (e.target)
    clicked = (t && t.closest && t.closest(CONTROL)) || undefined
  }, { capture: true, signal })
  document.addEventListener('keydown', (e) => { if (e.key === 'Tab') clicked = undefined }, { capture: true, signal })
  document.addEventListener('keydown', (e) => {
    if (!active() || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
    const target = /** @type {HTMLElement | null} */ (e.target)
    if (typing(target)) return
    const place = { e, target, inPlayer: root.contains(target), clicked }
    const entry = KEYMAP.find((k) => (k.code ? k.code === e.code : k.key === e.key) && k.when(place))
    if (!entry) return
    e.preventDefault()
    e.stopPropagation()
    entry.run(actions, e)
  }, { signal })
}
