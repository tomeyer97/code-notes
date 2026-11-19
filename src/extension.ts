// Code Notes: notes on code that agents answer in threads, and code journeys. This file starts the extension: it makes
// the shared services (app.ts), hands each part what it watches, and registers the commands (each one a call into the
// module that does it). activate reads as the boot order; each step runs in the order its parts need each other.

import * as vscode from 'vscode'
import { beats, cfg, claudeLinks, codeLinks, controller, extVersion, gstate, journeys, KEY, log, mapPanel, PREFIX_KEY, provide, setCtx, setKey, state, store, tourItems, tutorialSpot, understanding, valueHints } from './app'
import { askClaudeCommand, cancelClaudeCommand } from './ask/commands'
import { askStatusItem, createAskStatusItem, loadAskErrors } from './ask/run'
import { watchClaudeCli } from './ask/settings'
import { Beats } from './beats'
import { answerCheck, checkConcern, createUnderstanding, gradeCheck } from './check/wiring'
import { next, prefixUsed, previous, resolveNext } from './chords'
import { ClaudeLinks } from './claudeChatLinks'
import { codeLinkBack, openCodeLink } from './codeLinkClick'
import { CodeLinks } from './codeLinks'
import { devReload } from './devReload'
import { initIdentity, me, rememberMe } from './identity'
import { Journeys } from './journeys/journeys'
import { MapPanel } from './journeys/mapPanel'
import { openBroken, restoreBroken } from './notes/broken'
import { followNotesOnDisk, notesChangedOnDisk } from './notes/changedOnDisk'
import { rangeProvider } from './notes/commentRanges'
import { addNote, addPathNote, addQuickNote, askFromThread, createFromThread, NOTE_OPTIONS } from './notes/create'
import { createDecorations, deco } from './notes/decorations'
import { findNote } from './notes/find'
import { rememberFolder } from './notes/folder'
import { acceptCode, cancelMove, completeMove, createMoveItem, moveItem, moveToSelection } from './notes/move'
import { registerPages } from './notes/pages'
import { copyAgentPrompt, copyNotePrompt } from './notes/prompt'
import { replyAndResolve, replyTo } from './notes/reply'
import { openAt, openNoteFile, openNoteId, revealCommand } from './notes/reveal'
import { deleteSession, hideSession, resolveSession, showAllSessions, showOnlySession, showSession } from './notes/sessions'
import { deleteNotes, deleteResolved, offerRestore, reopenNotes, resolve, resolveAll, resolveChecked } from './notes/status'
import { applySuggestion } from './notes/suggestion'
import { undo } from './notes/undo'
import { markAllRead, markUnread, stepUnread } from './notes/unread'
import { pickNotes } from './notes/which'
import { refreshAll } from './refresh'
import { markJourneysSeen, migrateSeen } from './seen'
import { createJourneysView, searchJourneys, journeysHereAll, sortJourneys } from './sidebar/journeysTree'
import { groupByFile, groupBySession, hideResolvedNotes, loadGroupMode, pickFilter, showResolvedNotes } from './sidebar/notesFilter'
import { createNotesView, rowsSelected, treeView } from './sidebar/notesTree'
import { Store } from './store'
import { testApi } from './testApi'
import { collapseThread, expandThread } from './threads/comments'
import { askStep, askUpdate } from './tour/askStep'
import { toggleAuthorMode, mapState, onMapMessage, toggleAnimation } from './tour/mapMessages'
import { backToStep, endJourney, openJourney, openStepLink, restoreMapPanel, restoreTour, showMap, startJourney } from './tour/commands'
import { pickJourneyStep } from './tour/lenses'
import { registerRefPages } from './tour/refs'
import { createCard, createTourItems, stepDetails, walk } from './tour/instances'
import { podcasts } from './podcast/player'
import { tutorial } from './tour/tutorial'
import { TutorialSpot } from './tutorialSpot'
import { ValueHints } from './valueHints'
import { reloadAll, watchBranches, watchEditors, watchEdits, watchFiles, watchJourneys } from './watch'
import { refreshJourney } from './write/refreshJourney'
import { askQuestion, watchRequests } from './write/requests'
import { writingChanged } from './write/inProgress'

const CONTROLLER_ID = 'codeNotes'

export async function activate(context: vscode.ExtensionContext) {
  await startNotes(context)
  createNotesUi(context)
  startJourneys(context)
  const journeysLoaded = createTourUi(context)
  startWatching(context)
  createUnderstanding(context)
  registerCommands(context)
  await watchBranches(context)
  await loadAndShow(context, journeysLoaded)
  return testApi()
}

export function deactivate(): void { /* disposables clean up */ }

/** The stored state, the log, who you are, the notes and their comment controller (app.ts's services, in this order). */
async function startNotes(context: vscode.ExtensionContext): Promise<void> {
  provide({ state: context.workspaceState })
  loadAskErrors()
  provide({ extVersion: String(context.extension.packageJSON?.version ?? extVersion) })
  // No claude CLI: no Ask Claude anywhere; the setting's description says how to get it.
  watchClaudeCli(context)
  context.subscriptions.push(writingChanged)
  provide({ extUri: context.extensionUri })
  loadGroupMode()
  provide({ log: vscode.window.createOutputChannel('Code Notes', { log: true }) })
  await initIdentity(vscode.workspace.workspaceFolders?.[0])
  provide({ store: new Store(log, me) })
  provide({ controller: vscode.comments.createCommentController(CONTROLLER_ID, 'Code Notes') })
}

/** The note box, both views and the status bar items. */
function createNotesUi(context: vscode.ExtensionContext): void {
  // No commenting-range bar on every line (–): the whole file is commentable only while Add Note opens its
  // box (Ctrl+' C, the command); VS Code asks again when the provider is set.
  controller.commentingRangeProvider = rangeProvider
  controller.options = NOTE_OPTIONS
  createJourneysView(context)
  createNotesView(context)
  createAskStatusItem()
  createMoveItem()
  createTourItems()
}

/** The journeys, what lights code (beats, the tutorial's spot, code links, Claude's links, value hints), the chord
 *  prefix and the map panel. */
function startJourneys(context: vscode.ExtensionContext): void {
  provide({ journeys: new Journeys(log, context.workspaceState) })
  devReload(context, log)
  provide({ beats: new Beats(log), tutorialSpot: new TutorialSpot(), codeLinks: new CodeLinks(log) })
  provide({ claudeLinks: new ClaudeLinks(log, () => cfg().get<boolean>('claudeLinks', true)) })
  provide({ valueHints: new ValueHints(log, () => codeLinks.backAt, codeLinks.onDidChange) })
  context.subscriptions.push(tutorialSpot, claudeLinks, beats, codeLinks, valueHints)
  provide({ gstate: context.globalState })
  setKey(gstate.get<string>(PREFIX_KEY) ?? KEY)
  provide({ mapPanel: new MapPanel(context.extensionUri, log, onMapMessage, mapState, state) })
}

/** The step card, the step pages, the map panel restored after a reload (it waits for the journeys: call the function
 *  returned once they are read), and the notes' marks. */
function createTourUi(context: vscode.ExtensionContext): () => void {
  createCard(context)
  registerRefPages(context)
  const journeysLoaded = restoreMapPanel(context)
  createDecorations()
  setCtx('codeNotes.showResolved', false)
  rememberMe()
  context.subscriptions.push(log, store, controller, treeView, askStatusItem, moveItem, ...Object.values(deco), journeys, mapPanel, ...Object.values(tourItems))
  podcasts.init(context)
  return journeysLoaded
}

/** What each part follows (watch.ts and the parts' own). */
function startWatching(context: vscode.ExtensionContext): void {
  watchJourneys(context)
  registerPages(context)
  context.subscriptions.push(store.onDidDeleteOnDisk(offerRestore), store.onDidChange(notesChangedOnDisk))
  watchEdits(context)
  watchFiles(context)
  watchEditors(context)
  context.subscriptions.push(treeView.onDidChangeSelection(rowsSelected))
}

/** Everything read, then shown; the walk and the check where they were. */
async function loadAndShow(context: vscode.ExtensionContext, journeysLoaded: () => void): Promise<void> {
  rememberFolder()
  await store.load()
  await journeys.load()
  await markJourneysSeen()
  journeysLoaded()
  await migrateSeen()
  followNotesOnDisk()
  refreshAll()
  await restoreTour()
  await understanding!.init().catch((e) => log.error(`understanding check: ${e}`))
  watchRequests(context)
}

type Handler = (...a: any[]) => any

/** A chord key's command: says which prefix was pressed (hints show it), then runs. */
const chord = (fn: () => unknown) => (a?: unknown) => { prefixUsed(a); return fn() }

/** The commands (package.json names them; menus and keys call them), by area. Handler names follow the ids, except
 *  where the id's name is taken (reveal, refresh) or the handler lives in another area (see each group). */
function registerCommands(context: vscode.ExtensionContext): void {
  const groups: Record<string, Handler>[] = [
    // Notes: adding, replying, Claude.
    {
      // A note being written pauses a podcast playing (its code stays put under the draft: F52).
      'codeNotes.add': chord(() => { podcasts.hold('note'); return addNote() }),
      'codeNotes.addQuick': addQuickNote,
      'codeNotes.addPathNote': (uri?: vscode.Uri, text?: string) => addPathNote(uri, text),
      'codeNotes.askFromThread': askFromThread,
      'codeNotes.createFromThread': async (...a: Parameters<typeof createFromThread>) => {
        try { return await createFromThread(...a) } finally { podcasts.released('note') }
      },
      'codeNotes.askClaude': askClaudeCommand,
      'codeNotes.cancelClaude': cancelClaudeCommand,
      'codeNotes.reply': replyTo,
      'codeNotes.replyReopen': replyTo, // the same, labelled for resolved threads
      'codeNotes.replyResolve': replyAndResolve,
      'codeNotes.applySuggestion': (id: string, mi: number, k: number) => applySuggestion(id, mi, k),
    },
    // Notes: resolving, deleting, moving, reading.
    {
      'codeNotes.resolve': async (arg?: any, many?: any[]) => resolve(await pickNotes(arg, many)),
      'codeNotes.reopen': reopenNotes,
      'codeNotes.delete': deleteNotes,
      'codeNotes.resolveChecked': resolveChecked,
      'codeNotes.resolveAll': resolveAll,
      'codeNotes.deleteResolved': deleteResolved,
      'codeNotes.undo': undo,
      'codeNotes.acceptCode': acceptCode,
      'codeNotes.moveToSelection': moveToSelection,
      'codeNotes.completeMove': completeMove,
      'codeNotes.cancelMove': cancelMove,
      'codeNotes.markUnread': markUnread,
      'codeNotes.markAllRead': markAllRead,
      'codeNotes.nextUnread': () => stepUnread(1),
      'codeNotes.previousUnread': () => stepUnread(-1),
    },
    // Notes: opening, threads, the list.
    {
      'codeNotes.reveal': revealCommand,
      'codeNotes.openAt': openAt,
      'codeNotes.openNoteFile': openNoteFile,
      'codeNotes.openNoteId': openNoteId,
      'codeNotes.openBroken': openBroken,
      'codeNotes.restoreBroken': restoreBroken,
      'codeNotes.expandThread': expandThread,
      'codeNotes.collapseThread': collapseThread,
      'codeNotes.find': findNote,
      'codeNotes.refresh': reloadAll,
      'codeNotes.copyAgentPrompt': copyAgentPrompt,
      'codeNotes.copyNotePrompt': copyNotePrompt,
    },
    // The Code Notes view: sessions, filter, grouping (sidebar/).
    {
      'codeNotes.hideSession': hideSession,
      'codeNotes.showSession': showSession,
      'codeNotes.showOnlySession': showOnlySession,
      'codeNotes.showAllSessions': showAllSessions,
      'codeNotes.resolveSession': resolveSession,
      'codeNotes.deleteSession': deleteSession,
      'codeNotes.showResolved': showResolvedNotes,
      'codeNotes.hideResolved': hideResolvedNotes,
      'codeNotes.filter': pickFilter,
      'codeNotes.filterActive': () => vscode.commands.executeCommand('codeNotes.filter'),
      'codeNotes.groupByFile': groupByFile,
      'codeNotes.groupBySession': groupBySession,
    },
    // Chord keys: Ctrl+' then a letter (chords.ts).
    {
      'codeNotes.next': next,
      'codeNotes.previous': previous,
      'codeNotes.resolveNext': resolveNext,
    },
    // Journeys and their tour (tour/, sidebar/journeysTree.ts, write/).
    {
      'codeNotes.codeLink': openCodeLink,
      'codeNotes.codeLinkBack': codeLinkBack,
      'codeNotes.openJourney': openJourney,
      'codeNotes.showMap': showMap,
      'codeNotes.startJourney': startJourney,
      'codeNotes.nextStep': () => walk.stepBy(1),
      'codeNotes.previousStep': () => walk.stepBy(-1),
      'codeNotes.endJourney': endJourney,
      'codeNotes.openStepLink': openStepLink,
      'codeNotes.toggleAuthorMode': toggleAuthorMode,
      'codeNotes.toggleAnimation': chord(toggleAnimation),
      'codeNotes.playPodcast': (arg?: unknown) => podcasts.play(arg),
      // The greyed ▶ of a podcast that can't be played (disabled in the menu): why, if it is ever run.
      'codeNotes.podcastToggle': chord(() => podcasts.toggle()),
      'codeNotes.podcastBack': chord(() => podcasts.back()),
      'codeNotes.podcastForward': chord(() => podcasts.forward()),
      'codeNotes.podcastPrevStep': chord(() => podcasts.part(-1)),
      'codeNotes.podcastNextStep': chord(() => podcasts.part(1)),
      'codeNotes.podcastOpen': () => podcasts.openSessionMap(),
      // The row's ⏸ (listening) and ▶ Resume (paused there).
      // "Follow along" on the step card: the editor follows the voice again (podcast/follow.ts).
      'codeNotes.podcastFollow': () => podcasts.followAlong(),
      'codeNotes.askQuestion': askQuestion,
      'codeNotes.backToStep': backToStep,
      'codeNotes.askStep': (text?: string) => askStep(text),
      'codeNotes.askStepUpdate': () => askUpdate(),
      'codeNotes.tutorial': tutorial,
      'codeNotes.stepDetails': stepDetails,
      'codeNotes.searchJourneys': chord(searchJourneys),
      'codeNotes.refreshJourney': refreshJourney,
      'codeNotes.journeysHereAll': journeysHereAll,
      'codeNotes.sortJourneys': sortJourneys,
      'codeNotes.pickJourneyStep': pickJourneyStep,
    },
    // The understanding check (check/wiring.ts).
    {
      'codeNotes.checkUnderstanding': () => understanding!.run(),
      'codeNotes.nextCheckQuestion': () => understanding?.step(1),
      'codeNotes.answerCheck': answerCheck,
      'codeNotes.checkConcern': checkConcern,
      'codeNotes.gradeCheck': gradeCheck,
    },
  ]
  for (const group of groups) {
    for (const [id, fn] of Object.entries(group)) context.subscriptions.push(vscode.commands.registerCommand(id, fn))
  }
}
