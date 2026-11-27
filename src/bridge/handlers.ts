// A controller's requests, each to its handler; every request gets one answer: `ok` with the handler's result, or the
// reason it failed. The params are read first (core/bridge/requests.ts): a bad one never reaches the editor.
import type { BridgeMethod, BridgeRequest, BridgeResponse } from '../protocol/bridge'
import { isMethod, readContextGet, readJourneyPlay, readNoteAdd, readReveal } from '../core/bridge/requests'
import { log } from '../platform/host'
import { editorContext } from './editorContext'
import { HandlerContext, RequestError, valid } from './failure'
import { playJourney } from './journey'
import { addNoteAt, reveal } from './lines'

type Handler = (params: unknown, c: HandlerContext) => Promise<unknown>

const HANDLERS: Record<BridgeMethod, Handler> = {
  'reveal': (p, c) => reveal(valid(readReveal(p)), c),
  'journey.play': (p) => playJourney(valid(readJourneyPlay(p))),
  'note.add': (p, c) => addNoteAt(valid(readNoteAdd(p)), c),
  'context.get': async (p) => editorContext(valid(readContextGet(p))),
}

export async function handleRequest(req: BridgeRequest, c: HandlerContext): Promise<BridgeResponse> {
  if (!isMethod(req.method)) return { type: 'response', id: req.id, ok: false, error: `unknown method: ${req.method || '(none)'}` }
  try {
    const result = await HANDLERS[req.method](req.params, c)
    return { type: 'response', id: req.id, ok: true, result: result ?? null }
  } catch (e) {
    if (e instanceof RequestError) return { type: 'response', id: req.id, ok: false, error: e.message }
    log().error(`bridge: ${req.method}: ${e instanceof Error ? e.stack ?? e.message : e}`)
    return { type: 'response', id: req.id, ok: false, error: `${req.method} failed: ${e instanceof Error ? e.message : e}` }
  }
}
