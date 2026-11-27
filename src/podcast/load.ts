// Reading a journey's podcast file: its text read once, what is known around it gathered (the journey, the audio
// file, the marks' files, the steps changed since it was recorded), then checked once (core/format/podcast/
// validate.ts). The player (library.ts) decides what it plays from the result; diagnostics.ts tells the author.

import * as vscode from 'vscode'
import { log } from '../platform/host'
import { stepFileUri } from '../journeys/codeGroup'
import { LoadedJourney } from '../journeys/steps'
import { readText } from '../platform/jsonFolder'
import { wfs } from '../platform/workspaceFs'
import { Podcast, podcastFileOf } from '../core/format/podcast/format'
import { IdentifiedJourneyShape, journeyShapeOf } from '../core/format/podcast/journeyShape'
import { audioPathProblem, markFileNames, PodcastContext, readPodcastText, validateRead, Validation } from '../core/format/podcast/validate'
import { ChangedSince } from './changedSince'
import { StrayPodcasts } from './strays'

// Where library.ts and player.ts find them (they moved out of this file).
export { podcastReports } from './diagnostics'

/** A podcast file next to a journey, read and checked. */
export interface PodcastRead {
  file: vscode.Uri
  raw: string
  /** The audio file it names (undefined: it names none, or one outside the journeys folder). */
  audio?: vscode.Uri
  audioSize: number
  v: Validation
}

/** How long an audio file is (s), once the panel has loaded it; undefined: not known yet. */
type AudioLength = (audio: vscode.Uri, size: number) => number | undefined

const changedSince = new ChangedSince((line) => log().info(line))
const strays = new StrayPodcasts((line) => log().info(line))

/** The podcast next to `lj` (undefined: there is none), checked against `lj` and, once known, its audio's length
 *  (`renames`: the journey's files as they are called now). */
export async function readPodcast(lj: LoadedJourney, audioLength: AudioLength, renames: Map<string, string>): Promise<PodcastRead | undefined> {
  const file = lj.uri.with({ path: podcastFileOf(lj.uri.path) })
  const raw = await readText(file)
  if (raw === undefined) return undefined
  const read = readPodcastText(raw)
  const journey = journeyShapeOf(lj.j)
  const audio = await audioOf(file, read.podcast)
  const ctx: PodcastContext = {
    journey,
    ...(audio && {
      audio: { exists: audio.exists, size: audio.size },
      audioDuration: audio.exists ? audioLength(audio.uri, audio.size) : undefined,
    }),
    changed: read.podcast?.journey.commit ? await changedSince.steps(lj, read.podcast.journey.commit) : undefined,
    files: await markFiles(lj, read.podcast, journey, renames),
  }
  return { file, raw, audio: audio?.uri, audioSize: audio?.size ?? 0, v: validateRead(read, ctx) }
}

/** The audio file a podcast names, when it can be used: is it there, and how big. */
async function audioOf(file: vscode.Uri, podcast: Podcast | undefined): Promise<{ uri: vscode.Uri; exists: boolean; size: number } | undefined> {
  const name = podcast?.audio
  if (!name || audioPathProblem(name)) return undefined
  const uri = vscode.Uri.joinPath(file, '..', name)
  try { return { uri, exists: true, size: (await wfs.stat(uri)).size } } catch { return { uri, exists: false, size: 0 } }
}

/** The files the marks are in, read for their check (the lines there, the match in them): a file not read is
 *  undefined, one that isn't there null. */
async function markFiles(lj: LoadedJourney, podcast: Podcast | undefined, journey: IdentifiedJourneyShape, renames: Map<string, string>): Promise<PodcastContext['files']> {
  const texts = new Map<string, string | null>()
  for (const f of podcast ? markFileNames(podcast, journey) : []) {
    texts.set(f, (await readText(stepFileUri(lj.folder.uri, renames, f))) ?? null)
  }
  return (f: string) => (texts.has(f) ? texts.get(f) : undefined)
}

/** Podcast files in the journeys folders that no journey reads, said once each (strays.ts); `known`: the podcast
 *  files next to journeys. */
export function strayPodcasts(folders: vscode.Uri[], known: Set<string>, journeyIds: Map<string, string>): Promise<void> {
  return strays.check(folders, known, journeyIds)
}
