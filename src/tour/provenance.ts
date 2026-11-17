// Who wrote a journey and when, as the map says it.

import { LoadedJourney } from '../journeys/steps'
import { staleCount } from '../sidebar/listModel'

/** "Fable" from "claude-fable-5-2"; '' when the model is unknown. */
function modelName(model?: string): string {
  const m = /^(?:claude-)?([a-z]+)/i.exec(model ?? '')
  return m ? m[1][0].toUpperCase() + m[1].slice(1) : ''
}

/** "11 Nov" (this year), "11 Nov 2025" (another year), from the journey's own date. */
function shortDate(at?: string): string {
  const t = Date.parse(at ?? '')
  if (!t) return ''
  const d = new Date(t)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) })
}

/**
 * The map's one provenance line: who wrote it and when, from the journey's own `model` and `createdAt` (not
 * the file's date: a fresh clone is not "today"). No "n commits behind": staleness shows per step (changed / gone).
 */
export function provenance(lj: LoadedJourney): { text: string; tip: string; changed: number } {
  const who = modelName(lj.j.model), when = shortDate(lj.j.createdAt)
  const text = who ? `Written by ${who}${when ? ` · ${when}` : ''}` : when ? `Written ${when}` : ''
  const tip = [lj.j.model, lj.j.commit ? `commit ${lj.j.commit.slice(0, 10)}` : ''].filter(Boolean).join(' · ')
  return { text, tip, changed: staleCount(lj) }
}
