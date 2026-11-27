// A guest in this suite: the Journeys view ("In this file", the search) is not part of the check, but this workspace
// (examples/shop) is the one with a journey in the repository (journeys/place-order.json). Source: src/core/list/journeyList.ts.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'
import { test, windowShot } from '../helpers'
import { api, until, ws } from './context'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A row of the Journeys view: its kind (`jgroup`, `journey`, …), label, description (a group's count) and depth. */
type JourneyRow = { depth: number; kind: string; label: string; description?: string }

/** The Journeys view's rows, read from the test API's text lines (`  kind:label · description [icon]`). */
function journeyRows(): JourneyRow[] {
  return (api.journeysTree() as string[]).map((line) => {
    const depth = (line.length - line.trimStart().length) / 2
    const [, kind, rest] = /^(\w+):(.*)$/.exec(line.trim()) ?? ['', '', line.trim()]
    const [label, description] = rest.replace(/ \[[^\]]*\]$/, '').split(' · ')
    return { depth, kind, label, description }
  })
}
const inThisFile = () => journeyRows().find((r) => r.kind === 'jgroup' && r.label === 'In this file')

export const journeysViewTests = [
  test('Journeys view: "In this file" follows the editor; the search finds a word in a step\'s title', async () => {
    const placeOrder = JSON.parse(fs.readFileSync(path.join(ws, 'journeys/place-order.json'), 'utf8'))
    const stepFile = placeOrder.steps[0].file as string
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(ws, stepFile)))
    await until('"In this file" for a file a step is in', () => { const rows = journeyRows(); return rows[0]?.kind === 'jgroup' && rows[0].label === 'In this file' && rows[0].description === '1' && rows[1]?.kind === 'journey' })
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(ws, 'README.md')))
    await until('no "In this file" for a file no step is in', () => !inThisFile())
    const words = (t: string) => t.toLowerCase().match(/[a-z]{5,}/g) ?? []
    const own = new Set([...words(placeOrder.title), ...words(placeOrder.question), ...words(placeOrder.summary ?? '')])
    const word = placeOrder.steps.flatMap((x: any) => words(x.title)).find((w: string) => !own.has(w))
    assert.ok(word, 'a word only a step title has')
    const found = api.journeyList({ query: word })
    assert.ok(found.sections[0].keys.some((k: string) => found.rows[k].title === placeOrder.title), `"${word}" finds "${placeOrder.title}" by a step's title`)
    await vscode.commands.executeCommand('codeNotes.journeys.focus')
    await windowShot('journeys-sidebar', { wait: 600 })
    return `"${word}"`
  }),
]
