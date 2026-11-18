// Code Notes: notes on code that agents answer in threads, and code journeys. This file starts the extension: it makes
// the shared services (app.ts), hands each part what it watches, and registers the commands (each one a call into the
// module that does it).

import * as vscode from 'vscode'
import { beats, cfg, claudeLinks, codeLinks, controller, extVersion, gstate, journeys, KEY, log, mapPanel, PREFIX_KEY, provide, setCtx, setKey, state, store, tourItems, tutorialSpot, understanding, valueHints } from './app'
import { askClaudeCommand, cancelClaudeCommand, loadAskErrors, watchClaudeCli } from './ask'
import { Beats } from './beats'
import { next, prefixUsed, previous, resolveNext } from './chords'
import { ClaudeLinks } from './claudeLinks'
import { CodeLinks } from './codeLinks'
import { devReload } from './devReload'
import { initIdentity, me, rememberMe } from './identity'
import { Journeys } from './journeys/journeys'
import { MapPanel } from './journeys/mapPanel'
import { codeLinkBack, openCodeLink } from './links'
import { addNote, addPathNote, addQuickNote, askFromThread, createFromThread, NOTE_OPTIONS, rangeProvider } from './notes/create'
import { findNote } from './notes/find'
import { rememberFolder } from './notes/folder'
import { cancelMove, completeMove, createMoveItem, keepHere, moveItem, moveToSelection } from './notes/move'
import { copyAgentPrompt, copyNotePrompt } from './notes/prompt'
import { openAt, openBroken, openNoteFile, openNoteId, registerOrphanPage, restoreBroken, revealCommand, stepUnread } from './notes/reveal'
import { deleteSession, hideSession, resolveSession, showAllSessions, showOnlySession, showSession } from './notes/sessions'
import { deleteNotes, deleteResolved, markAllRead, markUnread, offerRestore, reopenNotes, replyAndResolve, replyTo, resolve, resolveAll, resolveChecked, undo } from './notes/status'
import { applySuggestion } from './notes/suggestion'
import { target } from './notes/target'
import { createStatusItem, refreshAll, statusItem } from './refresh'
import { markJourneysSeen, migrateSeen } from './seen'
import { createJourneysView, searchJourneys, showAllHere, sortJourneys } from './sidebar/journeysTree'
import { groupByFile, groupBySession, hideResolvedNotes, loadGroupMode, pickFilter, showResolvedNotes } from './sidebar/nodes'
import { createNotesView, rowsSelected, treeView } from './sidebar/notesTree'
import { Store } from './store'
import { testApi } from './testApi'
import { registerFolderPage } from './threads/anchoring'
import { collapseThread, expandThread } from './threads/comments'
import { createDecorations, deco, followNotesOnDisk, notesChangedOnDisk } from './threads/threads'
import { askStep, askUpdate } from './tour/askStep'
import { authorModeOff, mapState, onMapMessage, toggleAnimation } from './tour/mapMessages'
import { backToStep, endTour, openJourney, openStepLink, restoreMapPanel, restoreTour, showMap, startJourney } from './tour/commands'
import { pickJourneyStep } from './tour/lenses'
import { registerRefPages } from './tour/refs'
import { createCard, createTourItems, toggleStepDetails, walk } from './tour/tour'
import { tutorial } from './tour/tutorial'
import { TutorialSpot } from './tutorialSpot'
import { answerCheck, checkConcern, createUnderstanding, gradeCheck } from './understanding'
import { ValueHints } from './valueHints'
import { reloadAll, watchBranches, watchEditors, watchEdits, watchFiles, watchJourneys } from './watch'
import { refreshJourney } from './write/refreshJourney'
import { askQuestion, watchRequests } from './write/requests'
import { writingChanged } from './write/writer'

const CONTROLLER_ID = 'codeNotes'

export async function activate(context: vscode.ExtensionContext) {
  // The services, in the order they need each other (app.ts).
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
  // No commenting-range bar on every line (–): the whole file is commentable only while Add Note opens its
  // box (Ctrl+' C, the command); VS Code asks again when the provider is set.
  controller.commentingRangeProvider = rangeProvider
  controller.options = NOTE_OPTIONS
  createJourneysView(context)
  createNotesView(context)
  createStatusItem()
  createMoveItem()
  createTourItems()
  provide({ journeys: new Journeys(log, context.workspaceState) })
  devReload(context, log)
  provide({ beats: new Beats(log), tutorialSpot: new TutorialSpot(), codeLinks: new CodeLinks(log) })
  provide({ claudeLinks: new ClaudeLinks(log, () => cfg().get<boolean>('claudeLinks', true)) })
  provide({ valueHints: new ValueHints(log, () => codeLinks.backAt, codeLinks.onDidChange) })
  context.subscriptions.push(tutorialSpot, claudeLinks, beats, codeLinks, valueHints)
  provide({ gstate: context.globalState })
  setKey(gstate.get<string>(PREFIX_KEY) ?? KEY)
  provide({ mapPanel: new MapPanel(context.extensionUri, log, onMapMessage, mapState, state) })
  createCard(context)
  registerRefPages(context)
  const journeysLoaded = restoreMapPanel(context)
  createDecorations()
  setCtx('codeNotes.showResolved', false)
  rememberMe()
  context.subscriptions.push(log, store, controller, treeView, statusItem, moveItem, ...Object.values(deco), journeys, mapPanel, ...Object.values(tourItems))

  // What each part follows (watch.ts and the parts' own).
  watchJourneys(context)
  registerOrphanPage(context)
  registerFolderPage(context)
  context.subscriptions.push(store.onDidDeleteOnDisk(offerRestore), store.onDidChange(notesChangedOnDisk))
  watchEdits(context)
  watchFiles(context)
  watchEditors(context)
  context.subscriptions.push(treeView.onDidChangeSelection(rowsSelected))

  // The commands (package.json names them; menus and keys call them).
  const cmd = (id: string, fn: (...a: any[]) => any) => context.subscriptions.push(vscode.commands.registerCommand(id, fn))
  cmd('codeNotes.codeLink', openCodeLink)
  cmd('codeNotes.codeLinkBack', codeLinkBack)
  cmd('codeNotes.add', (a?: unknown) => { prefixUsed(a); return addNote() })
  cmd('codeNotes.toggleAnimation', (a?: unknown) => { prefixUsed(a); toggleAnimation() })
  cmd('codeNotes.addQuick', addQuickNote)
  cmd('codeNotes.askFromThread', askFromThread)
  cmd('codeNotes.createFromThread', createFromThread)
  cmd('codeNotes.askClaude', askClaudeCommand)
  cmd('codeNotes.cancelClaude', cancelClaudeCommand)
  cmd('codeNotes.reply', replyTo)
  cmd('codeNotes.replyReopen', replyTo) // the same, labelled for resolved threads
  cmd('codeNotes.replyResolve', replyAndResolve)
  cmd('codeNotes.hideSession', hideSession)
  cmd('codeNotes.showSession', showSession)
  cmd('codeNotes.showOnlySession', showOnlySession)
  cmd('codeNotes.showAllSessions', showAllSessions)
  cmd('codeNotes.resolveSession', resolveSession)
  cmd('codeNotes.deleteSession', deleteSession)
  cmd('codeNotes.openAt', openAt)
  cmd('codeNotes.expandThread', expandThread)
  cmd('codeNotes.collapseThread', collapseThread)
  cmd('codeNotes.undo', undo)
  cmd('codeNotes.openBroken', openBroken)
  cmd('codeNotes.restoreBroken', restoreBroken)
  cmd('codeNotes.markUnread', markUnread)
  cmd('codeNotes.reveal', revealCommand)
  cmd('codeNotes.resolve', async (arg?: any, many?: any[]) => resolve(await target(arg, many)))
  cmd('codeNotes.reopen', reopenNotes)
  cmd('codeNotes.delete', deleteNotes)
  cmd('codeNotes.acceptCode', keepHere)
  cmd('codeNotes.moveToSelection', moveToSelection)
  cmd('codeNotes.completeMove', completeMove)
  cmd('codeNotes.cancelMove', cancelMove)
  cmd('codeNotes.openNoteFile', openNoteFile)
  cmd('codeNotes.resolveChecked', resolveChecked)
  cmd('codeNotes.resolveAll', resolveAll)
  cmd('codeNotes.deleteResolved', deleteResolved)
  cmd('codeNotes.markAllRead', markAllRead)
  cmd('codeNotes.openJourney', openJourney)
  cmd('codeNotes.showMap', showMap)
  cmd('codeNotes.startJourney', startJourney)
  cmd('codeNotes.nextStep', () => walk.stepBy(1))
  cmd('codeNotes.previousStep', () => walk.stepBy(-1))
  cmd('codeNotes.endJourney', endTour)
  cmd('codeNotes.openStepLink', openStepLink)
  cmd('codeNotes.toggleAuthorMode', authorModeOff)
  cmd('codeNotes.askQuestion', askQuestion)
  cmd('codeNotes.backToStep', backToStep)
  cmd('codeNotes.askStep', (text?: string) => askStep(text))
  cmd('codeNotes.askStepUpdate', () => askUpdate())
  cmd('codeNotes.openNoteId', openNoteId)
  cmd('codeNotes.tutorial', tutorial)
  cmd('codeNotes.stepDetails', toggleStepDetails)
  cmd('codeNotes.nextUnread', () => stepUnread(1))
  cmd('codeNotes.previousUnread', () => stepUnread(-1))
  cmd('codeNotes.showResolved', showResolvedNotes)
  cmd('codeNotes.hideResolved', hideResolvedNotes)
  cmd('codeNotes.filter', pickFilter)
  cmd('codeNotes.filterActive', () => vscode.commands.executeCommand('codeNotes.filter'))
  cmd('codeNotes.find', findNote)
  cmd('codeNotes.refresh', reloadAll)
  cmd('codeNotes.copyAgentPrompt', copyAgentPrompt)
  cmd('codeNotes.copyNotePrompt', copyNotePrompt)
  cmd('codeNotes.next', next)
  cmd('codeNotes.nextCheckQuestion', () => understanding?.step(1))
  cmd('codeNotes.previous', previous)
  cmd('codeNotes.resolveNext', resolveNext)
  cmd('codeNotes.groupByFile', groupByFile)
  cmd('codeNotes.groupBySession', groupBySession)
  cmd('codeNotes.addPathNote', (uri?: vscode.Uri, text?: string) => addPathNote(uri, text))
  cmd('codeNotes.applySuggestion', (id: string, mi: number, k: number) => applySuggestion(id, mi, k))
  createUnderstanding(context)
  cmd('codeNotes.checkUnderstanding', () => understanding!.run())
  cmd('codeNotes.searchJourneys', (a?: unknown) => { prefixUsed(a); return searchJourneys() })
  cmd('codeNotes.refreshJourney', refreshJourney)
  cmd('codeNotes.journeysHereAll', showAllHere)
  cmd('codeNotes.sortJourneys', sortJourneys)
  cmd('codeNotes.answerCheck', answerCheck)
  cmd('codeNotes.pickJourneyStep', pickJourneyStep)
  cmd('codeNotes.checkConcern', checkConcern)
  cmd('codeNotes.gradeCheck', gradeCheck)
  await watchBranches(context)

  // Everything read, then shown; the walk and the check where they were.
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
  return testApi()
}

export function deactivate(): void { /* disposables clean up */ }
