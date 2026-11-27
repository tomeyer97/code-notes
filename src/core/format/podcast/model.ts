// The podcast format's pure parts under one name, for importers outside this folder that still use it. New code
// imports the module it needs: format.ts (types), resolve.ts (the episode), timeline.ts (time and views), marks.ts,
// journeyShape.ts, validate.ts (the full check), core/clock.ts.

import { accepted, Parsed, refused } from '../result'
import type { Podcast } from './format'
import { readPodcastText } from './validate'

export * from './format'
export * from './journeyShape'
export * from './marks'
export * from './resolve'
export * from './timeline'
export { clock, clockMs } from '../../clock'

/** The file read by the one parser (validate.ts readPodcastText): the podcast, or its first error. Only for the
 *  podcast page's screenshot script; new code reads `validatePodcast(raw).podcast`. */
export function parsePodcast(raw: string): Parsed<Podcast> {
  const read = readPodcastText(raw)
  return read.podcast && !read.errors.length ? accepted(read.podcast) : refused(read.errors[0]?.message ?? 'not a podcast')
}
