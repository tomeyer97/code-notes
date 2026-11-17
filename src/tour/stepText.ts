// A step card's text (lead, details, references, the stale banner): the same for the inline card and the panel.
// Pure: everything it reads is passed in (no vscode at run time), so it is unit-tested.
import type { LoadedJourney } from '../journeys'
import { linkPaths } from '../journeyModel'
import { readLinks } from '../codeLinkText'

/** A link in a step's text: where it goes now (renames, moved lines), and how it reads. */
export interface StepRef { label: string; file: string; line: number; end: number; gone: boolean; stale: boolean }

/** What a step's text depends on besides the journey: renamed files, files/lines found gone, the details shown. */
export interface StepTextInput {
  /** Renamed files (old path -> new path) the journey's steps followed. */
  renames: Map<string, string>
  /** Referenced files that don't exist (`<folder uri>|<path>`). */
  refGone: Set<string>
  /** Line counts of referenced files that do (`<folder uri>|<path>` -> lines). */
  refLines: Map<string, number>
  /** The card's details ("More") are open: what they link is not listed again under them. */
  detailsOpen: boolean
}

/** The journey as far as its text needs it. */
export type TextJourney = Pick<LoadedJourney, 'j' | 'at'> & { folder: { uri: { toString(): string } } }

const fileOf = (lj: TextJourney, n: number) => lj.at[n - 1]?.file ?? lj.j.steps[n - 1].file

/** What a stale step's card says first: gone, removed, or what changed, and one thing to do. `fileGone`: the step's own file is gone. */
export function staleText(lj: TextJourney, n: number, ask: string, fileGone: boolean): string {
  // One line: what is known, and the one thing to do. The git gutter shows what changed.
  const at = lj.at[n - 1]
  // Never "gone" for code that was only edited or moved (it read as "the feature was removed").
  if (fileGone) return `**⚠ File moved or deleted** · ${ask}`
  if (!at.stale) return ''
  return `**⚠ ${at.removed || at.was === undefined ? 'Code changed: can\'t find these lines' : 'Code changed'}** · ${ask}`
}

/**
 * A step's text, the same for the inline card and the panel: `link` makes each reference a link (a command URI
 * inline, `ref:i` in the panel).
 */
export function stepText(lj: TextJourney, n: number, link: (r: StepRef) => string, input: StepTextInput): { lead: string; details: string; refs: string; stale: boolean } {
  const { renames: moved, refGone, refLines, detailsOpen: stepDetailsOpen } = input
  const s = lj.j.steps[n - 1]
  const at = lj.at[n - 1]
  // Lines in the step's own file move with it. A stale step's refs are judged on their own: its lost
  // lines move nothing, and only a ref whose file or line is gone is marked.
  const delta = at.stale ? 0 : at.start - s.range.start
  const make = (text: string, file0: string, line: number, end?: number) => {
    // A renamed file: the link follows it and says so; a file that is gone: struck out, not a dead link.
    const file = moved.get(file0) ?? file0
    const same = file === fileOf(lj, n)
    const shown = same ? Math.max(1, line + delta) : line
    let label = same && delta ? text.replace(/:(\d+)(?:([-–])(\d+))?$/, (_m, a: string, d?: string, b?: string) => `:${Math.max(1, +a + delta)}${d ? `${d}${Math.max(1, +b! + delta)}` : ''}`) : text
    if (file !== file0) label = `${label.replace(file0, file).replace(file0.split('/').pop()!, file.split('/').pop()!)} (moved)`
    // A reference reads as `env.go:405`: the file's name; the whole path is the link's hover.
    label = label.replace(/(?:[\w.-]+\/)+([\w.-]+\.[a-zA-Z]{1,6})/g, '$1')
    const k = `${lj.folder.uri}|${file}`
    if (refGone.has(k) || (refLines.get(k) ?? Infinity) < shown) return `~~${text.replace(/[[\]]/g, '').replace(/(?:[\w.-]+\/)+([\w.-]+\.[a-zA-Z]{1,6})/g, '$1')}~~ (${refGone.has(k) ? 'file' : 'line'} gone)`
    // One stale marker per step, the card's banner: no ⚠ on its links.
    return link({ label, file, line: shown, end: Math.max(shown, (end ?? line) + (same ? delta : 0)), gone: false, stale: false })
  }
  const rangeEnd = (t: string) => { const m = /[-–](\d+)`?$/.exec(t); return m ? Number(m[1]) : undefined }
  const paths = (t: string) => linkPaths(t, (text, file, line) => make(text, file, line, rangeEnd(text)))
  // No "(path:line)" asides in More: those places are the references, listed once under it.
  const details = (s.details ?? '').replace(/\s*\(`?(?:[\w.-]+\/)*[\w.-]+\.[a-zA-Z]{1,6}(?::\d+(?:[-–]\d+)?|#L\d+)`?\)/g, '')
  // Each file named once: no ref to the lines already on screen, none the open details already link.
  const inDetails = new Set<string>()
  if (stepDetailsOpen && details) linkPaths(details, (_t, file, line) => { inDetails.add(`${file}:${line}`); return '' })
  // A ref inside a code link's lines repeats that link: the phrase on the card already goes there.
  const text = `${s.lead ?? ''}\n${s.details ?? ''}`
  const linked = readLinks(s.links).filter((l) => text.includes(l.phrase)).map((l) => ({ ...l, file: moved.get(l.file) ?? l.file }))
  const inLink = (file: string, line: number) => !!line && linked.some((l) => l.file === (moved.get(file) ?? file) && line >= l.start && line <= l.end)
  const onScreen = (file: string, line: number) => (line && inDetails.has(`${file}:${line}`)) || inLink(file, line) || (line && (moved.get(file) ?? file) === fileOf(lj, n) && !at.stale && line + delta >= at.start && line + delta <= at.end)
  // A ref is a bare `path:line` (listed with ' · '), or an explained sentence holding one such token:
  // the sentence as written, its token a link reading `main.go:371` (the whole path on hover).
  const isSentence = (r: string) => /\s/.test(r.trim())
  const plainRefs = s.refs.filter((r) => !isSentence(r)).map((r) => /^(.*?)(?::(\d+))?(?:[-–](\d+))?$/.exec(r)!).filter((m) => !onScreen(m[1], Number(m[2]) || 0))
    .map((m) => make(`${m[1].split('/').pop()}${m[2] ? `:${m[2]}` : ''}`, m[1], Number(m[2]) || 1, m[3] ? Number(m[3]) : undefined)).join(' · ')
  const sentences = s.refs.filter(isSentence).filter((r) => { let keep = true; linkPaths(r, (_t, file, line) => { if (onScreen(file, line)) keep = false; return '' }); return keep })
    .map((r) => paths(r.trim()))
  const refs = [plainRefs, ...sentences].filter(Boolean).join('\n\n')
  // No recap on the last step: the map's header has the question.
  return { lead: s.lead ? paths(s.lead) : '', details: details ? paths(details) : '', refs, stale: at.stale }
}
