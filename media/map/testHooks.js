// The integration tests' way into the page (src/protocol/map.ts ToMap `test`): a click on an element, a key, run
// through the page's own handlers as a person's would be.

/** @param {{ click?: string, key?: string }} m */
export function runTestMessage(m) {
  if (m.click) {
    const t = document.querySelector(m.click)
    if (t) t.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }
  if (m.key) document.dispatchEvent(new KeyboardEvent('keydown', { key: m.key, bubbles: true }))
}
