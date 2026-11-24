// "Claude asks": what media/clarify.js posts to src/write/clarify.ts. The extension sends it nothing (the page is
// made with Claude's question in it).

/** What the page posts: the answer (Send or Ctrl+Enter, with something typed); a script error on the page. */
export type FromClarify =
  | { type: 'reply'; text: string }
  | { type: 'error'; text: string }

/** Nothing goes to the page. */
export type ToClarify = never
