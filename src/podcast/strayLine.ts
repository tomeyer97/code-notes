// What the output says about a podcast file no journey reads (strays.ts finds them). Pure: test/podcastStrays.test.ts.

import { readPodcastText } from '../core/format/podcast/validate'

/** The line for stray podcast file `fsPath` (its text `raw`, if it could be read): why it isn't played, and the
 *  journey it names. `journeyIds`: each journey's podcast file by journey id. */
export function strayLine(fsPath: string, raw: string | undefined, journeyIds: Map<string, string>): string {
  const name = fsPath.slice(Math.max(fsPath.lastIndexOf('/'), fsPath.lastIndexOf('\\')) + 1)
  const journeyFile = name.replace(/\.podcast\.json$/i, '.json')
  const id = readPodcastText(raw ?? '').journey?.id
  return `podcast ${fsPath}: ignored: a podcast plays next to its journey, named <journey>.podcast.json, and there is no ${journeyFile}${namedJourney(id, journeyIds)}`
}

/** "; its journey.id is "x" (whose podcast is y)", or with no such journey; '' when it names none. */
function namedJourney(id: string | undefined, journeyIds: Map<string, string>): string {
  if (!id) return ''
  const owner = journeyIds.get(id)
  return `; its journey.id is "${id}"${owner ? ` (whose podcast is ${owner})` : ', and no journey here has that id'}`
}
