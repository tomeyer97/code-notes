// A time in seconds as people read it: on the player ("12:47") and in messages ("0:04.4"). Pure.

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
