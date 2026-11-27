// The Code Notes and Journeys views, and their commands (sessions, filter, grouping, search and sort).
import * as vscode from 'vscode'
import { chord } from '../platform/chordKey'
import { Cmd } from '../platform/commands'
import { registerCommands } from '../platform/registerCommands'
import type { NotesApi } from '../notes/model'
import { deleteSession, hideSession, resolveSession, showAllSessions, showOnlySession, showSession } from '../notes/sessions'
import { createJourneysView, followJourneyMoves, journeysHereAll, journeysTree, sortJourneys } from './journeysTree'
import { searchJourneys } from './journeySearch'
import { onDidChangeListState } from './listModel'
import { groupByFile, groupBySession, hideResolvedNotes, loadGroupMode, pickFilter, showResolvedNotes } from './notesFilter'
import { createNotesView, followNotes, rowsSelected, treeView } from './notesTree'
import { SidebarPorts, useSidebarPorts } from './ports'

export interface SidebarFeature {
  /** The Journeys view drawn again. */
  refreshJourneys(): void
  /** The Code Notes view follows the notes. */
  followNotes(model: NotesApi): vscode.Disposable
  /** The Journeys view follows the journeys' steps; the rows picked in the Code Notes view. */
  followJourneys(): vscode.Disposable
}

export function activateSidebar(context: vscode.ExtensionContext, ports: SidebarPorts): SidebarFeature {
  useSidebarPorts(ports)
  loadGroupMode()
  createJourneysView(context)
  // The panel's home lists the journeys too: it follows the same changes (the Journeys view does in createJourneysView).
  context.subscriptions.push(onDidChangeListState(() => ports.mapPanel.update()))
  createNotesView(context)
  context.subscriptions.push(treeView)
  registerCommands(context, {
    [Cmd.hideSession]: hideSession,
    [Cmd.showSession]: showSession,
    [Cmd.showOnlySession]: showOnlySession,
    [Cmd.showAllSessions]: showAllSessions,
    [Cmd.resolveSession]: resolveSession,
    [Cmd.deleteSession]: deleteSession,
    [Cmd.showResolved]: showResolvedNotes,
    [Cmd.hideResolved]: hideResolvedNotes,
    [Cmd.filter]: pickFilter,
    [Cmd.filterActive]: pickFilter,
    [Cmd.groupByFile]: groupByFile,
    [Cmd.groupBySession]: groupBySession,
    [Cmd.searchJourneys]: chord(searchJourneys),
    [Cmd.journeysHereAll]: journeysHereAll,
    [Cmd.sortJourneys]: sortJourneys,
  })
  return {
    refreshJourneys: () => journeysTree.refresh(),
    followNotes: (model) => followNotes(model),
    followJourneys: () => vscode.Disposable.from(
      followJourneyMoves(ports.journeys),
      treeView.onDidChangeSelection(rowsSelected),
    ),
  }
}
