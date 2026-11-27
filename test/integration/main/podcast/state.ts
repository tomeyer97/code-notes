// The podcast's state as the extension's test API reports it, the walk's place in the code, and the podcast tests'
// own wait (it prints that state on a timeout).
import * as vscode from 'vscode'
import * as path from 'path'
import { waiter } from '../../helpers'
import { ctx, tour } from '../context'

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The podcast's state (src/podcast/testing.ts): session, time, playing, the camera, the marks, the players. */
export const pod = () => ctx.api.podcast() as any

/** The code editor the walk shows (not the panel's group). */
export const codeEditor = () => vscode.window.visibleTextEditors.find((e) => e.viewColumn !== tour().mapColumn && e.document.uri.scheme === 'file')
/** Its file's name, '' with none. */
export const codeFile = () => path.basename(codeEditor()?.document.uri.fsPath ?? '')
/** The line lit by the animation (1-based), 0: none. */
export const litLine = () => { const b = tour().beat; return b ? b.line + 1 : 0 }
/** Is `line` (1-based) on screen in the walk's code editor? */
export const onScreen = (line: number) => !!codeEditor()?.visibleRanges.some((r) => r.contains(new vscode.Position(line - 1, 0)))

/**
 * The podcast tests' wait: main/context.ts's `until` with the podcast's state in the dump (named apart so `until`
 * means one thing in the folder).
 */
export const podUntil = waiter({ dump: () => ({ podcast: pod(), step: tour().step, map: tour().map, beat: tour().beat, card: tour().card, values: tour().values, file: codeFile() }) })

// How long the waits wait (each × SCALE): the same values for the same kind of wait.
/** A podcast file found, a panel opened, a podcast playing after a start. */
export const LOAD_MS = 10000
/** The walk moved to where a seek (or Next, or a file rewritten) put the audio. */
export const MOVE_MS = 8000
/** A short reaction: a toggle, a box, a status item (the waiter's own default is 6 s). */
export const QUICK_MS = 5000
