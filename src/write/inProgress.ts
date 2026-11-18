// The journeys Claude is writing (or refreshing) now: never listed half-made; one row each while they are.

import * as vscode from 'vscode'
import { Ask } from '../claude'
import { clock } from '../writing'

/** A journey being written: "Writing: <question> · 1:20", its phase, the model, and the run (to cancel it). */
export interface Writing { id: string; question: string; started: number; phase: string; model: string; ask?: Ask }

export const writingNow = new Map<string, Writing>()

/** Fires when a journey starts or stops being written, and every second while one is (for a list's row). */
export const writingChanged = new vscode.EventEmitter<void>()

/** The rows a list can show for the journeys being written. */
export function writingRows(): { id: string; label: string; question: string; phase: string; model: string }[] {
  return [...writingNow.values()].map((w) => ({
    id: w.id,
    question: w.question,
    phase: w.phase,
    model: w.model,
    label: `Writing: ${w.question} · ${clock(Date.now() - w.started)}`,
  }))
}

/** A journey now being written: listed until runWriter is done with it. */
export function startWriting(w: Writing): void {
  writingNow.set(w.id, w)
  writingChanged.fire()
}
