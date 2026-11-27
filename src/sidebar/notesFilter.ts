// The Code Notes view's commands that change how the notes model lists the notes: the filter, resolved notes shown or
// not, grouping by file or by session (which notes and how: notes/model; the rows: noteGroups.ts).

import * as vscode from 'vscode'
import { stored } from '../platform/host'
import { FILTERS, notesModel } from '../notes/model'
import { STATE } from '../platform/state'

export const showResolvedNotes = () => notesModel().setShowResolved(true)

export const hideResolvedNotes = () => notesModel().setShowResolved(false)

/** Show in Code Notes: a filter, each with how many notes it shows. */
export const pickFilter = async () => {
  const { query } = notesModel()
  const items = FILTERS.map((f) => ({
    label: `${f.id === query.filter ? '$(check) ' : ''}${f.label}`,
    detail: f.detail,
    id: f.id,
    description: `${query.count(f.id)}`,
  }))
  const pick = await vscode.window.showQuickPick(items, { title: 'Show in Code Notes' })
  if (pick) notesModel().setFilter(pick.id)
}

export const groupByFile = async () => { await stored().set(STATE.groupBy, 'file'); notesModel().setGroupMode('file') }

export const groupBySession = async () => { await stored().set(STATE.groupBy, 'session'); notesModel().setGroupMode('session') }

/** Group by file or by session, as last chosen in this workspace. */
export function loadGroupMode(): void {
  notesModel().query.groupMode = stored().get(STATE.groupBy) === 'session' ? 'session' : 'file'
}
