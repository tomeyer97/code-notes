// The podcasts of the workspace's journeys: each one read and checked against its journey (load.ts), playable or
// broken (and why). A file that broke while it plays keeps its last good version; the audio's measured length and a
// failure to decode it are kept by audio file (path and size: a rewritten file is new).
import * as vscode from 'vscode'
import { baseName } from '../core/paths'
import { Episode, podcastFileOf, PodcastProblem } from '../core/format/podcast/model'
import { playNotice } from '../core/format/podcast/validate'
import type { Journeys } from '../journeys/journeys'
import type { LoadedJourney } from '../journeys/steps'
import { fireAndForget } from '../platform/run'
import { podcastReports, PodcastRead, readPodcast, strayPodcasts } from './load'

/** A journey's podcast that can be played. `notice`: one line about what is wrong with it (the panel and the row's
 *  tooltip say it); `lastGood`: the file has errors now, this is the version read before; `sig`: changes when what
 *  plays does. */
export interface Loaded { file: vscode.Uri; audio: vscode.Uri; audioSize: number; episode: Episode; sig: string; problems: PodcastProblem[]; notice?: string; lastGood?: boolean }
/** A podcast file next to a journey that can't be played, and why (its first error). */
export interface Broken { file: vscode.Uri; reason: string }

/** What the panel says over a podcast that plays from its last good version. */
const LAST_GOOD = 'The podcast file has errors: playing the last good version'

/** The problems that mean the audio itself is gone (no last good version can play then). */
const AUDIO_GONE = new Set(['audio-missing', 'audio-empty', 'audio-outside'])
const audioGone = (problems: PodcastProblem[]) => problems.some((p) => AUDIO_GONE.has(p.code))

/** An audio file as the measured lengths and faults know it: a rewritten file (another size) is measured again. */
export const audioKey = (uri: vscode.Uri, size: number) => `${uri.path}:${size}`

/** What a scan found: the podcasts before it, and whether anything a player shows changed. */
export interface Scanned { before: Map<string, Loaded>; changed: boolean }

export class PodcastLibrary {
  /** By journey key. */
  private playable = new Map<string, Loaded>()
  private broken = new Map<string, Broken>()
  /** The audio's real length as the host loaded it, by audioKey. */
  private audioLen = new Map<string, number>()
  /** An audio file the host failed to play, by audioKey: what to say (it looks cut off or damaged). */
  private audioFault = new Map<string, string>()

  constructor(private readonly journeys: () => Journeys, private readonly log: () => vscode.LogOutputChannel) {}

  get(key: string): Loaded | undefined { return this.playable.get(key) }
  has(key: string): boolean { return this.playable.has(key) }
  brokenOf(key: string): Broken | undefined { return this.broken.get(key) }
  /** The podcast file of journey `key`, playable or not. */
  fileOf(key: string): vscode.Uri | undefined { return this.playable.get(key)?.file ?? this.broken.get(key)?.file }
  entries(): [string, Loaded][] { return [...this.playable] }
  brokenEntries(): [string, Broken][] { return [...this.broken] }

  /**
   * Every journey's podcast read again. A file with errors now keeps its last good version while `keepsLast(key,
   * last)` (it is being played) and its audio is still there.
   */
  async scan(keepsLast: (key: string, last: Loaded) => boolean): Promise<Scanned> {
    const reads = await this.readAll()
    podcastReports.report(reads.map((r) => r.read))
    const next = new Map<string, Loaded>()
    const broken = new Map<string, Broken>()
    for (const { lj, read } of reads) {
      const kept = this.decide(lj, read, keepsLast)
      if ('reason' in kept) broken.set(lj.key, kept)
      else next.set(lj.key, kept)
    }
    // (The strays are told by the podcasts as they were: the ones known before this read.)
    fireAndForget(this.strays(), 'podcast: strays')
    const changed = signature(next, broken) !== signature(this.playable, this.broken)
    const before = this.playable
    this.playable = next
    this.broken = broken
    return { before, changed }
  }

  private async readAll(): Promise<{ lj: LoadedJourney; read: PodcastRead }[]> {
    const out: { lj: LoadedJourney; read: PodcastRead }[] = []
    for (const lj of this.journeys().all()) {
      const read = await readPodcast(lj, (u, size) => this.audioLen.get(audioKey(u, size)), this.journeys().renames(lj))
      if (read) out.push({ lj, read })
    }
    return out
  }

  /** What journey `lj`'s podcast is now: playable; its last good version (the file broke while it plays); broken. */
  private decide(lj: LoadedJourney, r: PodcastRead, keepsLast: (key: string, last: Loaded) => boolean): Loaded | Broken {
    if (r.v.playable && r.v.episode && r.audio) return this.loaded(r, r.v.episode, r.audio)
    const last = this.playable.get(lj.key)
    if (last && keepsLast(lj.key, last) && !audioGone(r.v.problems) && last.file.toString() === r.file.toString()) {
      return { ...last, notice: LAST_GOOD, lastGood: true, sig: last.lastGood ? last.sig : `${last.sig}:last-good` }
    }
    return { file: r.file, reason: r.v.problems.find((p) => p.level === 'error')?.message ?? 'it has errors' }
  }

  private loaded(r: PodcastRead, episode: Episode, audio: vscode.Uri): Loaded {
    const notice = this.audioFault.get(audioKey(audio, r.audioSize)) ?? playNotice(r.v.problems)
    return {
      file: r.file, audio, audioSize: r.audioSize, episode, problems: r.v.problems, notice,
      sig: `${r.raw.length}:${r.audioSize}:${JSON.stringify(episode.segments.map((s) => [s.start, s.step, s.beat]))}`,
    }
  }

  /** Podcast files in the journeys folders that no journey reads: why each is ignored, in the output (once). */
  private async strays(): Promise<void> {
    const all = this.journeys().all()
    const dirs = new Map(all.map((lj) => { const d = vscode.Uri.joinPath(lj.uri, '..'); return [d.toString(), d] }))
    const known = new Set(all.map((lj) => lj.uri.with({ path: podcastFileOf(lj.uri.path) }).toString()))
    const ids = new Map(all.filter((lj) => this.playable.has(lj.key) || this.broken.has(lj.key)).map((lj) => [lj.j.id, baseName(podcastFileOf(lj.uri.path))]))
    await strayPodcasts([...dirs.values()], known, ids).catch((e) => this.log().debug(`podcast: ${e}`))
  }

  /** The host loaded `pod`'s audio: its real length. True when it is new (a scan checks it against the file). */
  measured(pod: Loaded, duration: number): boolean {
    const key = audioKey(pod.audio, pod.audioSize)
    if (this.audioLen.get(key) === duration) return false
    this.audioLen.set(key, duration)
    return true
  }

  /** `pod`'s audio can't be decoded: `text` says so, on journey `key`'s podcast. True when it is new. */
  fault(key: string, pod: Loaded, text: string): boolean {
    const audio = audioKey(pod.audio, pod.audioSize)
    if (this.audioFault.get(audio) === text) return false
    this.audioFault.set(audio, text)
    this.playable.set(key, { ...pod, notice: text })
    return true
  }
}

/** What the players show of the podcasts (a change of it is a change to send). */
function signature(playable: Map<string, Loaded>, broken: Map<string, Broken>): string {
  return [...playable].map(([k, pod]) => `${k}=${pod.sig}|${pod.notice ?? ''}`).concat([...broken].map(([k, b]) => `${k}!${b.reason}`)).join('\n')
}
