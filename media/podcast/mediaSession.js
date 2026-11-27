// The Media Session: headphone keys and the system's "now playing" (the host's only; the position is the host's
// own, players.js mediaPosition).
import { SKIP_S } from './constants.js'

/** The keys' actions, while the page lives (`signal`). */
export function mediaKeys(a, signal) {
  if (!('mediaSession' in navigator)) return
  const on = (name, f) => { try { navigator.mediaSession.setActionHandler(name, f) } catch { /* not supported */ } }
  on('play', () => a.play())
  on('pause', () => a.pause())
  on('seekbackward', () => a.skip(-SKIP_S))
  on('seekforward', () => a.skip(SKIP_S))
  on('previoustrack', () => a.part(-1))
  on('nexttrack', () => a.part(1))
  on('seekto', (d) => { if (d && typeof d.seekTime === 'number') a.seek(d.seekTime) })
  signal.addEventListener('abort', () => {
    for (const name of ['play', 'pause', 'seekbackward', 'seekforward', 'previoustrack', 'nexttrack', 'seekto']) on(name, null)
  })
}

/** "Now playing": the part (or the episode), the journey, Code Notes; set again only when the part changes. */
export function nowPlaying() {
  let key = ''
  return (ep, ci, name) => {
    if (!ep || !('mediaSession' in navigator)) return
    const k = `${ep.key}|${ci}`
    if (k === key) return
    key = k
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: ci >= 0 ? name : ep.title, artist: ep.journey || ep.title, album: 'Code Notes' })
    } catch { /* not in this runtime */ }
  }
}
