// The host's time reports, taken in step with the voice. Reports come four or five times a second; when the extension
// is slow to take them (a busy extension host, a remote window) they pile up and arrive late. ReportClock moves a
// late report on by how late it is; ReportQueue applies only the newest of a run of "playing on, here" reports.
// No vscode here: test/reportClock.test.ts drives both.
import type { PodcastTime } from '../protocol/podcast'

/** Where the host's audio is (podcastTime): `of`, the journey (key) whose audio it is. */
export type TimeReport = Omit<PodcastTime, 'type'>

/** The quickest report is looked for over the last one or two windows of this length: a clock that jumped (another
 *  machine's, a remote window) is followed within two. */
export const SKEW_WINDOW_MS = 30000
/** A report is never taken as later than this (a stall, not a delay). */
export const MAX_LATE_MS = 10000
/** Later than the quickest report by less than this: on time (the jitter of the message channel). */
export const MIN_LATE_MS = 20

/**
 * How late a report arrives: its (arrival − sent) beyond the quickest one seen lately. The two clocks may differ, so
 * the quickest report stands for "no delay"; a minimum over the current and the previous window keeps it from
 * jumping when a window starts.
 */
export class ReportClock {
  private quickest = Infinity
  private quickestBefore = Infinity
  private windowFrom = 0

  /** `report` as it is at `now` (ms): a playing report moved on by how late it came; any other as it is. */
  correct(report: TimeReport, now: number): TimeReport {
    if (typeof report.sent !== 'number' || !report.playing || report.seek) return report
    const off = now - report.sent
    if (now - this.windowFrom > SKEW_WINDOW_MS) {
      this.quickestBefore = this.quickest
      this.quickest = off
      this.windowFrom = now
    }
    this.quickest = Math.min(this.quickest, off)
    const late = Math.min(MAX_LATE_MS, off - Math.min(this.quickest, this.quickestBefore))
    return late > MIN_LATE_MS ? { ...report, t: report.t + (late / 1000) * (report.rate || 1) } : report
  }
}

/**
 * Time reports applied in order, a run of plain ones (playing on, here) as its newest only. A seek, or a report that
 * changes playing, holding or the journey, is applied as it comes, after the run before it.
 */
export class ReportQueue<S> {
  private queued: { shown: S; report: TimeReport; at: number } | undefined

  /** `apply` takes each report that is not dropped; `later` runs the flush after the current turn. */
  constructor(private readonly apply: (shown: S, report: TimeReport, at: number) => void,
    private readonly later: (f: () => void) => void = (f) => { setImmediate(f) }) {}

  push(shown: S, report: TimeReport, at: number): void {
    const q = this.queued
    if (q && (report.seek || q.report.playing !== report.playing || !!q.report.held !== !!report.held || q.report.of !== report.of)) this.flush()
    if (report.seek) { this.apply(shown, report, at); return }
    const first = !this.queued
    this.queued = { shown, report, at }
    if (first) this.later(() => this.flush())
  }

  flush(): void {
    const q = this.queued
    this.queued = undefined
    if (q) this.apply(q.shown, q.report, q.at)
  }
}
