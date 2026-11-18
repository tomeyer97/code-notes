// A guest in this suite: the Journeys view ("In this file", the search) is not part of the check, but this workspace
// (examples/shop) is the one with a journey in the repository (journeys/place-order.json). Source: src/journeyList.ts.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'
import { test, windowShot } from '../helpers'
import { api, until, ws } from './context'

/* eslint-disable @typescript-eslint/no-explicit-any */

export const journeysViewTests = [
  test('Journeys view: "In this file" follows the editor; the search finds a word in a step\'s title', async () => {
    // Finding journeys (journeyList.ts).
    const journeysTree = () => api.journeysTree() as string[]
    const placeOrder = JSON.parse(fs.readFileSync(path.join(ws, 'journeys/place-order.json'), 'utf8'))
    const stepFile = placeOrder.steps[0].file as string
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(ws, stepFile)))
    await until('"In this file" for a file a step is in', () => journeysTree()[0] === 'jgroup:In this file · 1' && /journey:/.test(journeysTree()[1]))
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(ws, 'README.md')))
    await until('no "In this file" for a file no step is in', () => !journeysTree().some((l) => l.startsWith('jgroup:In this file')))
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
