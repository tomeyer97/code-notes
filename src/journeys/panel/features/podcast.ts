// The podcast's player in the journey panel: every `podcast*` message goes to the podcast player.

import type { FromPlayer } from '../../../protocol/podcast'
import type { PanelFeature } from '../controller'
import { handleAll } from '../controller'
import { podcast } from '../../../tour/instances'
import { fireAndForget } from '../../../platform/run'

/** Every message the panel's player posts (a type missing here does not compile). */
const PLAYER_MESSAGES: Record<FromPlayer['type'], true> = {
  podcastTime: true, podcastState: true, podcastError: true, podcastMeta: true, podcastAsk: true, podcastWhy: true, podcastEnd: true,
  podcastUnlocked: true,
}

export function podcastFeature(): PanelFeature {
  return {
    name: 'the podcast',
    handlers: handleAll(Object.keys(PLAYER_MESSAGES) as FromPlayer['type'][], (lj, m) => {
      const p = podcast()
      if (!p) return
      switch (m.type) {
        case 'podcastWhy': return fireAndForget(p.showWhy(lj), 'panel: podcast.showWhy')
        case 'podcastAsk': return fireAndForget(p.onAsk(lj, m), 'panel: podcast.onAsk')
        case 'podcastEnd': return fireAndForget(p.endAction(lj, m.action, m.of), 'panel: podcast.endAction')
        // The panel's player as the audio's host, or unlocked (src/podcast/player.ts).
        default: return p.fromPanel(m)
      }
    }),
  }
}
