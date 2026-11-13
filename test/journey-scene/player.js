// See player.html.
;(async function () {
  const q = new URLSearchParams(location.search)
  const themes = {
    dark: { 'editor-background': '#1f1f1f', foreground: '#cccccc', 'editor-foreground': '#ffffff', descriptionForeground: '#9d9d9d', 'widget-border': '#3c3c3c', focusBorder: '#007fd4', 'editorWidget-background': '#252526',
      'editorWarning-foreground': '#cca700', 'list-hoverBackground': '#2a2d2e', 'codeNotes-noteBorder': '#a37acc', 'font-family': 'Inter, system-ui, Ubuntu, sans-serif', 'font-size': '16px', 'editor-font-family': '"JetBrains Mono", monospace' },
    light: { 'editor-background': '#ffffff', foreground: '#3b3b3b', 'editor-foreground': '#1f1f1f', descriptionForeground: '#717171', 'widget-border': '#c8c8c8', focusBorder: '#0090f1', 'editorWidget-background': '#f8f8f8',
      'editorWarning-foreground': '#bf8803', 'list-hoverBackground': '#e8e8e8', 'codeNotes-noteBorder': '#8250df', 'font-family': 'Inter, system-ui, Ubuntu, sans-serif', 'font-size': '16px', 'editor-font-family': '"JetBrains Mono", monospace' },
  }
  const t = themes[q.get('theme') || 'dark']
  for (const k in t) document.documentElement.style.setProperty(`--vscode-${k}`, t[k])
  const j = window.__journey || await (await fetch(q.get('journey'))).json()
  const n = Number(q.get('step') || 1)
  const step = j.steps[n - 1]
  document.getElementById('crumb').textContent = `${j.title} · step ${n} of ${j.steps.length}`
  document.getElementById('title').textContent = step.title
  const video = q.get('play') === '1'
  document.body.classList.toggle('video', video)
  const scene = window.JourneyScene.create({ onBeat: (i) => { window.__beat = i }, height: video ? 450 : 420 })
  document.getElementById('slot').append(scene.el)
  scene.show(step.scene, 'k')
  scene.layout()
  window.__scene = scene
  if (video) setTimeout(() => { scene.restart(); scene.play(() => setTimeout(() => { window.__done = true }, 2600)) }, 900)
})()
