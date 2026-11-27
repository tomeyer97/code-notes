// What every handler shares: the failure it says as it is, and what it has besides its params.
import type { Read } from '../core/bridge/requests'
import type { BridgeTarget } from '../core/bridge/discovery'
import type { Callout } from './callout'

/** A failure to say as it is (a missing file, an unknown journey), not a bug to log. */
export class RequestError extends Error {}

/** What a handler has besides its params: who asks (its name is a note's author) and the callout. */
export interface HandlerContext { controller: BridgeTarget; callout: Callout }

/** The params read, or the reason as the request's error. */
export function valid<T>(r: Read<T>): T {
  if (!r.ok) throw new RequestError(r.error)
  return r.value
}
