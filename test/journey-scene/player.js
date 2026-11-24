// See player.html. Bundled with the panel's own scene modules by scripts/build/pages.mjs (out/test/journey-scene/).
import { create } from '../../media/journey-scene.js'
// The web-app actor, as in the panel.
import '../../media/journey-scene-app.js'

;(async function () {
  /** ../harness/themes.js Harness: the theme, and what record.mjs reads (journey, beat, scene, done). */
  const H = window.__harness
  const q = new URLSearchParams(location.search)
  // Bigger than the panel, for video; its own fonts and a lighter border.
  const fonts = { 'font-family': 'Inter, system-ui, Ubuntu, sans-serif', 'font-size': '16px', 'editor-font-family': '"JetBrains Mono", monospace' }
  H.applyTheme(
    { dark: { 'widget-border': '#3c3c3c', 'codeNotes-noteBorder': '#a37acc', ...fonts }, light: { 'codeNotes-noteBorder': '#8250df', ...fonts } },
    { without: ['textLink-foreground', 'button-background', 'button-foreground', 'button-hoverBackground', 'badge-background', 'badge-foreground', 'testing-iconPassed', 'toolbar-hoverBackground', 'input-background', 'input-foreground', 'input-border', 'input-placeholderForeground'] },
  )
  const j = H.journey || await (await fetch(q.get('journey'))).json()
  const n = Number(q.get('step') || 1)
  const step = j.steps[n - 1]
  document.getElementById('crumb').textContent = `${j.title} · step ${n} of ${j.steps.length}`
  document.getElementById('title').textContent = step.title
  const video = q.get('play') === '1'
  document.body.classList.toggle('video', video)
  const scene = create({ onBeat: (i) => { H.beat = i }, height: video ? 450 : 420 })
  document.getElementById('slot').append(scene.el)
  scene.show(step.scene, 'k')
  scene.layout()
  H.scene = scene
  if (video) setTimeout(() => { scene.restart(); scene.play(() => setTimeout(() => { H.done = true }, 2600)) }, 900)
})()
