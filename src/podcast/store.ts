// What the player remembers across sessions and windows: where each journey's podcast was left, the playback rate,
// the muting, the one-time hint. Positions are kept in memory at once and stored now and then (and on a pause, a
// seek, leaving).
import { posKey, LoadedJourney } from '../journeys/steps'
import { fireAndForget } from '../platform/run'
import { STATE, StateStore } from '../platform/state'

/** While playing, where it is is stored this often (ms). */
const SAVE_EVERY_MS = 5000

export class PodcastStore {
  /** Where each journey's podcast is (key -> seconds), as the host last said (or as stored, until it says). */
  private pos = new Map<string, number>()
  private lastSave = 0

  constructor(private readonly state: () => StateStore) {}

  private positions(): Record<string, number> { return this.state().get(STATE.podcastPos) }

  /** Where `lj`'s podcast was stored (a reload, another window), if anywhere. */
  stored(lj: LoadedJourney): number | undefined { return this.positions()[posKey(lj)] }
  /** Where `lj`'s podcast is: as last reported, else as stored, else the start. */
  posOf(lj: LoadedJourney): number { return this.pos.get(lj.key) ?? this.stored(lj) ?? 0 }
  /** A place is known for `lj` (reported or stored). */
  knows(lj: LoadedJourney): boolean { return this.pos.has(lj.key) || !!this.stored(lj) }
  /** Where journey `key`'s podcast was reported this session, if it was. */
  reported(key: string): number | undefined { return this.pos.get(key) }

  /** Kept in memory at once; stored when `now` (a pause, a seek, leaving) or every SAVE_EVERY_MS. */
  save(lj: LoadedJourney, t: number, now = false): void {
    this.pos.set(lj.key, t)
    if (!now && Date.now() - this.lastSave < SAVE_EVERY_MS) return
    this.lastSave = Date.now()
    fireAndForget(this.state().set(STATE.podcastPos, { ...this.positions(), [posKey(lj)]: Math.round(t * 10) / 10 }), 'podcast: store podcastPos')
  }

  get rate(): number { return this.state().get(STATE.podcastRate) }
  set rate(r: number) {
    if (r !== this.rate) fireAndForget(this.state().set(STATE.podcastRate, r), 'podcast: store podcastRate')
  }

  get muted(): boolean { return !!this.state().get(STATE.podcastMuted) }
  set muted(m: boolean) {
    if (m !== this.muted) fireAndForget(this.state().set(STATE.podcastMuted, m), 'podcast: store podcastMuted')
  }

  /** True the first time it is asked (ever): the one-time hint is due. */
  firstListen(): boolean {
    if (this.state().get(STATE.listenHintShown)) return false
    fireAndForget(this.state().set(STATE.listenHintShown, true), 'podcast: store listenHintShown')
    return true
  }
}
