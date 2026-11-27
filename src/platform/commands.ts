// Every command id the extension runs, registers or links to, in one table: `Cmd.x` instead of a string. Cmd is exactly
// package.json's contributes.commands (test/commands.test.ts checks it); the few the code runs that are not contributed
// (link targets, a view's focus command) are in HiddenCmd. Ids are never renamed: keybindings, menus and agents'
// links use them. No vscode here: unit-tested.

/** The contributed commands (package.json), by name; the comment is the title the palette shows. */
export const Cmd = {
  add: 'codeNotes.add', // Add Note
  addQuick: 'codeNotes.addQuick', // Add One-Line Note
  reply: 'codeNotes.reply', // Reply
  createFromThread: 'codeNotes.createFromThread', // Add Note
  reveal: 'codeNotes.reveal', // Open Thread
  resolve: 'codeNotes.resolve', // Resolve
  reopen: 'codeNotes.reopen', // Reopen
  delete: 'codeNotes.delete', // Delete Note
  acceptCode: 'codeNotes.acceptCode', // Keep Note Here
  moveToSelection: 'codeNotes.moveToSelection', // Move Note…
  completeMove: 'codeNotes.completeMove', // Move Note Here
  cancelMove: 'codeNotes.cancelMove', // Cancel Moving Note
  openNoteFile: 'codeNotes.openNoteFile', // Open Note File (JSON)
  copyNotePrompt: 'codeNotes.copyNotePrompt', // Copy Prompt for This Note
  resolveChecked: 'codeNotes.resolveChecked', // Resolve Selected Notes
  resolveAll: 'codeNotes.resolveAll', // Resolve All Open Notes…
  deleteResolved: 'codeNotes.deleteResolved', // Purge Resolved Notes…
  markAllRead: 'codeNotes.markAllRead', // Mark All Read
  showResolved: 'codeNotes.showResolved', // Show Resolved Notes
  hideResolved: 'codeNotes.hideResolved', // Hide Resolved Notes
  nextUnread: 'codeNotes.nextUnread', // Next Unread Reply
  previousUnread: 'codeNotes.previousUnread', // Previous Unread Reply
  filter: 'codeNotes.filter', // Filter Notes…
  find: 'codeNotes.find', // Find Note…
  refresh: 'codeNotes.refresh', // Reload Notes
  copyAgentPrompt: 'codeNotes.copyAgentPrompt', // Copy Prompt for Agent
  replyResolve: 'codeNotes.replyResolve', // Reply & Resolve
  hideSession: 'codeNotes.hideSession', // Hide Session in Editor
  showSession: 'codeNotes.showSession', // Show Session in Editor
  showOnlySession: 'codeNotes.showOnlySession', // Show Only This Session
  showAllSessions: 'codeNotes.showAllSessions', // Show All Sessions
  resolveSession: 'codeNotes.resolveSession', // Resolve Session…
  deleteSession: 'codeNotes.deleteSession', // Delete Session…
  openAt: 'codeNotes.openAt', // Open Code Reference
  expandThread: 'codeNotes.expandThread', // Show Whole Thread
  markUnread: 'codeNotes.markUnread', // Mark as Unread
  askClaude: 'codeNotes.askClaude', // Ask Claude
  cancelClaude: 'codeNotes.cancelClaude', // Stop Claude
  replyReopen: 'codeNotes.replyReopen', // Reply & Reopen
  filterActive: 'codeNotes.filterActive', // Filter Notes (filtered)…
  undo: 'codeNotes.undo', // Undo
  openBroken: 'codeNotes.openBroken', // Open Note File at the Problem
  restoreBroken: 'codeNotes.restoreBroken', // Restore Last Good Version
  collapseThread: 'codeNotes.collapseThread', // Show Fewer Replies
  openJourney: 'codeNotes.openJourney', // Open Journey…
  askQuestion: 'codeNotes.askQuestion', // Ask a Question About the Code…
  startJourney: 'codeNotes.startJourney', // Start Journey
  nextStep: 'codeNotes.nextStep', // Next Step
  previousStep: 'codeNotes.previousStep', // Previous Step
  endJourney: 'codeNotes.endJourney', // End Journey
  next: 'codeNotes.next', // Next Step or Unread Reply
  previous: 'codeNotes.previous', // Previous Step or Unread Reply
  resolveNext: 'codeNotes.resolveNext', // Resolve and Go to Next Unread
  groupByFile: 'codeNotes.groupByFile', // Group by File
  groupBySession: 'codeNotes.groupBySession', // Group by Session
  addPathNote: 'codeNotes.addPathNote', // Add Code Note…
  applySuggestion: 'codeNotes.applySuggestion', // Apply Suggestion
  showMap: 'codeNotes.showMap', // Show Journey Map
  askStep: 'codeNotes.askStep', // Ask About This Step
  stepDetails: 'codeNotes.stepDetails', // Show Step Details
  tutorial: 'codeNotes.tutorial', // Journey Tutorial
  backToStep: 'codeNotes.backToStep', // Back to the Journey Step
  askFromThread: 'codeNotes.askFromThread', // Ask
  toggleAuthorMode: 'codeNotes.toggleAuthorMode', // Turn Off Journey Author Mode
  toggleAnimation: 'codeNotes.toggleAnimation', // Play or Stop the Step's Animation
  playPodcast: 'codeNotes.playPodcast', // Listen to Journey
  podcastToggle: 'codeNotes.podcastToggle', // Listen: Pause/Play
  podcastBack: 'codeNotes.podcastBack', // Listen: Back 15 s
  podcastForward: 'codeNotes.podcastForward', // Listen: Forward 15 s
  podcastPrevStep: 'codeNotes.podcastPrevStep', // Listen: Previous Step
  podcastNextStep: 'codeNotes.podcastNextStep', // Listen: Next Step
  podcastOpen: 'codeNotes.podcastOpen', // Listen: Open the Map
  checkUnderstanding: 'codeNotes.checkUnderstanding', // Check my understanding
  answerCheck: 'codeNotes.answerCheck', // Answer
  gradeCheck: 'codeNotes.gradeCheck', // Grade the Answer Again
  checkConcern: 'codeNotes.checkConcern', // Act on a Concern Found During the Check
  pickJourneyStep: 'codeNotes.pickJourneyStep', // Pick a Journey Step Here
  searchJourneys: 'codeNotes.searchJourneys', // Search Journeys
  sortJourneys: 'codeNotes.sortJourneys', // Sort Journeys
  refreshJourney: 'codeNotes.refreshJourney', // Refresh Journey
  journeysHereAll: 'codeNotes.journeysHereAll', // Show All Journeys in This File
} as const

/**
 * Commands the code registers or runs that the palette doesn't list: link and lens targets, keys of the step card and
 * the map, and each view's focus command (VS Code makes those).
 */
export const HiddenCmd = {
  askStepUpdate: 'codeNotes.askStepUpdate',
  claudeLinkBack: 'codeNotes.claudeLinkBack',
  codeLink: 'codeNotes.codeLink',
  codeLinkBack: 'codeNotes.codeLinkBack',
  nextCheckQuestion: 'codeNotes.nextCheckQuestion',
  openNoteId: 'codeNotes.openNoteId',
  openStepLink: 'codeNotes.openStepLink',
  podcastFollow: 'codeNotes.podcastFollow',
  notesFocus: 'codeNotes.notes.focus',
  journeysFocus: 'codeNotes.journeys.focus',
  checkFocus: 'codeNotes.check.focus',
} as const

export type CommandId = (typeof Cmd)[keyof typeof Cmd] | (typeof HiddenCmd)[keyof typeof HiddenCmd]

/**
 * The commands Markdown may run, by who wrote it. Rows the extension writes in a thread (Claude answering, a failure,
 * the check's grading):
 */
export const SYSTEM_COMMANDS: readonly CommandId[] = [
  Cmd.askClaude, Cmd.cancelClaude, Cmd.expandThread, Cmd.openAt, Cmd.gradeCheck, Cmd.checkConcern, HiddenCmd.openStepLink,
]
/** A note's messages (anyone's words): links to code and steps, Apply on a suggestion, show the whole thread. */
export const MESSAGE_COMMANDS: readonly CommandId[] = [Cmd.openAt, Cmd.expandThread, Cmd.applySuggestion, HiddenCmd.openStepLink, HiddenCmd.codeLink]
/** A stale note's banner: Keep here, Move. */
export const BANNER_COMMANDS: readonly CommandId[] = [Cmd.acceptCode, Cmd.moveToSelection]

/** A command: link target, its arguments in the query. */
export const commandUri = (command: string, ...args: unknown[]) =>
  `command:${command}${args.length ? `?${encodeURIComponent(JSON.stringify(args))}` : ''}`

/** A Markdown link that runs `command` with `args`. */
export const cmdLink = (label: string, command: string, ...args: unknown[]) => `[${label}](${commandUri(command, ...args)})`

/** The same with a tooltip (`title`). */
export const titledCmdLink = (label: string, title: string, command: string, ...args: unknown[]) =>
  `[${label}](${commandUri(command, ...args)} "${title}")`
