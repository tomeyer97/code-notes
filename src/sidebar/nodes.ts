// What a row of the two views is (Node), one object per row (cached: TreeView.reveal finds rows by identity), the
// constructors of each kind, and the order of notes in a group.

import * as vscode from 'vscode'
import { journeys, notes } from '../app'
import { Group } from '../core/list/journeyList'
import { LoadedJourney } from '../journeys/steps'
import { Severity } from '../core/format/noteModel'
import { Note } from '../notes/store'
import { matchesFilter } from './notesFilter'

export type Node =
  | { kind: 'session'; name: string; notes: Note[] }
  | { kind: 'file'; key: string; folder: vscode.WorkspaceFolder; file: string; notes: Note[]; session?: string; isFolder?: boolean }
  | { kind: 'note'; note: Note }
  | { kind: 'broken'; uri: string; why: string }
  | { kind: 'journeys' }
  | { kind: 'journey'; lj: LoadedJourney; group?: string }
  | { kind: 'jgroup'; g: Group }
  | { kind: 'jmore'; g: string; n: number }
  | { kind: 'badJourney'; uri: vscode.Uri; why: string }
  | { kind: 'intro' }
  | { kind: 'questions'; lj: LoadedJourney; notes: Note[] }

/** One object per tree element (TreeView.reveal finds elements by identity). */
const nodes = new Map<string, Node>()

export function cached<T extends Node>(key: string, fresh: T): T {
  const c = nodes.get(key)
  if (!c) { nodes.set(key, fresh); return fresh }
  for (const k of Object.keys(c)) delete (c as any)[k]
  return Object.assign(c, fresh) as T
}

export const noteNode = (note: Note) => cached(`note:${note.data.id}`, { kind: 'note', note })

/** A session's group; its notes: those listed (`list`), else every note of the session the filter shows. */
export const sessionNode = (name: string, list?: Note[]) =>
  cached(`session:${name}`, { kind: 'session' as const, name, notes: list ?? notes().filter((x) => sessionOf(x) === name && matchesFilter(x)) })

/** The notes of one file (or folder) under a session (`session`) or at the top. */
export function fileNode(n: Note, session: string | undefined, list: Note[]): Node & { kind: 'file' } {
  const key = `${session ?? ''}|${n.folder.uri}|${n.data.file}`
  return cached(`file:${key}`, {
    kind: 'file', key, folder: n.folder, file: n.data.file, notes: list,
    ...(session !== undefined ? { session } : {}),
    ...(n.data.target === 'folder' ? { isFolder: true } : {}),
  })
}

export const journeyNode = (lj: LoadedJourney) => cached(`journey:${lj.key}`, { kind: 'journey' as const, lj })

/** A journey's row in group `group` of the Journeys view (a journey is listed in several groups). */
export const journeyRowNode = (lj: LoadedJourney, group: string) => cached(`journey:${group}:${lj.key}`, { kind: 'journey' as const, lj, group })

export const jgroupNode = (g: Group) => cached(`jgroup:${g.id}`, { kind: 'jgroup' as const, g })

/** "Show all (n more)": the rest of a capped group. */
export const jmoreNode = (g: Group) => cached(`jmore:${g.id}`, { kind: 'jmore' as const, g: g.id, n: g.more! })

/** The journey files that can't be read, by path. */
export const badJourneyNodes = () => [...journeys.invalid.values()]
  .sort((a, b) => a.uri.path.localeCompare(b.uri.path))
  .map((x) => cached(`badJourney:${x.uri}`, { kind: 'badJourney' as const, uri: x.uri, why: x.why }))

export const lastMessage = (n: Note) => n.data.messages[n.data.messages.length - 1]

export const sessionOf = (n: Note) => n.data.session ?? ''

export const order = (a: Note, b: Note) => a.data.range.start - b.data.range.start || (a.data.createdAt ?? a.data.id).localeCompare(b.data.createdAt ?? b.data.id)

/** Most severe first; a note without a severity counts as medium. */
const SEV_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2, nit: 3 }

export const sevRank = (n: Note) => SEV_RANK[n.data.severity ?? 'medium']

/** The sidebar's order inside a group: severity, then the whole-file note, then by line. */
export const rowOrder = (a: Note, b: Note) => sevRank(a) - sevRank(b) || (a.data.target ? 0 : 1) - (b.data.target ? 0 : 1) || order(a, b)

export const SEV_ICON: Record<Severity, [string, string]> = {
  high: ['flame', 'charts.red'], medium: ['triangle-up', 'charts.orange'], low: ['triangle-down', 'charts.blue'], nit: ['dash', 'descriptionForeground'],
}
