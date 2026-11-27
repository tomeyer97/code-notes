// When a podcast's marks light (docs/podcast-format.md, "Marks"): at any time T exactly the marks lit by T in the
// segment playing at T (also paused, after a seek); playing, the next one on time by a timer, its heads-up before it,
// and a mark that just lit brought on screen (a camera move) unless the reader looks around.
import * as vscode from 'vscode'
import { markTimes, planMarks, sameView, segmentAt, View } from '../core/format/podcast/model'
import type { Journeys } from '../journeys/journeys'
import { showInCodeGroup, stepFileUri } from '../journeys/codeGroup'
import type { MapPanel } from '../journeys/mapPanel'
import type { LoadedJourney } from '../journeys/steps'
import type { TourApi } from '../tour/api'
import { revealKeepingIndent } from '../platform/reveal'
import { fireAndForget } from '../platform/run'
import { type Camera, cueText } from './camera'
import { CUE_HORIZON_MS, CUE_LEAD_S } from './cameraRules'
import type { Follow } from './follow'
import type { Loaded, PodcastLibrary } from './library'
import { MarkLights, PlannedMark } from './markLights'
import type { Session } from './session'
import { viewFile, viewOf } from './views'

/** How a segment was reached: played into (the view hold's view decides which file a mark may open), or sought (its
 *  own view). */
type Reached = 'calm' | 'exact'

/** Plans kept at most (a long session's segments; a journey or podcast read again makes new ones). */
const MAX_PLANS = 200

/** Segment `k` of `lj`'s podcast as read (`pod.sig`), reached `how`: what a plan and a lit set are of. */
const segmentKey = (lj: LoadedJourney, pod: Loaded, k: number, how: Reached) => `${lj.key}|${pod.sig}|${k}|${how}`

export interface MarkPorts { journeys: () => Journeys; mapPanel: () => MapPanel; tour: () => TourApi }

export class MarkScheduler implements vscode.Disposable {
  readonly lights: MarkLights
  /** The segment the marks are of, and how it was reached. */
  private seg = -1
  private reached: Reached = 'calm'
  /** Lights the next mark on time while playing. */
  private timer: NodeJS.Timeout | undefined
  private plans = new Map<string, PlannedMark[]>()

  constructor(log: vscode.LogOutputChannel, private readonly ports: MarkPorts, private readonly session: Session,
    private readonly library: PodcastLibrary, private readonly follow: Follow, private readonly camera: Camera) {
    this.lights = new MarkLights(log)
  }

  /** The segment the marks are of (-1: none). */
  get segment(): number { return this.seg }

  /** The marks at second `t` of `lj`'s podcast (`seek`: reached by a seek; `rate`: playing at). */
  show(lj: LoadedJourney, pod: Loaded, t: number, seek: boolean, playing: boolean, rate?: number): void {
    clearTimeout(this.timer)
    this.timer = undefined
    const k = segmentAt(pod.episode.segments, t)
    if (seek) this.reached = 'exact'
    else if (k !== this.seg) this.reached = 'calm'
    if (k !== this.seg && !this.camera.waiting) this.camera.clearCue()
    this.seg = k
    const seg = pod.episode.segments[k]
    const plan = seg?.marks && t >= seg.start ? this.planOf(lj, pod, k, this.reached) : []
    if (playing) this.headsUp(lj, pod, k, plan, t, rate)
    if (!seg?.marks || t < seg.start) { this.lights.clear(); return }
    fireAndForget(this.lights.show(segmentKey(lj, pod, k, this.reached), plan, t, (p, r, doc) => this.bring(p, r, doc)), 'podcast: lights.show')
    const next = plan.find((p) => !p.skip && p.time > t)
    if (!playing || !next || next.time >= seg.end) return
    const ms = ((next.time - t) / (rate || 1)) * 1000
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.session.is(lj.key) && this.session.playing && this.library.get(lj.key) === pod) this.show(lj, pod, next.time, false, true, rate)
    }, Math.max(0, ms))
  }

  /** The next `show` lights its marks afresh (the walk put back where the audio is). */
  again(): void { this.lights.again() }

  /** No marks lit, none waiting, no camera wait. */
  clear(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.seg = -1
    this.lights.clear()
    this.camera.cancel()
  }

  /** Segment `k`'s marks as played: each one's file, time, and whether the view hold skips it or lets it open its file
   *  (model.ts planMarks). */
  private planOf(lj: LoadedJourney, pod: Loaded, k: number, how: Reached): PlannedMark[] {
    const key = segmentKey(lj, pod, k, how)
    let plan = this.plans.get(key)
    if (plan) return plan
    const segs = pod.episode.segments
    const s = segs[k]
    const own = viewFile(lj, viewOf(s))
    let shown = own, since = s.start
    if (how === 'calm') {
      const views = this.follow.calmViews(lj, pod)
      const fileAt = (j: number) => viewFile(lj, views[j] ?? { step: 0 })
      shown = fileAt(k)
      let j = k
      while (j > 0 && fileAt(j - 1) === shown) j--
      since = segs[j].start
    }
    const marks = s.marks ?? []
    const times = markTimes(s)
    const renames = this.ports.journeys().renames(lj)
    plan = planMarks(marks, times, own, shown, since).map((x, i) => ({ mark: marks[i], file: x.file, uri: stepFileUri(lj.folder.uri, renames, x.file), time: times[i], skip: x.skip, opens: x.opens }))
    if (this.plans.size > MAX_PLANS) this.plans.clear()
    this.plans.set(key, plan)
    return plan
  }

  /**
   * The heads-up: CUE_LEAD_S before the next mark of this segment, or the next segment's view, whichever comes
   * first, a cue at the editor's edge if its code is out of view then. Only while the walk follows the voice.
   */
  private headsUp(lj: LoadedJourney, pod: Loaded, k: number, plan: PlannedMark[], t: number, rate?: number): void {
    const next = this.nextMove(lj, pod, k, plan, t)
    if (!next) return
    const ms = ((next.at - CUE_LEAD_S - t) / (rate || 1)) * 1000
    if (ms > CUE_HORIZON_MS) return
    const following = this.follow.lock.locked && this.follow.drives() && !this.follow.justSought()
    this.camera.scheduleCue(ms, following ? this.follow.narratedEditor() : undefined, next.target.uri, next.target.line)
  }

  /** What moves the code next, and when (s): the next mark of this segment, else the next segment's view. */
  private nextMove(lj: LoadedJourney, pod: Loaded, k: number, plan: PlannedMark[], t: number): { at: number; target: { uri: string; line: number } } | undefined {
    const segs = pod.episode.segments
    const mark = plan.find((p) => !p.skip && p.time > t)
    if (mark && mark.time < (segs[k]?.end ?? Infinity)) return { at: mark.time, target: { uri: mark.uri.toString(), line: mark.mark.lines[0] - 1 } }
    if (k + 1 >= segs.length || segs[k + 1].start <= t) return undefined
    const v: View | undefined = this.follow.calmViews(lj, pod)[k + 1]
    if (!v || !v.step || sameView(v, this.follow.wanted)) return undefined
    const target = this.follow.target(lj, v)
    return target && { at: segs[k + 1].start, target }
  }

  /**
   * A mark that just lit while it plays: on screen if it isn't (centred), never under a reader looking around (the
   * follow lock); in another file, that file opens only when the plan lets it (the view hold). Leaving the view on
   * screen is a camera move: the read time first, then the settle, unless the reader just sought.
   */
  private async bring(p: PlannedMark, r: vscode.Range, doc: vscode.TextDocument): Promise<void> {
    const { lock } = this.follow
    if (!lock.locked || !this.follow.drives()) { this.camera.lit(); return }
    const uri = doc.uri.toString()
    const shown = () => vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri && e.viewColumn !== this.ports.mapPanel().viewColumn)
    const ed = shown()
    if (ed ? ed.visibleRanges.some((v) => v.contains(r.start) && v.contains(r.end)) : !p.opens) { this.camera.lit(); return }
    const from = ed ?? this.follow.narratedEditor()
    const where = (from && cueText(from, uri, r.start.line)?.text) ?? `→ ${p.file.split('/').pop()}`
    const key = this.session.key
    const onMap = !!key && this.library.get(key)?.episode.segments[this.seg]?.step === 0
    await this.camera.move(() => lock.asOurs(async () => {
      if (!lock.locked) return
      const e = shown() ?? await showInCodeGroup(doc, this.ports.tour().codeColumn, { keepFocus: true })
      await revealKeepingIndent(e, r, () => lock.locked)
    }), where, !onMap && !this.follow.justSought())
  }

  dispose(): void {
    clearTimeout(this.timer)
    this.lights.dispose()
  }
}
