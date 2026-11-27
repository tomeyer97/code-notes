// What a page outside VS Code needs to look and talk like a webview: VS Code's theme variables (?theme=dark|light)
// and a stub of acquireVsCodeApi. Loaded by the harness pages: journey-map/harness.html (the journey panel),
// check-panel/harness.html (the Check view), journey-podcast/listen.html (the Listen view) and
// journey-scene/player.html (an animation, for videos); each then loads its page's bundle from out/pages/, the same
// file the extension loads.
//
// Everything the harness pages and the shoot scripts share in a page is one object, window.__harness (Harness below);
// contrast.js and journey-map/layoutChecks.js add their helpers to it.
/**
 * @typedef {object} Harness
 * @property {() => string} themeName  the page's theme, from ?theme= (dark by default)
 * @property {(overrides?: object, o?: { without?: string[] }) => void} applyTheme  VS Code's --vscode-* variables
 * @property {(o?: { keepState?: boolean }) => void} stubVsCodeApi  acquireVsCodeApi as a webview has it
 * @property {object[]} posted  every message the page posted
 * @property {object[]} errors  the `error` messages among them
 * @property {unknown} state  what the page kept with setState (with keepState)
 * @property {((m: object) => void) | undefined} onPost  a harness playing the extension's part answers here
 * @property {object | undefined} journey  the journey a check is about (the layout rules, the scene player)
 * @property {object} [contrast]  WCAG contrast helpers (contrast.js)
 * @property {(wantCurrent: boolean) => string[]} [mapLayoutProblems]  the journey panel's layout rules (layoutChecks.js)
 * @property {object} [scene]  the scene player's scene (journey-scene/player.js)
 * @property {number} [beat]  the beat it shows
 * @property {boolean} [done]  a video's scene played to its end
 */
// One table for all of them: a page that starts using a new --vscode-* variable gets it here. Where a page wants
// other values it passes them to applyTheme (the check view's links are VS Code's Modern ones; the player is bigger,
// for video), and it names the variables it leaves unset (each page has always set only some; setting the others
// changes its pictures).
;(function () {
  const themes = {
    dark: {
      'editor-background': '#1f1f1f', 'editor-foreground': '#ffffff', foreground: '#cccccc', descriptionForeground: '#9d9d9d',
      'widget-border': '#454545', focusBorder: '#007fd4', 'editorWidget-background': '#252526',
      'textLink-foreground': '#3794ff', 'button-background': '#0e639c', 'button-foreground': '#ffffff', 'button-hoverBackground': '#1177bb',
      'badge-background': '#616161', 'badge-foreground': '#f8f8f8', 'editorWarning-foreground': '#cca700', 'list-hoverBackground': '#2a2d2e',
      'testing-iconPassed': '#73c991', 'toolbar-hoverBackground': '#5a5d5e50',
      'input-background': '#313131', 'input-foreground': '#cccccc', 'input-border': '#3c3c3c', 'input-placeholderForeground': '#989898',
      'codeNotes-noteBorder': '#a371f7aa',
      'font-family': 'system-ui, Ubuntu, sans-serif', 'font-size': '13px', 'editor-font-family': 'monospace',
    },
    light: {
      'editor-background': '#ffffff', 'editor-foreground': '#1f1f1f', foreground: '#3b3b3b', descriptionForeground: '#717171',
      'widget-border': '#c8c8c8', focusBorder: '#0090f1', 'editorWidget-background': '#f8f8f8',
      'textLink-foreground': '#006ab1', 'button-background': '#007acc', 'button-foreground': '#ffffff', 'button-hoverBackground': '#0062a3',
      'badge-background': '#c4c4c4', 'badge-foreground': '#333333', 'editorWarning-foreground': '#bf8803', 'list-hoverBackground': '#e8e8e8',
      'testing-iconPassed': '#388a34', 'toolbar-hoverBackground': '#b8b8b850',
      'input-background': '#ffffff', 'input-foreground': '#3b3b3b', 'input-border': '#cecece', 'input-placeholderForeground': '#767676',
      'codeNotes-noteBorder': '#8250dfcc',
      'font-family': 'system-ui, Ubuntu, sans-serif', 'font-size': '13px', 'editor-font-family': 'monospace',
    },
  }

  /** @type {Harness} */
  const H = (window.__harness = window.__harness || {})

  /** The page's theme, from ?theme= (dark by default). */
  H.themeName = () => new URLSearchParams(location.search).get('theme') || 'dark'

  /**
   * Sets VS Code's --vscode-* variables of the page's theme on <html>: `overrides[theme]` replace some of them; the
   * variables named in `without` are left unset.
   */
  H.applyTheme = (overrides = {}, { without = [] } = {}) => {
    const name = H.themeName()
    const t = { ...themes[name], ...(overrides[name] || {}) }
    for (const k in t) if (!without.includes(k)) document.documentElement.style.setProperty(`--vscode-${k}`, t[k])
  }

  /**
   * acquireVsCodeApi as the page gets it in a webview: messages it posts land in __harness.posted (the error reports
   * also in __harness.errors); with `keepState`, getState returns what setState stored, else nothing is kept.
   */
  H.stubVsCodeApi = ({ keepState = false } = {}) => {
    H.posted = []
    H.errors = []
    window.acquireVsCodeApi = () => ({
      postMessage: (m) => {
        H.posted.push(m)
        if (m.type === 'error') H.errors.push(m)
        // A harness playing the extension's part answers here (test/journey-podcast/shoot.mjs).
        if (H.onPost) H.onPost(m)
      },
      getState: () => (keepState ? H.state : undefined),
      setState: (s) => { if (keepState) H.state = s },
    })
  }
})()
