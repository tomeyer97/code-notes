// Who wrote a journey and when, as the map says it.

import * as vscode from 'vscode'
import { LoadedJourney } from '../journeys/steps'
import { staleCount } from '../sidebar/listModel'

/** A Claude model id ("claude-fable-5-2") or alias ("fable"): group 1 (an id) or 2 (an alias) is its family. */
const CLAUDE_MODEL = /^(?:claude-([a-z]+)\b|([a-z]+)$)/i

/** How a model id reads: a Claude model by its family ("Fable" for "claude-fable-5-2" and for "fable"); another
 *  agent's id as written ("gpt-5"); '' when the model is unknown. */
function modelName(model?: string): string {
  if (!model) return ''
  const m = CLAUDE_MODEL.exec(model)
  const family = m?.[1] ?? m?.[2]
  return family ? family[0].toUpperCase() + family.slice(1) : model
}

/** "11 Nov" (this year), "11 Nov 2025" (another year), from the journey's own date, in VS Code's display language. */
function shortDate(at: string | undefined, locale: string | undefined): string {
  const t = Date.parse(at ?? '')
  if (!t) return ''
  const d = new Date(t)
  const year = d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' as const } : {}
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short', ...year })
}

/**
 * The map's one provenance line: who wrote it and when, from the journey's own `model` and `createdAt` (not
 * the file's date: a fresh clone is not "today"). No "n commits behind": staleness shows per step (changed / gone).
 */
export function provenance(lj: LoadedJourney): { text: string; tip: string; changed: number } {
  const who = modelName(lj.j.model)
  const when = shortDate(lj.j.createdAt, vscode.env.language)
  const text = who ? `Written by ${who}${when ? ` · ${when}` : ''}` : when ? `Written ${when}` : ''
  const tip = [lj.j.model, lj.j.commit ? `commit ${lj.j.commit.slice(0, 10)}` : ''].filter(Boolean).join(' · ')
  return { text, tip, changed: staleCount(lj) }
}
