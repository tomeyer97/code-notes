// The notes model, made once when the extension starts (startNotesModel) and read through notesModel(); the helpers
// below are its most used questions.

import type { Note } from '../store'
import { NotesApi, NotesPorts } from './api'
import type { NotesChange } from './changes'

export { NotesApi } from './api'
export type { NotesPorts } from './api'
export type { NotesChange, NotesChangeKind } from './changes'
export { onlyThese, whileTyping } from './changes'
export { FILTERS, lastMessage, order, sessionOf } from './query'
export type { Filter, GroupMode } from './query'

let api: NotesApi | undefined

export function startNotesModel(ports: NotesPorts): NotesApi {
  api = new NotesApi(ports)
  return api
}

export function notesModel(): NotesApi {
  if (!api) throw new Error('the notes model is not started')
  return api
}

/** Announces a change of notes (nothing yet before the model is started: nothing shows them). */
export const notesChanged = (c: NotesChange) => api?.changed(c)

/** The note is listed in the Code Notes view (under its filter). */
export const matchesFilter = (n: Note) => notesModel().query.matches(n)

/** The note is not drawn in the editor: its session is hidden (and it was not just opened). */
export const hiddenInEditor = (n: Note) => notesModel().query.hiddenInEditor(n)

/** The session group the note is listed under, if any. */
export const scopeOf = (n: Note) => notesModel().query.scopeOf(n)

export const hiddenSessions = () => notesModel().hiddenSessions()

export const selection = () => notesModel().selection
