// The journey panel's controller: what each message from the page does, and what the page is told besides the
// journey. It knows no feature: each one (the walk, the list, the podcast, author mode, the check, the tutorial, the
// layout) registers its handlers and its part of TourInfo (features/). The panel's own messages (ready, rendered, …)
// stay with the panel (mapPanel.ts).

import type { FromMap, TourInfo } from '../../protocol/map'
import type { LoadedJourney } from '../steps'

export type PanelMessage<K extends FromMap['type']> = Extract<FromMap, { type: K }>
export type PanelHandler<K extends FromMap['type']> = (lj: LoadedJourney, m: PanelMessage<K>) => void
/** A typed handler table: each message type to its handler. */
export type PanelHandlers = { [K in FromMap['type']]?: PanelHandler<K> }

/** A feature of the panel: the messages it handles and its part of what the panel shows. */
export interface PanelFeature {
  /** For errors: who registered a message twice. */
  readonly name: string
  readonly handlers?: PanelHandlers
  /** Its part of TourInfo for journey `lj` (the parts are merged in registration order). */
  slice?(lj: LoadedJourney): Partial<TourInfo>
}

export class PanelController {
  private readonly handlers: PanelHandlers = {}
  private readonly owner = new Map<string, string>()
  private readonly slices: ((lj: LoadedJourney) => Partial<TourInfo>)[] = []

  constructor(features: PanelFeature[] = []) {
    for (const f of features) this.register(f)
  }

  /** A feature's handlers and slice. A message has one handler: a second one for it is a wiring mistake. */
  register(f: PanelFeature): void {
    for (const type of Object.keys(f.handlers ?? {}) as FromMap['type'][]) {
      const had = this.owner.get(type)
      if (had) throw new Error(`journey panel: '${type}' is handled by ${had} and ${f.name}`)
      this.owner.set(type, f.name)
    }
    Object.assign(this.handlers, f.handlers)
    if (f.slice) this.slices.push((lj) => f.slice!(lj))
  }

  /** A message from the page, about the journey it shows. */
  onMessage(lj: LoadedJourney, m: FromMap): void {
    (this.handlers[m.type] as PanelHandler<FromMap['type']> | undefined)?.(lj, m)
  }

  /** What the page shows of `lj` besides the journey: every feature's part. */
  state(lj: LoadedJourney): TourInfo {
    return Object.assign({}, ...this.slices.map((s) => s(lj))) as TourInfo
  }
}

/** Handlers for a family of messages (`podcast*`) given to one function: the family's owner switches on them. */
export function handleAll<K extends FromMap['type']>(types: readonly K[], f: (lj: LoadedJourney, m: PanelMessage<K>) => void): PanelHandlers {
  return Object.fromEntries(types.map((t) => [t, f])) as PanelHandlers
}
