// Times as people read them: on the podcast player ("12:47", "0:04.4", in seconds) and while an agent works
// ("1:05", "2 min", elapsed milliseconds). Pure.

/** m:ss (h:mm:ss past an hour). */
export function clock(t: number): string {
  const s = Math.max(0, Math.floor(t))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  const mm = h ? String(m).padStart(2, '0') : String(m)
  return `${h ? `${h}:` : ''}${mm}:${String(r).padStart(2, '0')}`
}

/** m:ss.s: a time in a message, precise enough to find the segment. */
export function clockMs(t: number): string {
  const tenths = Math.round(t * 10) / 10
  const whole = Math.floor(tenths)
  const frac = Math.round((tenths - whole) * 10)
  return frac ? `${clock(whole)}.${frac}` : clock(whole)
}

/** Elapsed milliseconds as minutes and seconds, "1:05" (minutes keep counting past an hour). */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** "2 min" / "under a minute", for the notice when an agent is done. */
export function minutes(ms: number): string {
  const m = Math.round(ms / 60000)
  return m < 1 ? 'under a minute' : `${m} min`
}
