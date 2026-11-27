// The podcast as the integration tests read it (src/testApi.ts, loaded only outside Production): what the player
// shows and where the audio is, read through its parts, and the counts of what it did, kept here from its events.
import { brokenLinks } from '../core/format/podcast/validate'
import type { ToPlayer } from '../protocol/podcast'
import type { PodcastFeature } from './index'
import type { Podcasts } from './player'
import type { PodcastPorts } from './ports'

/** The test entry's view of the podcast. Made at activate (before the player starts), so no event is missed. */
export function podcastProbe(feature: PodcastFeature, ports: Pick<PodcastPorts, 'journeys' | 'mapPanel'>) {
  const seen = { error: '', moves: 0, why: 0 }
  feature.whenStarted((p) => {
    p.onDidFail((m) => { seen.error = m })
    p.follow.onDidMove(() => { seen.moves++ })
    p.onDidShowWhy(() => { seen.why++ })
  })
  return {
    snapshot: () => snapshot(feature.player(), ports, seen),
    /** A command for the player that has the audio (the Listen view, or the panel), as the extension sends it. */
    hostSend: (m: ToPlayer) => feature.player().host.send(m),
    /** The Listen view ignores the extension's pauses (a camera wait that can't pause the audio). */
    listenIgnorePauses: (on: boolean) => { feature.player().host.listen.ignorePauses = on },
  }
}

function snapshot(p: Podcasts, ports: Pick<PodcastPorts, 'journeys' | 'mapPanel'>, seen: { error: string; moves: number; why: number }) {
  const lj = p.listening()
  const id = (key: string) => ports.journeys.list.get(key)?.j.id ?? key
  const { session, follow, host, camera, statusItem } = p
  return {
    journeys: ports.journeys.all().filter((x) => p.has(x)).map((x) => x.j.id),
    session: lj?.j.id,
    t: p.sessionTime,
    playing: session.playing,
    want: follow.wanted,
    beatShown: follow.beat,
    applying: follow.applying,
    item: statusItem.text,
    itemShown: statusItem.shown,
    listening: !!lj,
    hostKey: host.key,
    hostIn: host.in,
    unlocked: host.unlocks,
    hostAlive: host.alive(),
    /** The Listen view's page (hostAlive is the player that has the audio, which may be the panel). */
    listenAlive: host.listen.alive,
    hostVisible: host.listen.visible,
    panelHosts: host.panelHosts,
    rate: p.store.rate,
    muted: p.store.muted,
    ended: session.ended,
    error: seen.error,
    moves: seen.moves,
    mapVisible: ports.mapPanel.visible,
    why: seen.why,
    follow: follow.lock.locked,
    unlock: follow.lock.lastUnlock,
    held: session.heldFor,
    marks: p.marks.lights.lit(),
    camera: { waiting: camera.waiting, cue: camera.cue, waits: [...camera.waits] },
    audible: session.audible,
    audioNow: p.audioNow(),
    broken: Object.fromEntries(p.library.brokenEntries().map(([k, b]) => [id(k), b.reason])),
    notices: Object.fromEntries(p.library.entries().filter(([, pod]) => pod.notice).map(([k, pod]) => [id(k), pod.notice])),
    links: Object.fromEntries(p.library.entries().map(([k, pod]) => [id(k), brokenLinks(pod.problems)])),
  }
}
