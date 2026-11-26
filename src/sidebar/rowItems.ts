// How each row of the Journeys view looks: its groups and intro here, a journey's row and its questions' in
// journeyRows.ts, a question's own row as the Code Notes view draws it (notesRows.ts).

import * as vscode from 'vscode'
import { tour } from './ports'
import { badJourneyItem, journeyItem, questionsItem, showIntro, writingItem } from './journeyRows'
import { listState } from './listModel'
import { JourneyNode, Node } from './nodes'
import { notesRowItem } from './notesRows'
import { notesRowFacts } from './notesTree'
import { Cmd } from '../platform/commands'

/** A row of the Journeys view. */
export function itemOf(node: Node): vscode.TreeItem {
  switch (node.kind) {
    case 'journeys': return journeysItem()
    case 'intro': return introItem()
    case 'journey': return journeyItem(node.lj, node.group)
    case 'badJourney': return badJourneyItem(node)
    case 'questions': return questionsItem(node)
    case 'jgroup': return jgroupItem(node)
    case 'jmore': return jmoreItem(node)
    case 'writing': return writingItem(node)
    default: return notesRowItem(node, notesRowFacts())
  }
}

/** Open the first time (with one quiet line saying what it is), then folded: reading material, not an inbox. */
function journeysItem(): vscode.TreeItem {
  const open = (tour().tourJourney() && tour().state.step) || showIntro()
  const item = new vscode.TreeItem('Journeys', open ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
  // Its name only: the rows below are the count and the explanation.
  item.id = 'journeys'
  item.contextValue = 'journeys'
  return item
}

function introItem(): vscode.TreeItem {
  const item = new vscode.TreeItem('Journeys explain how the code works')
  item.id = 'journeys-intro'
  item.iconPath = new vscode.ThemeIcon('info', new vscode.ThemeColor('descriptionForeground'))
  item.tooltip = 'Each one answers a question with a map of the code and its steps. Click one to open its map.'
  return item
}

/** A group of the Journeys view (In this file, Continue, All, an area): open unless it is All under other groups;
 *  areas fold when there are many of them (a handful stay open). Its count: the journeys in it. */
function jgroupItem(node: Extract<JourneyNode, { kind: 'jgroup' }>): vscode.TreeItem {
  const g = node.g
  const groups = listState.last?.groups
  const open = g.id !== 'all' || !groups?.some((x) => x.id === 'here' || x.id === 'continue')
  const areas = groups?.find((x) => x.id === 'all')?.children?.length ?? 0
  const expanded = g.id.startsWith('area:') ? areas <= MANY_AREAS : open
  const item = new vscode.TreeItem(g.label, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
  item.id = `jgroup:${g.id}`
  const n = g.children ? g.children.reduce((a, c) => a + c.keys.length, 0) : g.keys.length + (g.more ?? 0)
  item.description = String(n)
  item.contextValue = 'jgroup'
  return item
}

/** More areas than this: each area's group starts folded. */
const MANY_AREAS = 4

/** "Show all (n more)": the rest of a capped group (In this file). */
function jmoreItem(node: Extract<JourneyNode, { kind: 'jmore' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(`Show all (${node.n} more)`)
  item.id = `jmore:${node.g}`
  item.command = { command: Cmd.journeysHereAll, title: 'Show all' }
  return item
}
