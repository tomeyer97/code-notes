import { test } from 'node:test'
import assert from 'node:assert/strict'
import type * as vscodeTypes from 'vscode'
import { fakeWebviewView, StatusBarItem, vscode } from './journey-podcast/fakeVscode'
import { AudioHost, AudioHostClient } from '../src/podcast/audioHost'
import { ListenStatusItem } from '../src/podcast/statusItem'
import type { LoadedJourney } from '../src/journeys/steps'

// One player at a time (src/podcast/audioHost.ts, statusItem.ts) on a fake VS Code: the Listen view is there only
// while the journey panel does not have the audio, and VS Code drops its page when it goes. The audio going back
// (the panel closed, or showing another journey) makes the view again and loads the episode there, where it was.

const log = { warn: () => undefined, error: () => undefined, info: () => undefined, debug: () => undefined } as unknown as vscodeTypes.LogOutputChannel
const lj = { key: 'k1', j: { id: 'order', title: 'Order and payment' } } as unknown as LoadedJourney
const other = { key: 'k2', j: { id: 'other', title: 'Other' } } as unknown as LoadedJourney

function setup() {
  const toListen: { type: string; [k: string]: unknown }[] = []
  const toPanel: { type: string; [k: string]: unknown }[] = []
  const said = { lost: 0, moved: 0 }
  const panel: { journey: LoadedJourney | undefined } = { journey: lj }
  const ports = {
    journeys: () => ({ list: new Map([[lj.key, lj], [other.key, other]]) }),
    mapPanel: () => ({ journey: panel.journey, send: (m: { type: string }) => { toPanel.push(m) } }),
    tour: () => ({ showMap: () => undefined }),
  }
  const client = {
    episodeFor: (x: LoadedJourney) => ({ key: x.key, title: x.j.title, journey: x.j.title, src: 'a.mp3', duration: 40, at: 0 }),
    posOf: () => 0,
    nowOf: () => 12,
    listening: () => lj,
    playing: () => true,
    lost: () => { said.lost++ },
    moved: () => { said.moved++ },
  } as unknown as AudioHostClient
  const host = new AudioHost(vscode.Uri.file('/ext') as unknown as vscodeTypes.Uri, () => log, ports as never, client)
  // Each focus of the view makes a new page, which says it is ready.
  const pages: ReturnType<typeof fakeWebviewView>[] = []
  vscode.commands.ran = []
  vscode.commands.handlers = {
    'codeNotes.listen.focus': () => {
      const page = fakeWebviewView((m) => { toListen.push(m as { type: string }) }, 'file:')
      pages.push(page)
      host.listen.resolveWebviewView(page.view as unknown as vscodeTypes.WebviewView)
      page.fromPage({ type: 'ready' })
    },
  }
  return { host, toListen, toPanel, said, panel, pages }
}

const settle = () => new Promise<void>((r) => setImmediate(r))

/** The audio in the panel, and the Listen view gone with it (its `when` off). */
async function inPanel() {
  const s = setup()
  assert.equal(await s.host.listen.ensure(), true)
  s.host.moveTo('panel', lj, { at: 3, play: true })
  assert.equal(s.host.panelHosts, true)
  s.pages[0].dispose()
  assert.equal(s.said.lost, 0, 'the view going with the panel playing loses nothing')
  s.toListen.length = 0
  s.toPanel.length = 0
  return s
}

test('the panel closed after the Listen view went: the view made again, the audio there where it was, playing on', async () => {
  const s = await inPanel()
  s.panel.journey = undefined
  s.host.panelClosed()
  assert.equal(s.host.in, 'listen')
  assert.equal(s.host.panelHosts, false)
  for (let i = 0; i < 5; i++) await settle()
  assert.equal(s.pages.length, 2, 'a new Listen page')
  const ep = s.toListen.find((m) => m.type === 'podcast')?.episode as { key: string; at: number; play?: boolean }
  assert.deepEqual([ep?.key, ep?.at, ep?.play], ['k1', 12, true], 'its episode, where the audio was, asked to play')
  assert.equal(s.host.key, 'k1')
  assert.equal(s.host.has('k1'), true)
  assert.equal(s.said.lost, 0)
})

test('the panel showing another journey: it stops being the host at once; the audio goes to a new Listen view', async () => {
  const s = await inPanel()
  s.panel.journey = other
  s.host.panelShows(other)
  assert.deepEqual(s.toPanel.find((m) => m.type === 'podcastRole'), { type: 'podcastRole', role: 'remote' }, 'the panel a remote before its new episode')
  for (let i = 0; i < 5; i++) await settle()
  const ep = s.toListen.find((m) => m.type === 'podcast')?.episode as { key: string; at: number }
  assert.deepEqual([ep?.key, ep?.at], ['k1', 12])
  assert.equal(s.host.in, 'listen')
})

test('the status item: the Listen view off while the panel has the audio, on otherwise; it names the journey', () => {
  const ctx: [string, unknown][] = []
  vscode.commands.handlers = { setContext: (k, v) => { ctx.push([k as string, v]) } }
  const item = new ListenStatusItem(() => true, () => undefined)
  const shown = (item as unknown as { item: StatusBarItem }).item
  const base = { journey: lj, playing: false, ended: false, t: 39, panelOnScreen: true }
  item.render({ ...base, panelHosts: true })
  assert.deepEqual(ctx.filter(([k]) => k === 'codeNotes.listening').at(-1), ['codeNotes.listening', false])
  assert.deepEqual(ctx.filter(([k]) => k === 'codeNotes.listenSession').at(-1), ['codeNotes.listenSession', true], 'the transport commands stay')
  assert.equal(shown.shown, false, 'no item while the panel is on screen')
  item.render({ ...base, panelOnScreen: false, panelHosts: false })
  assert.deepEqual(ctx.filter(([k]) => k === 'codeNotes.listening').at(-1), ['codeNotes.listening', true])
  assert.equal(shown.text, 'Paused: Order and payment · 0:39')
  assert.equal(shown.shown, true)
  item.dispose()
})
