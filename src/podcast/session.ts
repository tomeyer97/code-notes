// What plays: the journey listened to (one at a time), whether its audio plays, where it was last reported, and what
// the extension last asked of it. The host's reports update it; the player decides what follows.
import type { TimeReport } from './reportClock'

/** After the player asks for a seek or a pause, the host's reports from before it are ignored for at most this long
 *  (ms). */
const STALE_MS = 1500

export class Session {
  /** The journey (key) listened to: playing, or paused with its place kept. */
  key: string | undefined
  /** Listening: the audio plays, or is held for a camera wait (no pause: nothing says one). */
  playing = false
  /** The audio itself is playing (not in a camera hold), as last reported. */
  audible = false
  /** The episode played to its end (the row and the status item say so). */
  ended = false
  /** Why the extension paused or stopped it last (the log says it). */
  reason: string | undefined
  /** What a hold paused it for (a note, a question), until it plays again. */
  heldFor: string | undefined
  private lastReport: { key: string; t: number; playing: boolean; rate: number; at: number } | undefined
  /** What the player asked the host for last, and when: until the host says it did (a seek report; a report not
   *  playing), its older reports are stale. */
  private asked: { kind: 'seek' | 'pause'; at: number; key?: string } | undefined

  is(key: string): boolean { return this.key === key }

  /** It stopped being listened to (its place is kept elsewhere). */
  stop(): void {
    this.key = undefined
    this.playing = false
  }

  /** The player asks the host for a seek or a pause now. */
  asking(kind: 'seek' | 'pause'): void {
    this.asked = { kind, at: Date.now(), key: this.key }
  }

  /** Nothing asked any more (the walk put where the audio is). */
  forgetAsked(): void { this.asked = undefined }

  /** A report of journey `key` from before the seek or pause just asked for (the walk would go back there for a
   *  moment), also once the session is over (a playing report from before an End Journey must not start it again). */
  stale(key: string, report: TimeReport): boolean {
    const asked = this.asked
    if (!asked || (key !== this.key && key !== asked.key)) return false
    const answers = asked.kind === 'seek' ? !!report.seek : !report.playing
    if (!answers && Date.now() - asked.at < STALE_MS) return true
    this.asked = undefined
    return false
  }

  /** The session's journey `key` reported `report` at `at` (ms). */
  reported(key: string, report: TimeReport, at: number): void {
    this.lastReport = { key, t: report.t, playing: report.playing, rate: report.rate || 1, at }
    this.audible = report.playing
  }

  /** The rate the audio last reported playing at. */
  get rate(): number | undefined { return this.lastReport?.rate }

  /** Where the audio is now (s): its last report, moved on by the time since when it is playing; `fallback` when
   *  the last report is not the session's. */
  audioNow(fallback: number): number {
    const r = this.lastReport
    if (!r || r.key !== this.key) return fallback
    return r.playing ? r.t + ((Date.now() - r.at) / 1000) * (r.rate || 1) : r.t
  }
}
