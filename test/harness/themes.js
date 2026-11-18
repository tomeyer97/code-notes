// What a page outside VS Code needs to look and talk like a webview: VS Code's theme variables (?theme=dark|light)
// and a stub of acquireVsCodeApi. Loaded by the harness pages: journey-map/harness.html (the journey panel),
// check-panel/harness.html (the Check view) and journey-scene/player.html (an animation, for videos).
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

  /** The page's theme, from ?theme= (dark by default). */
  window.themeName = () => new URLSearchParams(location.search).get('theme') || 'dark'

  /**
   * Sets VS Code's --vscode-* variables of the page's theme on <html>: `overrides[theme]` replace some of them; the
   * variables named in `without` are left unset.
   */
  window.applyTheme = (overrides = {}, { without = [] } = {}) => {
    const name = window.themeName()
    const t = { ...themes[name], ...(overrides[name] || {}) }
    for (const k in t) if (!without.includes(k)) document.documentElement.style.setProperty(`--vscode-${k}`, t[k])
  }

  /**
   * acquireVsCodeApi as the page gets it in a webview: messages it posts land in window.__posted (the error reports
   * also in window.__errors); with `keepState`, getState returns what setState stored, else nothing is kept.
   */
  window.stubVsCodeApi = ({ keepState = false } = {}) => {
    window.__posted = []
    window.__errors = []
    window.acquireVsCodeApi = () => ({
      postMessage: (m) => {
        window.__posted.push(m)
        if (m.type === 'error') window.__errors.push(m)
      },
      getState: () => (keepState ? window.__state : undefined),
      setState: (s) => { if (keepState) window.__state = s },
    })
  }
})()
