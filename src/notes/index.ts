// The notes: who writes them, the store of note files, the notes model and its comment controller, the notes'
// commands and what the notes follow (files moved or edited, the cursor, the notes folder). activateNotes makes them
// for this window; the other features get the store and the model as ports.
import * as vscode from 'vscode'
import { chord, STEP_PRIORITY, Steppers } from '../platform/chordKey'
import { Cmd, HiddenCmd } from '../platform/commands'
import { setCtx } from '../platform/context'
import type { WorkspaceEvents } from '../platform/events'
import { log, stored } from '../platform/host'
import { registerCommands } from '../platform/registerCommands'
import { fireAndForget } from '../platform/run'
import { runMigrations, STATE } from '../platform/state'
import { openBroken, restoreBroken } from './broken'
import { followNotesOnDisk } from './changedOnDisk'
import { rangeProvider } from './commentRanges'
import { followContextKeys } from './contextKeys'
import { addNote, addPathNote, addQuickNote, askFromThread, closeNoteBox, createFromThread, NOTE_OPTIONS, onDidCreateNote } from './create'
import { followCursor } from './cursor'
import { createDecorations, followNotes as decorationsFollow } from './decorations'
import { findNote } from './find'
import { applyIgnoreInGit, changeFolder, rememberFolder, rewriteReadmes } from './folder'
import { followEdits } from './followEdits'
import { authorChanged, initIdentity, me, rememberMe } from './identity'
import { NotesApi, notesModel, startNotesModel } from './model'
import { NOTES_CTX } from './model/contextKeys'
import { acceptCode, cancelMove, completeMove, createMoveMode, moveToSelection } from './move'
import { followNoteFiles } from './moves'
import { registerPages } from './pages'
import { NotesFeaturePorts, NotesLayout, useNotes } from './ports'
import { copyAgentPrompt, copyNotePrompt } from './prompt'
import { replyAndResolve, replyTo } from './reply'
import { LineLink, openAt, openNoteFile, openNoteId, revealCommand, takeLinks } from './reveal'
import { markJourneysSeen, reloadSeen, setSeen, unread } from './seen'
import { deleteNotes, deleteResolved, offerRestore, reopenNotes, resolve, resolveAll, resolveChecked } from './status'
import { Store } from './store'
import { applySuggestion } from './suggestion'
import { undo } from './undo'
import { markAllRead, markUnread, stepUnread } from './unread'
import { byId, visibleNotes } from './visible'
import { CommandArg, pickNotes } from './which'

export type { NotesFeaturePorts } from './ports'
/** A file in the notes folder (the store watches it: no note or step is on it). */
export { inNotesFolder } from './notesFolder'

/** The id VS Code knows the notes' comment threads by. */
const CONTROLLER_ID = 'codeNotes'

export interface NotesFeature {
  store: Store
  model: NotesApi
  /** The notes' comment controller: their threads (threads/) are its threads. */
  controller: vscode.CommentController
  /** A note box opened (true) or closed (false): what plays (a podcast) pauses meanwhile. */
  onDidChangeDrafting: vscode.Event<boolean>
  /** Reads every note file (the folder remembered first). */
  load(): Promise<void>
  /** What shows the notes follows their changes: the context keys, the marks, the cursor (after the threads). */
  follow(): vscode.Disposable
  /** The note files follow the workspace: deleted, changed or moved on disk, the code edited, the folders. */
  followFiles(): vscode.Disposable
  /** What a settings change does to the notes (and, through `also`, to the journeys and the lenses). */
  followSettings(also: { loadJourneys(): Promise<void>; lensesChanged(): void }): vscode.Disposable
  /** The journeys read: the ones there now are known (a journey added later is new). */
  journeysRead(): Promise<void>
  /** Everything read: the stored state migrated, the seen counts read again, the notes shown as read now. */
  shown(): Promise<void>
}

/** Who you are, the store, the notes model and the comment controller; the notes' commands and what they follow. */
export async function activateNotes(context: vscode.ExtensionContext, ports: NotesFeaturePorts, events: WorkspaceEvents, steppers: Steppers): Promise<NotesFeature> {
  await initIdentity(vscode.workspace.workspaceFolders?.[0])
  const store = new Store(log(), me)
  const controller = vscode.comments.createCommentController(CONTROLLER_ID, 'Code Notes')
  useNotes({ store, controller, ports, hidden: [] })
  const model = startNotesModel({
    byId, notes: visibleNotes, unread,
    isCheck: (n) => ports.isCheck(n),
    storeChanges: store.onDidChange,
    readHidden: () => stored().get(STATE.hiddenSessions),
    writeHidden: (names) => stored().set(STATE.hiddenSessions, names),
  })
  // No commenting-range bar on every line (–): a file is commentable only from Add Note (Ctrl+' C, the command)
  // until its box is done with (commentRanges.ts); VS Code asks again when the provider is set.
  controller.commentingRangeProvider = rangeProvider
  controller.options = NOTE_OPTIONS
  fireAndForget(setCtx(NOTES_CTX.showResolved, false), 'notes: setCtx codeNotes.showResolved')
  rememberMe()
  registerPages(context)
  const drafting = new vscode.EventEmitter<boolean>()
  context.subscriptions.push(
    store, model, controller, createMoveMode(), createDecorations(), drafting,
    // A note you made is read (its first message is yours): stored in the background (a round trip to the window).
    onDidCreateNote((n) => fireAndForget(setSeen([[n.data.id, 1]]), 'seen')),
    takeLinks((link) => stepLink(ports.layout, link)),
    // Esc in a new note box (the key is the manifest's): closes it, keeping its draft (create.ts closeNoteBox).
    vscode.commands.registerCommand(HiddenCmd.closeNoteBox, async () => {
      try { await closeNoteBox() } finally { drafting.fire(false) }
    }),
  )
  registerCommands(context, {
    // Adding, replying, asking from a thread. A note being written pauses what plays (its code stays put under it).
    [Cmd.add]: chord(() => { drafting.fire(true); return addNote() }),
    [HiddenCmd.addQuick]: addQuickNote,
    [Cmd.addPathNote]: (uri?: vscode.Uri, text?: unknown) => addPathNote(uri, text),
    [Cmd.askFromThread]: askFromThread,
    [Cmd.createFromThread]: async (...a: Parameters<typeof createFromThread>) => {
      try { return await createFromThread(...a) } finally { drafting.fire(false) }
    },
    [Cmd.reply]: replyTo,
    [Cmd.replyReopen]: replyTo, // the same, labelled for resolved threads
    [HiddenCmd.replyResolve]: replyAndResolve,
    [Cmd.applySuggestion]: (id: string, mi: number, k: number) => applySuggestion(id, mi, k),
    // Resolving, deleting, moving, reading.
    [Cmd.resolve]: async (arg?: CommandArg, many?: readonly CommandArg[]) => resolve(await pickNotes(arg, many)),
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
    // R: resolve the note at the cursor, then on to the next unread one.
    [Cmd.resolveNext]: chord(resolveNext),
    // Opening.
    [Cmd.reveal]: revealCommand,
    [Cmd.openAt]: openAt,
    [Cmd.openNoteFile]: openNoteFile,
    [HiddenCmd.openNoteId]: openNoteId,
    [Cmd.openBroken]: openBroken,
    [Cmd.restoreBroken]: restoreBroken,
    [Cmd.find]: findNote,
    [Cmd.copyAgentPrompt]: copyAgentPrompt,
    [Cmd.copyNotePrompt]: copyNotePrompt,
  })
  // D / A with nothing else to step through: the unread replies.
  context.subscriptions.push(steppers.register(STEP_PRIORITY.unread, { step: (dir) => stepUnread(dir) }))
  return {
    store, model, controller,
    onDidChangeDrafting: drafting.event,
    load: async () => { rememberFolder(); await store.load() },
    follow: () => vscode.Disposable.from(
      followContextKeys(model, { notes: visibleNotes, brokenCount: () => store.brokenCount(), isCheck: (n) => ports.isCheck(n) }),
      decorationsFollow(model, events),
      followCursor(events, model, { hasThread: (id) => ports.hasThread(id), arrived: () => ports.layout.tourMovedCursor() }),
    ),
    followFiles: () => vscode.Disposable.from(
      store.onDidDeleteOnDisk(offerRestore),
      followNotesOnDisk(),
      followEdits(events, (n) => store.saveFollowing(n)),
      followNoteFiles(events),
      events.onDidChangeFolders(() => fireAndForget(store.load(), 'notes: read again for the folders')),
    ),
    followSettings: (also) => events.onDidChangeSettings((e) => fireAndForget(settingsChanged(e, also), 'settings changed')),
    journeysRead: () => markJourneysSeen(),
    shown: async () => {
      await runMigrations(stored(), { notes: () => visibleNotes().map((n) => n.data) }).then(
        (ran) => { for (const m of ran) log().info(`migrated: ${m}`) },
        (e) => log().error(`migrating the stored state: ${e}`), // tried again at the next start
      )
      // The seen counts were migrated: read again; then everything shown as read now.
      reloadSeen()
      model.changed({ kind: 'loaded' })
    },
  }
}

/** A link to a step's line while that step's journey is walked: opened under the step card. */
async function stepLink(layout: NotesLayout, link: LineLink): Promise<boolean> {
  const lj = layout.walking()
  if (!link.step || !lj || lj.folder.uri.toString() !== link.folderUri) return false
  await layout.openRef(lj, link.file, link.line, link.end ?? link.line, link.step)
  return true
}

/** R: resolve the note at the cursor, then on to the next unread one. */
async function resolveNext(): Promise<void> {
  const list = await pickNotes(undefined)
  if (!list.length) return
  await resolve(list)
  if (visibleNotes().some((n) => unread(n) > 0)) await stepUnread(1)
}

/** What a settings change does, in this order. `alone`: nothing below runs after it (the notes folder or the author
 *  changed: everything is read or written again). */
async function settingsChanged(e: vscode.ConfigurationChangeEvent, also: { loadJourneys(): Promise<void>; lensesChanged(): void }): Promise<void> {
  const changed = () => notesModel().changed({ kind: 'settings' })
  const settings: { key: string; run: () => unknown; alone?: boolean }[] = [
    { key: 'codeNotes.folder', run: changeFolder, alone: true },
    // The journeys read again from their folder; then (it is a codeNotes setting too) the lenses, below.
    { key: 'codeNotes.journeys.folder', run: async () => { await also.loadJourneys(); changed() } },
    { key: 'codeNotes.ignoreInGit', run: applyIgnoreInGit, alone: true },
    { key: 'codeNotes.author', run: async () => { await authorChanged(); await rewriteReadmes(); changed() }, alone: true },
    { key: 'codeNotes', run: () => { also.lensesChanged(); changed() } },
  ]
  for (const s of settings) {
    if (!e.affectsConfiguration(s.key)) continue
    await s.run()
    if (s.alone) return
  }
}
