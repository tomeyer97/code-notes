// Code Notes: notes on code that agents answer in threads, and code journeys. This file starts the extension: it makes
// the shared services (app.ts), hands each part what it watches, and registers the commands (each one a call into the
// module that does it). activate reads as the boot order; each step runs in the order its parts need each other.

import * as vscode from 'vscode'
import { beats, cfg, claudeLinks, codeLinks, controller, extVersion, journeys, KEY, log, mapPanel, notes, provide, setCtx, setKey, store, stored, tourItems, tutorialSpot, understanding, valueHints } from './app'
import { askClaudeCommand, cancelClaudeCommand } from './ask/commands'
import { askStatusItem, createAskStatusItem, loadAskErrors } from './ask/run'
import { watchClaudeCli } from './ask/settings'
import { Beats } from './codeLinks/beats'
import { answerCheck, checkConcern, createUnderstanding, gradeCheck } from './check/wiring'
import { next, prefixUsed, previous, resolveNext } from './chords'
import { ClaudeLinks } from './codeLinks/claudeChatLinks'
import { codeLinkBack, openCodeLink } from './codeLinks/codeLinkClick'
import { CodeLinks } from './codeLinks/codeLinks'
import { devReload } from './platform/devReload'
import { initIdentity, me, rememberMe } from './notes/identity'
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
import { markJourneysSeen } from './notes/seen'
import { createJourneysView, searchJourneys, journeysHereAll, sortJourneys } from './sidebar/journeysTree'
import { groupByFile, groupBySession, hideResolvedNotes, loadGroupMode, pickFilter, showResolvedNotes } from './sidebar/notesFilter'
import { createNotesView, rowsSelected, treeView } from './sidebar/notesTree'
import { Store } from './notes/store'
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
import { TutorialSpot } from './tour/tutorialSpot'
import { ValueHints } from './codeLinks/valueHints'
import { reloadAll, watchBranches, watchEditors, watchEdits, watchFiles, watchJourneys } from './watch'
import { refreshJourney } from './write/refreshJourney'
import { askQuestion, watchRequests } from './write/requests'
import { writingChanged } from './write/inProgress'
import { fireAndForget, useWindow } from './platform/run'
import { runMigrations, STATE, StateStore } from './platform/state'
import { Cmd, HiddenCmd } from './platform/commands'

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
  provide({ stored: new StateStore(context.workspaceState, context.globalState) })
  loadAskErrors()
  provide({ extVersion: String(context.extension.packageJSON?.version ?? extVersion) })
  // No claude CLI: no Ask Claude anywhere; the setting's description says how to get it.
  watchClaudeCli(context)
  context.subscriptions.push(writingChanged)
  provide({ extUri: context.extensionUri })
  loadGroupMode()
  provide({ log: vscode.window.createOutputChannel('Code Notes', { log: true }) })
  useWindow({ log, showErrorMessage: (text, ...items) => vscode.window.showErrorMessage(text, ...items) })
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
  provide({ journeys: new Journeys(log, stored) })
  devReload(context, log)
  provide({ beats: new Beats(log), tutorialSpot: new TutorialSpot(), codeLinks: new CodeLinks(log) })
  provide({ claudeLinks: new ClaudeLinks(log, () => cfg().get<boolean>('claudeLinks', true)) })
  provide({ valueHints: new ValueHints(log, () => codeLinks.backAt, codeLinks.onDidChange) })
  context.subscriptions.push(tutorialSpot, claudeLinks, beats, codeLinks, valueHints)
  setKey(stored.get(STATE.chordPrefix) ?? KEY)
  provide({ mapPanel: new MapPanel(context.extensionUri, log, onMapMessage, mapState, stored) })
}

/** The step card, the step pages, the map panel restored after a reload (it waits for the journeys: call the function
 *  returned once they are read), and the notes' marks. */
function createTourUi(context: vscode.ExtensionContext): () => void {
  createCard(context)
  registerRefPages(context)
  const journeysLoaded = restoreMapPanel(context)
  createDecorations()
  fireAndForget(setCtx('codeNotes.showResolved', false), 'extension: setCtx codeNotes.showResolved')
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
  await runMigrations(stored, { notes: () => notes().map((n) => n.data) }).then(
    (ran) => { for (const m of ran) log.info(`migrated: ${m}`) },
    (e) => log.error(`migrating the stored state: ${e}`), // tried again at the next start
  )
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
      [Cmd.add]: chord(() => { podcasts.hold('note'); return addNote() }),
      [Cmd.addQuick]: addQuickNote,
      [Cmd.addPathNote]: (uri?: vscode.Uri, text?: string) => addPathNote(uri, text),
      [Cmd.askFromThread]: askFromThread,
      [Cmd.createFromThread]: async (...a: Parameters<typeof createFromThread>) => {
        try { return await createFromThread(...a) } finally { podcasts.released('note') }
      },
      [Cmd.askClaude]: askClaudeCommand,
      [Cmd.cancelClaude]: cancelClaudeCommand,
      [Cmd.reply]: replyTo,
      [Cmd.replyReopen]: replyTo, // the same, labelled for resolved threads
      [Cmd.replyResolve]: replyAndResolve,
      [Cmd.applySuggestion]: (id: string, mi: number, k: number) => applySuggestion(id, mi, k),
    },
    // Notes: resolving, deleting, moving, reading.
    {
      [Cmd.resolve]: async (arg?: any, many?: any[]) => resolve(await pickNotes(arg, many)),
      [Cmd.reopen]: reopenNotes,
      [Cmd.delete]: deleteNotes,
      [Cmd.resolveChecked]: resolveChecked,
      [Cmd.resolveAll]: resolveAll,
      [Cmd.deleteResolved]: deleteResolved,
      [Cmd.undo]: undo,
      [Cmd.acceptCode]: acceptCode,
      [Cmd.moveToSelection]: moveToSelection,
      [Cmd.completeMove]: completeMove,
      [Cmd.cancelMove]: cancelMove,
      [Cmd.markUnread]: markUnread,
      [Cmd.markAllRead]: markAllRead,
      [Cmd.nextUnread]: () => stepUnread(1),
      [Cmd.previousUnread]: () => stepUnread(-1),
    },
    // Notes: opening, threads, the list.
    {
      [Cmd.reveal]: revealCommand,
      [Cmd.openAt]: openAt,
      [Cmd.openNoteFile]: openNoteFile,
      [HiddenCmd.openNoteId]: openNoteId,
      [Cmd.openBroken]: openBroken,
      [Cmd.restoreBroken]: restoreBroken,
      [Cmd.expandThread]: expandThread,
      [Cmd.collapseThread]: collapseThread,
      [Cmd.find]: findNote,
      [Cmd.refresh]: reloadAll,
      [Cmd.copyAgentPrompt]: copyAgentPrompt,
      [Cmd.copyNotePrompt]: copyNotePrompt,
    },
    // The Code Notes view: sessions, filter, grouping (sidebar/).
    {
      [Cmd.hideSession]: hideSession,
      [Cmd.showSession]: showSession,
      [Cmd.showOnlySession]: showOnlySession,
      [Cmd.showAllSessions]: showAllSessions,
      [Cmd.resolveSession]: resolveSession,
      [Cmd.deleteSession]: deleteSession,
      [Cmd.showResolved]: showResolvedNotes,
      [Cmd.hideResolved]: hideResolvedNotes,
      [Cmd.filter]: pickFilter,
      [Cmd.filterActive]: () => vscode.commands.executeCommand(Cmd.filter),
      [Cmd.groupByFile]: groupByFile,
      [Cmd.groupBySession]: groupBySession,
    },
    // Chord keys: Ctrl+' then a letter (chords.ts).
    {
      [Cmd.next]: next,
      [Cmd.previous]: previous,
      [Cmd.resolveNext]: resolveNext,
    },
    // Journeys and their tour (tour/, sidebar/journeysTree.ts, write/).
    {
      [HiddenCmd.codeLink]: openCodeLink,
      [HiddenCmd.codeLinkBack]: codeLinkBack,
      [Cmd.openJourney]: openJourney,
      [Cmd.showMap]: showMap,
      [Cmd.startJourney]: startJourney,
      [Cmd.nextStep]: () => walk.stepBy(1),
      [Cmd.previousStep]: () => walk.stepBy(-1),
      [Cmd.endJourney]: endJourney,
      [HiddenCmd.openStepLink]: openStepLink,
      [Cmd.toggleAuthorMode]: toggleAuthorMode,
      [Cmd.toggleAnimation]: chord(toggleAnimation),
      [Cmd.playPodcast]: (arg?: unknown) => podcasts.play(arg),
      // The greyed ▶ of a podcast that can't be played (disabled in the menu): why, if it is ever run.
      [Cmd.podcastToggle]: chord(() => podcasts.toggle()),
      [Cmd.podcastBack]: chord(() => podcasts.back()),
      [Cmd.podcastForward]: chord(() => podcasts.forward()),
      [Cmd.podcastPrevStep]: chord(() => podcasts.part(-1)),
      [Cmd.podcastNextStep]: chord(() => podcasts.part(1)),
      [Cmd.podcastOpen]: () => podcasts.openSessionMap(),
      // The row's ⏸ (listening) and ▶ Resume (paused there).
      // "Follow along" on the step card: the editor follows the voice again (podcast/follow.ts).
      [HiddenCmd.podcastFollow]: () => podcasts.followAlong(),
      [Cmd.askQuestion]: askQuestion,
      [Cmd.backToStep]: backToStep,
      [Cmd.askStep]: (text?: string) => askStep(text),
      [HiddenCmd.askStepUpdate]: () => askUpdate(),
      [Cmd.tutorial]: tutorial,
      [Cmd.stepDetails]: stepDetails,
      [Cmd.searchJourneys]: chord(searchJourneys),
      [Cmd.refreshJourney]: refreshJourney,
      [Cmd.journeysHereAll]: journeysHereAll,
      [Cmd.sortJourneys]: sortJourneys,
      [Cmd.pickJourneyStep]: pickJourneyStep,
    },
    // The understanding check (check/wiring.ts).
    {
      [Cmd.checkUnderstanding]: () => understanding!.run(),
      [HiddenCmd.nextCheckQuestion]: () => understanding?.step(1),
      [Cmd.answerCheck]: answerCheck,
      [Cmd.checkConcern]: checkConcern,
      [Cmd.gradeCheck]: gradeCheck,
    },
  ]
  for (const group of groups) {
    for (const [id, fn] of Object.entries(group)) context.subscriptions.push(vscode.commands.registerCommand(id, fn))
  }
}
