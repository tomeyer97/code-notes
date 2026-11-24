// Listening to a journey: the podcast player (player.ts), its Listen view and the panel's player. Started on first
// use, or once the workspace has journeys (a podcast sits next to its journey): a workspace without journeys never
// loads it.
import * as vscode from 'vscode'
import { chord, STEP_PRIORITY, Steppers } from '../platform/chordKey'
import { Cmd, HiddenCmd } from '../platform/commands'
import { registerCommands } from '../platform/registerCommands'
import { fireAndForget } from '../platform/run'
import { Podcasts } from './player'
import { PodcastPorts, usePodcastPorts } from './ports'

export interface PodcastFeature {
  /** The player, started if it was not. */
  player(): Podcasts
}

export function activatePodcast(context: vscode.ExtensionContext, ports: PodcastPorts, more: {
  steppers: Steppers
  /** A note box opened (true) or closed: the podcast pauses meanwhile. */
  drafting: vscode.Event<boolean>
}): PodcastFeature {
  usePodcastPorts(ports)
  let started: Podcasts | undefined
  const player = (): Podcasts => {
    if (started) return started
    started = new Podcasts()
    started.init(context)
    fireAndForget(started.scan(), 'podcast: scan')
    return started
  }
  const startWithJourneys = () => { if (!started && ports.journeys.all().length) player() }
  context.subscriptions.push(
    ports.journeys.onDidChange(startWithJourneys),
    more.drafting((on) => { if (!started) return; if (on) started.hold('note'); else started.released('note') }),
    // D / A while it plays (or on the map's Intro, Recap): its ⏮ ⏭.
    more.steppers.register(STEP_PRIORITY.podcast, { step: (dir) => ports.tour.podcast()?.transport(dir) ?? false }),
  )
  registerCommands(context, {
    [Cmd.playPodcast]: (arg?: unknown) => player().play(arg),
    // The greyed ▶ of a podcast that can't be played (disabled in the menu): why, if it is ever run.
    [Cmd.podcastToggle]: chord(() => player().toggle()),
    [Cmd.podcastBack]: chord(() => player().back()),
    [Cmd.podcastForward]: chord(() => player().forward()),
    [Cmd.podcastPrevStep]: chord(() => player().part(-1)),
    [Cmd.podcastNextStep]: chord(() => player().part(1)),
    [Cmd.podcastOpen]: () => player().openSessionMap(),
    // "Follow along" on the step card: the editor follows the voice again (podcast/follow.ts).
    [HiddenCmd.podcastFollow]: () => player().followAlong(),
  })
  return { player }
}
