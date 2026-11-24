// A journey's podcast checked by the extension's validator (src/core/format/podcast/validate.ts).
import fs from 'node:fs'
import path from 'node:path'
import { validatePodcast, PodcastContext } from '../../src/core/format/podcast/validate'

export interface PodcastRequest {
  raw: string
  journey?: PodcastContext['journey'] | null
  audio?: PodcastContext['audio'] | null
  audioDuration?: number | null
  changed?: number[] | null
  /** The marks' files are read from this repository… */
  repo?: string | null
  /** …or given (a file left out: not read; null: not there). */
  files?: Record<string, string | null> | null
}

export interface PodcastFinding { level: string; code: string; message: string; segment: string | null }

/** A repository file's text; null when it is not inside the repository or can't be read as UTF-8. */
function repoText(repo: string, file: string): string | null {
  const root = path.resolve(repo)
  const p = path.resolve(root, file)
  if (!p.startsWith(root + path.sep)) return null
  try { return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(p)) } catch { return null }
}

export function checkPodcast(r: PodcastRequest): PodcastFinding[] {
  const { repo, files: given } = r
  const files = typeof repo === 'string' ? (f: string) => repoText(repo, f)
    : given ? (f: string) => (f in given ? given[f] : undefined) : undefined
  const ctx: PodcastContext = { journey: r.journey ?? undefined, audio: r.audio ?? undefined, audioDuration: r.audioDuration ?? undefined, changed: r.changed ?? undefined, files }
  return validatePodcast(r.raw, ctx).problems.map((p) => ({ level: p.level, code: p.code, message: p.message, segment: p.segment ?? null }))
}
