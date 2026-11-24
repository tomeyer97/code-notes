// How long ago, said two ways: in messages and rows ("5 min ago", "3 h ago"), and in the journey list's age column
// ("today", "3 d", "2 wk"); and a time stamp. Pure.

export const DAY_MS = 86_400_000

/** Seconds per unit, largest first: an age is said in the first unit it reaches. */
const AGE_UNITS: [seconds: number, unit: string][] = [[86400, 'd'], [3600, 'h'], [60, 'min']]

/** How long ago an ISO time was: "just now", "5 min ago", "3 h ago", "2 d ago"; '' for no time. */
export function ago(at?: string, now = Date.now()): string {
  const t = Date.parse(at ?? '')
  if (!t) return ''
  const s = Math.max(0, (now - t) / 1000)
  const unit = AGE_UNITS.find(([secs]) => s >= secs)
  return unit ? `${Math.floor(s / unit[0])} ${unit[1]} ago` : 'just now'
}

/** A journey's age in the list, in whole days at least: "today", "3 d", "2 wk", "5 mo", "2 y"; '' for no time. */
export function ageOf(at: string | undefined, now: number): string {
  const t = at ? Date.parse(at) : NaN
  if (Number.isNaN(t)) return ''
  const d = Math.max(0, Math.floor((now - t) / DAY_MS))
  if (d < 1) return 'today'
  if (d < 14) return `${d} d`
  if (d < 60) return `${Math.floor(d / 7)} wk`
  if (d < 365) return `${Math.floor(d / 30)} mo`
  return `${Math.floor(d / 365)} y`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "3 Nov 14:05" (local time). */
export function stamp(t: number): string {
  const d = new Date(t), p = (n: number) => String(n).padStart(2, '0')
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${p(d.getHours())}:${p(d.getMinutes())}`
}
