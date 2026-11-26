// A message's text as thread Markdown: file references as links, ```suggestion blocks with Apply, the check's code
// links. Built from the message's segments (text, code, suggestion) and escaped once at the end. No vscode here:
// unit-tested in test/threadText.test.ts.
import type { StepLink } from '../core/format/journeyModel'
import { linkify } from '../core/linkifyAnswer'
import { linkPhrases, PH, PH_RE } from '../core/codeLinkText'
import { escapeMarkdown, escapeTags } from '../core/escape'

/** A piece of a message between its ``` fences; suggestion blocks are numbered in order (`k`) for Apply. */
export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'suggestion'; text: string; code: string; k: number }

const FENCE = /(```[\s\S]*?```)/g
const SUGGESTION = /^```suggestion[ \t]*\r?\n([\s\S]*?)\r?\n?```$/

/** The message cut at its ``` fences. */
export function segments(body: string): Segment[] {
  const out: Segment[] = []
  let suggestions = 0
  for (const text of body.split(FENCE)) {
    if (!text.startsWith('```')) { out.push({ kind: 'text', text }); continue }
    const sug = SUGGESTION.exec(text)
    if (sug) out.push({ kind: 'suggestion', text, code: sug[1], k: suggestions++ })
    else out.push({ kind: 'code', text })
  }
  return out
}

/** The k-th ```suggestion block of a message (what Apply puts in). */
export function suggestionOf(body: string, k: number): string | undefined {
  for (const s of segments(body)) if (s.kind === 'suggestion' && s.k === k) return s.code
  return undefined
}

/** A suggestion applied: which block of the message (`suggestion`), by whom, when. Kept in the note file as the
 *  message's `applied` list, so a reader of the thread later sees it was taken. */
export interface Applied { suggestion: number; by: string; at: string }

/** Who applied suggestion `k` of a message (its `extra.applied`), if anyone did. */
export function appliedOf(extra: Record<string, unknown> | undefined, k: number): Applied | undefined {
  const list = extra?.applied
  if (!Array.isArray(list)) return undefined
  return list.find((a): a is Applied => !!a && typeof a === 'object' && a.suggestion === k && typeof a.by === 'string')
}

/** The message's extra fields with suggestion `k` marked applied by `by` (the other fields as they were). */
export function withApplied(extra: Record<string, unknown> | undefined, a: Applied): Record<string, unknown> {
  const list = Array.isArray(extra?.applied) ? extra.applied : []
  return { ...extra, applied: [...list, a] }
}

/** What stands under an applied suggestion instead of Apply. */
export const appliedText = (a: Applied) => `_Applied ✓ by ${escapeMarkdown(a.by)}_`

/** A code link of the check: a phrase of the message and the lines it shows. */
export type CodeLinkRef = StepLink

export interface MessageText {
  body: string
  /** Makes one file link: `text` opens `file` at `line`. */
  fileLink: (text: string, file: string, line?: string) => string
  /** The repository's absolute path and the home folder (never shown). */
  root: string
  home: string
  /** The Apply link under suggestion k; none: a suggestion is a plain code block. */
  apply?: (k: number) => string
  /** The check's code links: each phrase found becomes `codeLink(i, phrase)`. */
  codeLinks?: readonly CodeLinkRef[]
  codeLink?: (i: number, phrase: string) => string
  /** Markdown after the text (the link a cut last line becomes). */
  suffix?: string
}

/** The message as Markdown (before it is trusted). */
export function messageText(m: MessageText): string {
  const codeLinks = m.codeLinks ?? []
  // The check's phrases are marked first (PH) and their markup goes in after the escaping: escaped, it would be text.
  const marked = codeLinks.length ? linkPhrases(m.body, [...codeLinks], new Set<number>(), PH) : m.body
  const text = segments(marked).map((s) => {
    if (s.kind === 'text') return linkify(s.text, m.root, m.home, m.fileLink)
    if (s.kind === 'suggestion' && m.apply) return `${codeBlock([s.code])}\n\n${m.apply(s.k)}`
    return s.text
  }).join('') + (m.suffix ?? '')
  if (!codeLinks.length || !m.codeLink) return text
  const codeLink = m.codeLink
  return escapeTags(text).replace(PH_RE, (_m, i: string, phrase: string) => codeLink(Number(i), phrase))
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }

/** Text as it was typed: tags as text, Markdown punctuation escaped, each line its own (spaces kept, so long answers
 *  still wrap). */
export function verbatimText(body: string): string {
  const line = (l: string) => l.replace(/[&<>]/g, (c) => HTML_ESCAPES[c]).replace(/[\\`*_{}[\]()#+\-!~|:]/g, '\\$&')
  return body.split('\n').map(line).join('  \n')
}

/** A fenced code block. */
export const codeBlock = (lines: readonly string[], lang = '') => `\`\`\`${lang}\n${lines.join('\n')}\n\`\`\``

/**
 * The line a question asked from a step ends with (askStep writes it; the step itself is in the note's
 * `extra.journey`). Newer notes name the step by id, older ones by number; group 1 is the journey's title.
 */
const ABOUT_STEP = [
  // _About the step “Read the config” (id `s3`) of the journey “Start-up”_
  /_About the step “[^”]*” \(id [^)]*\) of the journey “([^”]*)”_\s*$/,
  // _About step 3 of the journey “Start-up”: Read the config_
  /_About step \d+ of the journey “([^”]*)”: [^\n]*_\s*$/,
]

export interface AboutStepLine {
  /** The message before the line, and the same without the blank lines before it. */
  before: string
  beforeBlank: string
  /** The journey's title as the line says it. */
  journeyTitle: string
}

/** The message's "_About the step …_" line, if it ends with one. */
export function aboutStepLine(body: string): AboutStepLine | undefined {
  for (const re of ABOUT_STEP) {
    const m = re.exec(body)
    if (!m) continue
    const before = body.slice(0, m.index)
    return { before, beforeBlank: before.replace(/\n*$/, ''), journeyTitle: m[1] }
  }
  return undefined
}
