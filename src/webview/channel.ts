// The extension's end of a webview page's messages (the journey panel, the Listen view, the Check view): the page
// says 'ready' once it listens; what is sent before that waits in a queue. Its errors go to the log.
import type * as vscode from 'vscode'
import { fireAndForget } from '../platform/run'

/** A message either way: a page's protocol (src/protocol/) is a union of these. */
export interface Message { type: string }

export interface ChannelOptions {
  /** Messages sent while no page is attached wait for the next page (default: they are dropped). */
  queueWithoutPage?: boolean
  /** Runs when the page says 'ready', before the queue is sent. */
  onReady?: () => void
}

/** One page's messages: `In` what it posts, `Out` what it is sent (src/protocol/<page>.ts). */
export class WebviewChannel<In extends Message, Out extends Message> {
  private webview: vscode.Webview | undefined
  private isReady = false
  private queue: Out[] = []
  /** The last message sendChanged() sent (its key). */
  private lastKey: string | undefined

  /** `name` starts the log lines ("journey map: …"). */
  constructor(private name: string, private log: vscode.LogOutputChannel, private options: ChannelOptions = {}) {}

  /** The page is attached and has said 'ready'. */
  get ready(): boolean { return !!this.webview && this.isReady }
  get attached(): boolean { return !!this.webview }

  /** Listens to `webview`'s page (a new page: not ready yet); `onMessage` gets every message, 'ready' and 'error' too. */
  attach(webview: vscode.Webview, onMessage: (m: In) => void): vscode.Disposable {
    this.webview = webview
    this.isReady = false
    this.lastKey = undefined
    return webview.onDidReceiveMessage((m: In) => {
      if (m?.type === 'ready') this.markReady()
      else if (m?.type === 'error') {
        const e = m as unknown as { message?: unknown; text?: unknown }
        this.log.error(`${this.name}: ${String(e.text ?? e.message)}`)
      }
      onMessage(m)
    })
  }

  private markReady(): void {
    this.isReady = true
    this.lastKey = undefined
    this.options.onReady?.()
    for (const q of this.queue.splice(0)) this.post(q)
  }

  /** The page went (disposed): nothing is sent until the next one is attached. */
  detach(): void {
    this.webview = undefined
    this.isReady = false
    this.lastKey = undefined
    if (!this.options.queueWithoutPage) this.queue = []
  }

  /** `m` once the page is ready (queued until then). */
  send(m: Out): void {
    if (this.ready) this.post(m)
    else if (this.webview || this.options.queueWithoutPage) this.queue.push(m)
  }

  /** `m` now, ready or not (a page that is not listening yet misses it). */
  sendNow(m: Out): void {
    if (this.webview) this.post(m)
  }

  /** `m` if the page is ready and `key` differs from the last one sent this way (each post is a message to the
   *  window: the same view twice is sent once). */
  sendChanged(m: Out, key: string = JSON.stringify(m)): void {
    if (!this.ready || key === this.lastKey) return
    this.lastKey = key
    this.post(m)
  }

  private post(m: Out): void {
    const w = this.webview
    if (w) fireAndForget(w.postMessage(m), `${this.name}: postMessage ${m.type}`)
  }
}
