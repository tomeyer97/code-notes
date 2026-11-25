// The integration tests' entry (test/integration): what the extension shows, read through each feature's API, and
// hooks that drive what a person would (answer a pick, type into a box, send the map a message). activate returns it
// only outside Production (extension.ts loads this file then); a shipped extension has no test surface.

import * as vscode from 'vscode'
import type { CheckFeature } from './check'
import type { CodeLinksFeature } from './codeLinks'
import type { JourneysFeature } from './journeys'
import type { NotesFeature } from './notes'
import type { Host } from './platform/host'
import type { PodcastFeature } from './podcast'
import type { TourFeature } from './tour'
import { askErrors, asking } from './ask/run'
import { me } from './notes/identity'
import { Note } from './notes/store'
import { applySuggestion } from './notes/suggestion'
import { unread } from './notes/seen'
import { byId, visibleNotes } from './notes/visible'
import { journeysTree } from './sidebar/journeysTree'
import { journeyItem } from './sidebar/journeyRows'
import { listModel } from './sidebar/listModel'
import { cached, Node } from './sidebar/nodes'
import { matchesFilter, order, sessionOf } from './notes/model'
import { tree, treeView } from './sidebar/notesTree'
import { placement } from './notes/location'
import { threads } from './threads/sync'
import { resetTutorial, restorePanel, tourSnapshot } from './tour/testing'
import { podcastProbe } from './podcast/testing'
import { answerClarify, clarify } from './write/clarify'
import { choosing, confirming } from './write/rank'
import { requestLog } from './write/requests'
import { writeJourney } from './write/writeJourney'
import { writingRows } from './write/journeyJobs'
import type { FromMap as MapMessage, ToMap } from './protocol/map'
import type { ToCheck } from './protocol/check'
import type { ToListen } from './protocol/listen'
import { stepDraftKey } from './platform/keys'

/** What `activate` returns outside Production (src/extension.ts): the integration tests import this type, not `any`. */
export type TestApi = ReturnType<typeof testApi>

/** A tree view as text: one line per row, indented by depth (kind:label · description [icon]); `foldedJourneys`: a
 *  collapsed "journeys" row says {collapsed}. */
function treeAsText(view: { getTreeItem(x: Node): vscode.TreeItem; getChildren(x?: Node): Node[] }, foldedJourneys = false): string[] {
  const out: string[] = []
  const visit = (nodes: Node[], depth: number) => {
    for (const x of nodes) {
      const it = view.getTreeItem(x)
      const label = typeof it.label === 'string' ? it.label : it.label?.label
      const description = it.description ? ` · ${it.description}` : ''
      const icon = it.iconPath instanceof vscode.ThemeIcon ? ` [${it.iconPath.id}]` : ''
      const folded = foldedJourneys && x.kind === 'journeys' && it.collapsibleState === vscode.TreeItemCollapsibleState.Collapsed ? ' {collapsed}' : ''
      out.push(`${'  '.repeat(depth)}${x.kind}:${label}${description}${icon}${folded}`)
      visit(view.getChildren(x), depth + 1)
    }
  }
  visit(view.getChildren(), 0)
  return out
}

/** A note as the snapshot has it: its data, file path, and what the editor and the list show of it. */
function noteSnapshot(n: Note) {
  const id = n.data.id
  const thread = threads.get(id)
  return {
    ...n.data,
    path: n.uri.path,
    unread: unread(n),
    missing: placement.missing(id),
    threadLabel: thread?.label,
    hasThread: threads.has(id),
    threadExpanded: thread?.collapsibleState === vscode.CommentThreadCollapsibleState.Expanded,
    asking: asking.has(id),
    askError: askErrors.get(id),
  }
}

/** The features the tests read (activate made them: src/extension.ts). */
export interface TestedFeatures {
  host: Host
  notes: NotesFeature
  journeys: JourneysFeature
  codeLinks: CodeLinksFeature
  tour: TourFeature
  check: CheckFeature
  podcast: PodcastFeature
}

export function testApi(f: TestedFeatures) {
  const { notes, journeys: { journeys, mapPanel }, codeLinks, tour, check } = f
  const { walk, state, asks } = tour.parts
  const podcast = podcastProbe(f.podcast, { journeys, mapPanel })
  return {
    snapshot: () => ({
      claudeLinks: codeLinks.claudeLinks.state,
      notes: visibleNotes().sort(order).map(noteSnapshot),
      broken: notes.store.brokenCount(),
      badge: treeView.badge?.value ?? 0,
      me: me(),
      journeys: journeys.all().map((x) => ({ id: x.j.id, steps: x.j.steps.length, at: x.at, resume: walk.resumeAt(x) })),
      tour: tourSnapshot(tour, { mapPanel, ...codeLinks }),
      /** The sidebar as text: one line per row, indented by depth (label · description · icon). */
      tree: () => treeAsText(tree, true),
      groupBy: notes.model.query.groupMode,
      /** The sidebar's children of a session, as note ids. */
      sessionOrder: (name: string) => {
        const node = cached(`session:${name}`, { kind: 'session', name, notes: visibleNotes().filter((x) => sessionOf(x) === name && matchesFilter(x)) })
        return tree.getChildren(node).map((x) => (x.kind === 'note' ? x.note.data.id : x.kind))
      },
    }),
    thread: (id: string) => threads.get(id),
    /** The list model (journeyList.ts) as the sidebar draws it, and the Journeys view as text. */
    journeyList: (o?: { query?: string }) => listModel(o),
    journeysTree: () => treeAsText(journeysTree),
    /** The understanding check: status, status bar, panel view and what the panel reported. */
    check: () => check.controller.snapshot(),
    checkPanelSend: (m: ToCheck) => check.controller.panelSend(m),
    /** `force` false: as a trigger does (skipped when nothing it reads changed). */
    checkRefresh: (force = true) => check.controller.refresh(force),
    /** A new worker for the check's git work (it takes the extension host's environment as it is now). */
    checkRestartWorker: () => check.controller.restartWorker(),
    /** Opens a check question as the Check view's row does. */
    checkOpenQuestion: (id: string) => check.controller.open(id),
    /** The stored state (workspace, global): the round-trip test counts its writes. */
    mementos: () => f.host.stored.mementos(),
    /** Sends a message into the map webview (tests drive its real click/key handlers this way). */
    mapSend: (m: ToMap) => mapPanel.send(m),
    /** A message for the Listen view (where the audio plays): a podcastCmd as the extension sends it. */
    listenSend: (m: ToListen) => podcast.listenSend(m),
    /** The Listen view ignores the extension's pauses (a camera wait that can't pause the audio). */
    listenIgnorePauses: (on: boolean) => podcast.listenIgnorePauses(on),
    /** A message as if the journey panel posted it (a beat the reader picked in the animation, …). */
    mapMessage: (m: MapMessage) => { if (mapPanel.journey) tour.onMapMessage(mapPanel.journey, m) },
    /** A map panel as VS Code hands one over after a reload, drawn once `ready` resolves (tour/commands.ts). */
    restorePanel: (panel: vscode.WebviewPanel, ready: Promise<void>) => restorePanel(panel, undefined, ready),
    /** The podcast (src/podcast/testing.ts): which journeys have one, where the audio is, what it last moved. */
    podcast: () => podcast.snapshot(),
    /** A journey's row in the Journeys view (by journey id): its context value (which inline buttons) and tooltip. */
    journeyRow: (id: string) => {
      const lj = journeys.all().find((x) => x.j.id === id)
      const it = lj && journeyItem(lj)
      const icon = it?.iconPath instanceof vscode.ThemeIcon ? it.iconPath.id : it?.iconPath ? 'other' : undefined
      return it && { contextValue: it.contextValue, tooltip: typeof it.tooltip === 'string' ? it.tooltip : it.tooltip?.value, description: typeof it.description === 'string' ? it.description : undefined, icon }
    },
    resetTutorial,
    /** Forgets the tour in memory and restores it from workspace state, as after a window reload. */
    reloadTour: async () => {
      walk.forgetTour()
      walk.updateTour()
      await tour.restore()
    },
    applySuggestion,
    /** the picker's "Ask the agent to write a journey" item, without the picker. */
    writeJourney: (q: string) => writeJourney(q).then((x) => x?.j.id),
    /** Journeys being written now: the rows a list shows. */
    writing: () => writingRows(),
    /** The pending "Write one with Claude?": its title and items; answer it by item label ('$(sparkle) Write', 'Cancel', a journey's). */
    confirming: () => confirming && { title: confirming.qp.title, question: confirming.question, items: confirming.qp.items.filter((x) => x.kind !== vscode.QuickPickItemKind.Separator).map((x) => x.label) },
    answerConfirm: (label: string) => {
      const c = confirming
      const it = c?.qp.items.find((x) => x.label === label || x.label.endsWith(` ${label}`))
      if (c && it) c.accept(it)
      return !!it
    },
    /** Claude's question before writing, and answering it. */
    clarify: () => clarify && { question: clarify.question, session: clarify.session, text: clarify.text },
    answerClarify: (text: string) => answerClarify(text).then((x) => x?.j.id),
    /** The open Ask box on a step: type into it and press Enter. */
    askBox: () => asks.open && { title: asks.open.box.title, value: asks.open.box.value },
    askBoxSend: (text: string) => {
      const b = asks.open
      if (!b) return false
      b.box.value = text
      const lj = walk.tourJourney()
      asks.drafts.set(stepDraftKey(lj?.j.id, lj?.j.steps[state.step - 1]?.id), text)
      b.accept()
      return true
    },
    /** The pick: its journeys' titles, and choosing one. */
    choosing: () => choosing?.titles,
    choose: (title: string) => choosing?.accept(title),
    /** What each request did. */
    explainLog: () => requestLog.map((x) => ({ ...x })),
    /** Reads every journey file again, as after a window reload. */
    reloadJourneys: () => journeys.load(),
  }
}
