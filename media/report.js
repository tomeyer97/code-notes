// What a person would notice on a page, reported to the extension with the page's `rendered`/`story` message: the
// VS Code integration tests read it there (MapPanel.snapshot, CheckViewProvider.state), the harness pages from the
// posted messages. Kept out of common.js: only the pages that report import it.

/**
 * Marks element `e` as one the page's report watches (a page passes `WATCHED` to overflowing()).
 * @template {HTMLElement} E
 * @param {E} e
 * @returns {E}
 */
export function watched(e) {
  e.dataset.watch = ''
  return e
}
/** The selector of the elements watched(). */
export const WATCHED = '[data-watch]'

/**
 * The elements of `selector` in `root` that stick out past the page's right edge, as `describe(e)` says them; and
 * "the page scrolls sideways" when it does.
 * @param {ParentNode} root
 * @param {string} selector
 * @param {(e: Element) => string} describe
 */
export function overflowing(root, selector, describe) {
  const W = document.documentElement.clientWidth
  const out = [...root.querySelectorAll(selector)].filter((e) => e.getBoundingClientRect().right > W + 1).map(describe)
  if (document.documentElement.scrollWidth > W + 1) out.push('the page scrolls sideways')
  return out
}
