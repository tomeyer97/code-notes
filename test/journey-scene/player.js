// See player.html.
;(async function () {
  const q = new URLSearchParams(location.search)
  // Bigger than the panel, for video; its own fonts and a lighter border.
  const fonts = { 'font-family': 'Inter, system-ui, Ubuntu, sans-serif', 'font-size': '16px', 'editor-font-family': '"JetBrains Mono", monospace' }
  applyTheme(
    { dark: { 'widget-border': '#3c3c3c', 'codeNotes-noteBorder': '#a37acc', ...fonts }, light: { 'codeNotes-noteBorder': '#8250df', ...fonts } },
    { without: ['textLink-foreground', 'button-background', 'button-foreground', 'button-hoverBackground', 'badge-background', 'badge-foreground', 'testing-iconPassed', 'toolbar-hoverBackground', 'input-background', 'input-foreground', 'input-border', 'input-placeholderForeground'] },
  )
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
