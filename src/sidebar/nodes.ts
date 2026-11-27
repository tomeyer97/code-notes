// The rows of the Journeys view (JourneyNode), one object per row kept in journeyNodes (viewSync.ts reveals rows by
// identity). The Code Notes view's rows: noteNodes.ts. `Node` is either, for code that takes a row of both views.

import * as vscode from 'vscode'
import { journeys } from './ports'
import { Group } from '../core/list/journeyList'
import { LoadedJourney } from '../journeys/steps'
import { Note } from '../notes/store'
import { NodeCache } from './nodeCache'
import type { JourneyJob } from '../write/journeyJobs'
import { noteNodes, NoteNode } from './noteNodes'

export type { NoteNode } from './noteNodes'
export { fileNode, noteNode, sessionNode } from './noteNodes'

export type JourneyNode =
  | { kind: 'journeys' }
  | { kind: 'journey'; lj: LoadedJourney; group?: string }
  | { kind: 'jgroup'; g: Group }
  | { kind: 'jmore'; g: string; n: number }
  | { kind: 'badJourney'; uri: vscode.Uri; why: string }
  | { kind: 'intro' }
  | { kind: 'questions'; lj: LoadedJourney; notes: Note[] }
  /** A journey Claude is writing now (journeyRows.ts writingItem). */
  | { kind: 'writing'; job: JourneyJob }

/** A row of either view (the Journeys view also lists note rows: the questions asked from a step). */
export type Node = NoteNode | JourneyNode

/** The Journeys view's rows by key. */
export const journeyNodes = new NodeCache<JourneyNode>()

const NOTE_KINDS = new Set<Node['kind']>(['session', 'file', 'note', 'broken'])

const isNoteNode = (x: Node): x is NoteNode => NOTE_KINDS.has(x.kind)

/** The row kept for `key` in its view's cache (noteNodes or journeyNodes, by its kind). */
export function cached<T extends Node>(key: string, fresh: T): T {
  if (isNoteNode(fresh)) return noteNodes.get(key, fresh)
  return journeyNodes.get(key, fresh as T & JourneyNode)
}

export const journeyNode = (lj: LoadedJourney) => journeyNodes.get(`journey:${lj.key}`, { kind: 'journey' as const, lj })

/** A journey's row in group `group` of the Journeys view (a journey is listed in several groups). */
export const journeyRowNode = (lj: LoadedJourney, group: string) => journeyNodes.get(`journey:${group}:${lj.key}`, { kind: 'journey' as const, lj, group })

export const jgroupNode = (g: Group) => journeyNodes.get(`jgroup:${g.id}`, { kind: 'jgroup' as const, g })

/** "Show all (n more)": the rest of a capped group. */
export const jmoreNode = (g: Group) => journeyNodes.get(`jmore:${g.id}`, { kind: 'jmore' as const, g: g.id, n: g.more! })

/** The journey files that can't be read, by path. */
export const badJourneyNodes = () => [...journeys().invalid.values()]
  .sort((a, b) => a.uri.path.localeCompare(b.uri.path))
  .map((x) => journeyNodes.get(`badJourney:${x.uri}`, { kind: 'badJourney' as const, uri: x.uri, why: x.why }))
