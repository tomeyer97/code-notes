// For the integration test (test/integration): a read-only view of what the extension shows, and hooks that drive
// what a person would (answer a pick, type into a box, send the map a message).

import * as vscode from 'vscode'
import { beats, claudeLinks, codeLinks, gstate, journeys, KEY, mapPanel, notes, state, store, tourItems, tutorialSpot, understanding, valueHints } from './app'
import { askErrors, asking } from './ask'
import { me } from './identity'
import { applySuggestion } from './notes/suggestion'
import { unread } from './seen'
import { journeysTree } from './sidebar/journeysTree'
import { listModel } from './sidebar/listModel'
import { cached, Node, order, sessionOf } from './sidebar/nodes'
import { groupMode, matchesFilter } from './sidebar/notesFilter'
import { tree, treeView } from './sidebar/notesTree'
import { missing } from './threads/anchoring'
import { threads } from './threads/threads'
import { askDrafts, stepAskBox } from './tour/askStep'
import { restoreTour } from './tour/commands'
import { card, tourState, walk } from './tour/instances'
import { resetTutorial, TUTORIAL_KEY, tutorialMark, tutorialSeen } from './tour/tutorial'
import { answerClarify, clarify } from './write/clarify'
import { choosing, confirming } from './write/rank'
import { requestLog } from './write/requests'
import { writeJourney } from './write/writeJourney'
import { writingRows } from './write/inProgress'

/** What `activate` returns (src/extension.ts): the integration tests import this type, not `any`. */
export type TestApi = ReturnType<typeof testApi>

export function testApi() {
  return {
    snapshot: () => ({
      claudeLinks: claudeLinks.state,
      notes: notes().sort(order).map((n) => ({ ...n.data, path: n.uri.path, unread: unread(n), missing: missing.has(n.data.id), threadLabel: threads.get(n.data.id)?.label, hasThread: threads.has(n.data.id), threadExpanded: threads.get(n.data.id)?.collapsibleState === vscode.CommentThreadCollapsibleState.Expanded, asking: asking.has(n.data.id), askError: askErrors.get(n.data.id) })),
      broken: store.broken.size,
      badge: treeView.badge?.value ?? 0,
      me: me(),
      journeys: journeys.all().map((x) => ({ id: x.j.id, steps: x.j.steps.length, at: x.at, resume: walk.resumeAt(x) })),
      tour: {
        journey: walk.tourJourney()?.j.id, step: tourState.step, touring: walk.touring(), cp: tourState.checkpointId, story: mapPanel.story, map: mapPanel.journey?.j.id, mapTitle: mapPanel.tabTitle, mapBoxes: mapPanel.rendered, mapFocus: mapPanel.focus,
        beat: beats.lit, beatCode: beats.preview, codeLinks: codeLinks.state, values: valueHints.state, mapColumn: mapPanel.viewColumn, codeColumn: tourState.doc?.column, status: tourItems.pos.text, statusShown: !!tourItems.pos.text && walk.touring(),
        tutorial: { ...tutorialSeen, seen: !!gstate.get(TUTORIAL_KEY), spot: tutorialSpot.shown, mark: tutorialMark }, key: KEY, lastLeft: tourState.lastLeft, fileGone: tourState.fileGone,
        panelCard: walk.touring() && card.inMap(walk.tourJourney()!, tourState.step) ? card.panelCard(walk.tourJourney()!, tourState.step) : undefined, ref: tourState.refHere, peek: tourState.lastPeek, marked: tourState.marked,
        card: card.thread ? { file: card.thread.uri.path, line: card.thread.range?.start.line, label: card.thread.label, title: card.thread.label?.replace(/^\d+\/\d+ · /, ''),
          body: (card.thread.comments[0]?.body as vscode.MarkdownString | undefined)?.value, canReply: card.thread.canReply, expanded: card.thread.collapsibleState === vscode.CommentThreadCollapsibleState.Expanded } : undefined,
      },
      /** The sidebar as text: one line per row, indented by depth (label · description · icon). */
      tree: () => {
        const out: string[] = []
        const visit = (nodes: Node[], depth: number) => {
          for (const x of nodes) {
            const it = tree.getTreeItem(x)
            const label = typeof it.label === 'string' ? it.label : it.label?.label
            const folded = x.kind === 'journeys' && it.collapsibleState === vscode.TreeItemCollapsibleState.Collapsed ? ' {collapsed}' : ''
            out.push(`${'  '.repeat(depth)}${x.kind}:${label}${it.description ? ` · ${it.description}` : ''}${it.iconPath instanceof vscode.ThemeIcon ? ` [${it.iconPath.id}]` : ''}${folded}`)
            visit(tree.getChildren(x), depth + 1)
          }
        }
        visit(tree.getChildren(), 0)
        return out
      },
      groupBy: groupMode,
      /** The sidebar's children of a session, as note ids. */
      sessionOrder: (name: string) => tree.getChildren(cached(`session:${name}`, { kind: 'session', name, notes: notes().filter((x) => sessionOf(x) === name && matchesFilter(x)) }))
        .map((x) => (x.kind === 'note' ? x.note.data.id : x.kind)),
    }),
    thread: (id: string) => threads.get(id),
    /** The list model (journeyList.ts) as the sidebar draws it, and the Journeys view as text. */
    journeyList: (o?: { query?: string }) => listModel(o),
    journeysTree: () => {
      const out: string[] = []
      const visit = (ns: Node[], d: number) => { for (const x of ns) { const it = journeysTree.getTreeItem(x); const label = typeof it.label === 'string' ? it.label : it.label?.label; out.push(`${'  '.repeat(d)}${x.kind}:${label}${it.description ? ` · ${it.description}` : ''}${it.iconPath instanceof vscode.ThemeIcon ? ` [${it.iconPath.id}]` : ''}`); visit(journeysTree.getChildren(x), d + 1) } }
      visit(journeysTree.getChildren(), 0)
      return out
    },
    /** The understanding check: status, status bar, panel view and what the panel reported. */
    check: () => understanding?.snapshot(),
    checkPanelSend: (m: unknown) => understanding?.panelSend(m),
    /** `force` false: as a trigger does (skipped when nothing it reads changed). */
    checkRefresh: (force = true) => understanding?.refresh(force),
    /** A new worker for the check's git work (it takes the extension host's environment as it is now). */
    checkRestartWorker: () => understanding?.restartWorker(),
    /** Opens a check question as the Check view's row does. */
    checkOpenQuestion: (id: string) => understanding?.open(id),
    /** The stored state (workspace, global): the round-trip test counts its writes. */
    mementos: () => [state, gstate],
    /** Sends a message into the map webview (tests drive its real click/key handlers this way). */
    mapSend: (m: unknown) => mapPanel.send(m),
    resetTutorial,
    /** Forgets the tour in memory and restores it from workspace state, as after a window reload. */
    reloadTour: async () => {
      card.clear(); tourState.key = undefined; tourState.step = 0; tourState.doc = undefined; walk.updateTour()
      await restoreTour()
    },
    applySuggestion,
    /** the picker's "Ask the agent to write a journey" item, without the picker. */
    writeJourney: (q: string) => writeJourney(q).then((x) => x?.j.id),
    /** Journeys being written now: the rows a list shows. */
    writing: () => writingRows(),
    /** The pending "Write one with Claude?": its title and items; answer it by item label ('$(sparkle) Write', 'Cancel', a journey's). */
    confirming: () => confirming && { title: confirming.qp.title, question: confirming.question, items: confirming.qp.items.filter((x) => x.kind !== vscode.QuickPickItemKind.Separator).map((x) => x.label) },
    answerConfirm: (label: string) => { const c = confirming; const it = c?.qp.items.find((x) => x.label === label || x.label.endsWith(` ${label}`)); if (c && it) c.accept(it); return !!it },
    /** Claude's question before writing, and answering it. */
    clarify: () => clarify && { question: clarify.question, session: clarify.session, text: clarify.text },
    answerClarify: (text: string) => answerClarify(text).then((x) => x?.j.id),
    /** The open Ask box on a step: type into it and press Enter. */
    askBox: () => stepAskBox && { title: stepAskBox.box.title, value: stepAskBox.box.value },
    askBoxSend: (text: string) => { const b = stepAskBox; if (!b) return false; b.box.value = text; askDrafts.set(`${walk.tourJourney()?.j.id}|${walk.tourJourney()?.j.steps[tourState.step - 1]?.id}`, text); b.accept(); return true },
    /** The pick: its journeys' titles, and choosing one. */
    choosing: () => choosing?.titles,
    choose: (title: string) => choosing?.accept(title),
    /** What each request did. */
    explainLog: () => requestLog.map((x) => ({ ...x })),
    /** Reads every journey file again, as after a window reload. */
    reloadJourneys: () => journeys.load(),
  }
}
