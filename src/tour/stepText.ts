// A step card's text (lead, details, references, the stale banner): the same for the inline card and the panel.
// Pure: everything it reads is passed in (no vscode at run time), so it is unit-tested.
//
// Four small steps, each its own function: parse the places the text names (once, into `Ref`s), relocate each to
// where it is now (`relocate`), drop the refs already on screen (`onScreen`), and say each as a link or a struck-out
// name (`label`). `stepText` composes them.
import { fileOf, LoadedJourney } from '../journeys/steps'
import type { JStep } from '../journeyModel'
import { readLinks } from '../journeyModel'
import { DIR, FILE_NAME, REF_IN_TEXT } from '../journeys/textFormat'
import { baseName } from '../paths'

/** A link in a step's text: where it goes now (renames, moved lines), and how it reads. */
export interface StepRef { label: string; file: string; line: number; end: number; gone: boolean; stale: boolean }

/** A step card's text: the lead, the details (More), the references listed under them, and whether it is stale. */
export interface StepText { lead: string; details: string; refs: string; stale: boolean }

/** What is known about the files a step's text names: renamed, gone, or how long. */
export interface RefFacts {
  /** Renamed files (old path -> new path) the journey's steps followed. */
  renames: Map<string, string>
  /** Referenced files that don't exist (`<folder uri>|<path>`). */
  refGone: Set<string>
  /** Line counts of referenced files that do (`<folder uri>|<path>` -> lines). */
  refLines: Map<string, number>
}

/** What a step's text depends on besides the journey: the facts about its files, and whether the details show. */
export interface StepTextInput extends RefFacts {
  /** The card's details ("More") are open: what they link is not listed again under them. */
  detailsOpen: boolean
}

/** The journey as far as its text needs it. */
export type TextJourney = Pick<LoadedJourney, 'j' | 'at'> & { folder: { uri: { toString(): string } } }

// ---------- parse: the places a step's text names ----------

/** A place named in a step's text, as written: `text` is how it reads (`src/a.ts:40-42`), `line` 0 when none is written. */
export interface Ref { text: string; file: string; line: number; end?: number }

/** `api/orders.go` -> `orders.go`, wherever a path is in `t`. */
const SHORT_PATHS = new RegExp(`(?:${DIR})+(${FILE_NAME})`, 'g')
export const shortPaths = (t: string) => t.replace(SHORT_PATHS, '$1')
/** A "(path:line)" aside (the folders may be left out), with the space before it. */
const ASIDE = new RegExp(`\\s*\\(\`?(?:${DIR})*${FILE_NAME}(?::\\d+(?:[-–]\\d+)?|#L\\d+)\`?\\)`, 'g')
export const dropAsides = (t: string) => t.replace(ASIDE, '')

/** The `-b` of `path:a-b` (the range's end), if written. */
const rangeEnd = (t: string) => { const m = /[-–](\d+)`?$/.exec(t); return m ? Number(m[1]) : undefined }

/** Each place `t` names (REF_IN_TEXT), replaced with what `f` makes of it. */
export function mapRefs(t: string, f: (r: Ref) => string): string {
  return t.replace(REF_IN_TEXT, (m: string, file: string, l1?: string, l2?: string) => {
    const text = m.replace(/`/g, '')
    return f({ text, file, line: Number(l1 ?? l2) || 1, end: rangeEnd(text) })
  })
}
/** The places `t` names. */
export function refsIn(t: string): Ref[] {
  const out: Ref[] = []
  mapRefs(t, (r) => { out.push(r); return '' })
  return out
}

/** A ref is a bare `path:line` (listed with ' · '), or an explained sentence holding such tokens. */
export const isSentence = (r: string) => /\s/.test(r.trim())
/** A bare ref, `path[:line[-end]]` or `path#Lline`: it reads as the file's name and its lines as written. */
export function parseBare(r: string): Ref {
  const m = /^(.*?)(?::(\d+)(?:[-–](\d+))?|#L(\d+))?$/.exec(r)!
  const text = `${baseName(m[1])}${r.slice(m[1].length)}`
  return { text, file: m[1], line: Number(m[2] ?? m[4]) || 0, ...(m[3] ? { end: Number(m[3]) } : {}) }
}

/** Every file a step's text names (its refs, lead and details), as written: the ones to check exist. */
export function refFiles(s: Pick<JStep, 'refs' | 'lead' | 'details'>): Set<string> {
  const files = new Set<string>()
  for (const r of s.refs) if (!isSentence(r)) files.add(parseBare(r).file)
  for (const t of [...s.refs, s.lead, s.details ?? '']) for (const r of refsIn(t)) files.add(r.file)
  return files
}

// ---------- relocate: where a ref is now ----------

/** Where the step is now, against where it was written, and the facts about the files its text names. */
export interface Here extends RefFacts {
  /** The folder the journey is in (the key prefix of `refGone` / `refLines`). */
  folder: string
  /** The step's file now (renamed or not). */
  stepFile: string
  /** How far the step's lines moved (0 when stale: its lost lines move nothing). */
  delta: number
}

/** A ref where it is now: its file (renamed), its lines (moved with the step in the step's own file), or why it is gone. */
export interface Placed { file: string; line: number; end: number; same: boolean; gone?: 'file' | 'line' }

export function relocate(ref: Ref, here: Here): Placed {
  // A renamed file: the link follows it. Lines in the step's own file move with it.
  const file = here.renames.get(ref.file) ?? ref.file
  const same = file === here.stepFile
  const at = ref.line || 1
  const line = same ? Math.max(1, at + here.delta) : at
  const end = Math.max(line, (ref.end ?? at) + (same ? here.delta : 0))
  const k = `${here.folder}|${file}`
  const gone = here.refGone.has(k) ? 'file' : (here.refLines.get(k) ?? Infinity) < line ? 'line' : undefined
  return { file, line, end, same, ...(gone ? { gone } : {}) }
}

// ---------- label: how a ref reads ----------

/** `text` with its `:a-b` or `#La` moved by `delta`. */
const shiftLines = (text: string, delta: number) =>
  text.replace(/(:|#L)(\d+)(?:([-–])(\d+))?$/, (_m, at: string, a: string, d?: string, b?: string) =>
    `${at}${Math.max(1, +a + delta)}${d ? `${d}${Math.max(1, +b! + delta)}` : ''}`)

/** `ref` as it reads at `place`: its line moved with the step, a renamed file's new name. */
function placedText(ref: Ref, place: Placed, delta: number): string {
  const t = place.same && delta ? shiftLines(ref.text, delta) : ref.text
  return place.file === ref.file ? t : t.replace(ref.file, place.file).replace(baseName(ref.file), baseName(place.file))
}

/**
 * How a ref reads: `env.go:405` (the file's name; the whole path is the link's hover), its line moved with the step,
 * "(moved)" after a renamed file. A gone one is struck out, with why: not a dead link. It reads as the place that was
 * looked for (a renamed file's new name, the line moved with the step): that is what is gone.
 */
export function label(ref: Ref, place: Placed, delta: number): string {
  const t = shortPaths(placedText(ref, place, delta))
  if (place.gone) return `~~${t.replace(/[[\]]/g, '')}~~ (${place.gone} gone)`
  return place.file === ref.file ? t : `${t} (moved)`
}

// ---------- dedupe: what is on screen already ----------

/**
 * What the card already shows, so its refs don't repeat it: places the open details link (as written), and spans of
 * lines (current file, lines as written): the code links' and the step's own.
 */
export interface Shown { details: Set<string>; spans: { file: string; start: number; end: number }[] }

/** Is the place `ref` names on screen? A ref with no line never is. */
export function onScreen(ref: Ref, shown: Shown, renames: Map<string, string>): boolean {
  if (!ref.line) return false
  const file = renames.get(ref.file) ?? ref.file
  return shown.details.has(`${ref.file}:${ref.line}`) || shown.spans.some((s) => s.file === file && ref.line >= s.start && ref.line <= s.end)
}

/** What step n's card shows of its own: the open details' places, its code links' lines, its own lines (unless stale). */
export function shownBy(lj: TextJourney, n: number, details: string, input: StepTextInput, delta: number): Shown {
  const s = lj.j.steps[n - 1], at = lj.at[n - 1], moved = input.renames
  const shown: Shown = { details: new Set(input.detailsOpen && details ? refsIn(details).map((r) => `${r.file}:${r.line}`) : []), spans: [] }
  // A ref inside a code link's lines repeats that link: the phrase on the card already goes there.
  const text = `${s.lead ?? ''}\n${s.details ?? ''}`
  for (const l of readLinks(s.links)) if (text.includes(l.phrase)) shown.spans.push({ file: moved.get(l.file) ?? l.file, start: l.start, end: l.end })
  // The step's own lines, back in the coordinates its text was written in.
  if (!at.stale) shown.spans.push({ file: fileOf(lj, n), start: at.start - delta, end: at.end - delta })
  return shown
}

// ---------- the card's text ----------

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
 * inline, `ref:i` in the panel). Each file is named once: no ref to lines already on screen.
 */
export function stepText(lj: TextJourney, n: number, link: (r: StepRef) => string, input: StepTextInput): StepText {
  const s = lj.j.steps[n - 1], at = lj.at[n - 1]
  // A stale step's refs are judged on their own: its lost lines move nothing.
  const delta = at.stale ? 0 : at.start - s.range.start
  const here: Here = { ...input, folder: `${lj.folder.uri}`, stepFile: fileOf(lj, n), delta }
  // One stale marker per step, the card's banner: no ⚠ on its links.
  const say = (r: Ref) => {
    const p = relocate(r, here)
    return p.gone ? label(r, p, delta) : link({ label: label(r, p, delta), file: p.file, line: p.line, end: p.end, gone: false, stale: false })
  }
  const links = (t: string) => mapRefs(t, say)
  // No "(path:line)" asides in More: those places are the references, listed once under it.
  const details = dropAsides(s.details ?? '')
  const shown = shownBy(lj, n, details, input, delta)
  const seen = (r: Ref) => onScreen(r, shown, input.renames)
  const refs = [bareRefsLine(s.refs, seen, say), ...sentenceRefs(s.refs, seen, links)]
  // No recap on the last step: the map's header has the question.
  return {
    lead: s.lead ? links(s.lead) : '',
    details: details ? links(details) : '',
    refs: refs.filter(Boolean).join('\n\n'),
    stale: at.stale,
  }
}

/** The bare refs (`path:line`) not on screen, said on one line, ' · ' between them. */
function bareRefsLine(refs: string[], seen: (r: Ref) => boolean, say: (r: Ref) => string): string {
  const bare = refs.filter((r) => !isSentence(r)).map(parseBare)
  return bare.filter((r) => !seen(r)).map(say).join(' · ')
}

/** The explained refs: each sentence as written, its places links; one whose every place is on screen is left out. */
function sentenceRefs(refs: string[], seen: (r: Ref) => boolean, links: (t: string) => string): string[] {
  const allShown = (sentence: string) => { const rs = refsIn(sentence); return rs.length > 0 && rs.every(seen) }
  return refs.filter(isSentence).filter((r) => !allShown(r)).map((r) => links(r.trim()))
}
