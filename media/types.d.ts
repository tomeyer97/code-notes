// Types the pages' scripts share (JSDoc: `import('./types').Port<FromMap>`). The messages themselves are
// src/protocol/: one union each way per page.

/** What acquireVsCodeApi() gives a page: messages to the extension and the page's state, kept while it is hidden. */
export interface VsCodeApi {
  postMessage(m: unknown): void
  getState(): any
  setState(s: unknown): void
}

/** A page's end of its messages: VS Code's API, and `post` for what the page sends (`Out`, its protocol's union). */
export interface Port<Out> {
  vscode: VsCodeApi
  post(m: Out): void
}

/** One handler per message type the extension sends (`In`). */
export type Handlers<In extends { type: string }> = { [T in In['type']]: (m: Extract<In, { type: T }>) => void }

declare global {
  /** VS Code's API for a webview page; call it once. */
  function acquireVsCodeApi(): VsCodeApi
  interface Window {
    /** The map's layout library (out/vendor/elk.bundled.js), a script of its own before the map's bundle: bundled,
     *  esbuild would print its 1.6 MB of minified code out at twice the size. */
    ELK: typeof import('elkjs/lib/elk.bundled.js').default
  }
}
