// Asking about a step: a note on the step's lines that says which step it is about.

import * as vscode from 'vscode'
import { cfg, journeys, mapPanel, store } from '../app'
import { askClaude, claudeMode } from '../ask'
import { findCli } from '../claudeCli'
import { fileOf } from '../journeys/steps'
import { createNote } from '../notes/create'
import { reveal } from '../notes/reveal'
import { refreshAll } from '../refresh'
import { Note } from '../store'
import { card, tour, walk } from './tour'

export const UPDATE_ASK = 'This step is out of date: its code changed or was deleted. Please update the step.'

/** "Ask about this step": a normal note on the step's lines. With text (tests, scripts): saved at once; else a box asks for it. */
export async function askStep(text?: string): Promise<Note | undefined> {
  const lj = walk.tourJourney()
  if (!lj || !tour.step) { vscode.window.setStatusBarMessage('$(info) No journey step open', 2500); return undefined }
  const s = lj.j.steps[tour.step - 1]
  const at = lj.at[tour.step - 1]
  const uri = vscode.Uri.joinPath(lj.folder.uri, fileOf(lj, tour.step))
  // The step by its id and title: numbers change when the journey is edited.
  const about = `_About the step “${s.title}” (id \`${s.id}\`) of the journey “${lj.j.title}”_`
  if (typeof text === 'string' && text.trim()) {
    const doc = await vscode.workspace.openTextDocument(uri)
    const n = await createNote(doc, { start: at.start - 1, end: at.end - 1 }, `${text.trim()}\n\n${about}`, undefined, { journey: { id: lj.j.id, step: s.id, n: tour.step } })
    // An update request is about the step's code as written, not whatever sits at those lines now: it carries the
    // journey's copy of that code and is stale from the start.
    const was = journeys.anchorOf(lj, tour.step)
    if (n && at.stale && was && 'text' in was) { n.data.anchor = { ...n.data.anchor, ...was }; n.data.stale = true; await store.save(n); refreshAll() }
    if (n && claudeMode() === 'always') await askClaude(n)
    return n
  }
  // a box of its own, not the editor's comment box (that one needed the cursor on the step's line and could
  // lose what was typed). Esc keeps the draft for the next Ask on this step.
  const n0 = tour.step
  const dk = `${lj.j.id}|${s.id}`
  const box = vscode.window.createInputBox()
  box.title = `Ask about step ${n0}/${lj.j.steps.length}: ${s.title}`
  box.placeholder = 'Your question'
  // One hint: as a prompt, VS Code would add "(Press 'Enter' to confirm or 'Escape' to cancel)" after it.
  box.validationMessage = { message: 'Enter asks · Esc keeps the draft', severity: vscode.InputBoxValidationSeverity.Info }
  box.ignoreFocusOut = true
  box.value = askDrafts.get(dk) ?? ''
  const typed = await new Promise<string | undefined>((res) => {
    let done = false
    const accept = () => { if (!box.value.trim()) return; done = true; res(box.value); box.hide() }
    stepAskBox = { box, accept }
    box.onDidChangeValue((v) => { if (v.trim()) askDrafts.set(dk, v); else askDrafts.delete(dk) })
    box.onDidAccept(accept)
    box.onDidHide(() => { if (!done) res(undefined); box.dispose(); if (stepAskBox?.box === box) stepAskBox = undefined })
    box.show()
  })
  if (!typed?.trim()) return undefined
  // The walk moved on while typing: the question is still about the step it was asked on.
  const lj2 = walk.tourJourney()
  if (lj2 !== lj || tour.step !== n0) { askDrafts.set(dk, typed); vscode.window.setStatusBarMessage('$(info) The step changed: your question is kept for it', 4000); return undefined }
  const note = await askStep(typed)
  if (!note) return undefined
  askDrafts.delete(dk)
  // the note's thread, open, with the live answer in it (the status bar is only a second cue).
  await reveal(note, vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString())?.viewColumn ?? walk.codeColumn())
  if (claudeMode() === 'button' && findCli(cfg().get<string>('claude.path') || undefined)) void askClaude(note)
  return note
}

/** Questions typed on a step and not sent yet (Esc), by journey|step id. */
export const askDrafts = new Map<string, string>()

/** The open Ask box (for the integration test). */
export let stepAskBox: { box: vscode.InputBox; accept: () => void } | undefined

/**
 * "Ask the agent to fix it": the request opens prefilled, to add what you know (e.g. where the code went);
 * Enter saves it as a note on the step (`journey`: {id, step, n}, which the code-journey skill acts on), Esc cancels.
 */
export async function askUpdate(): Promise<Note | undefined> {
  const lj = walk.tourJourney()
  if (!lj || !tour.step) return undefined
  const n = tour.step
  const text = await vscode.window.showInputBox({
    title: `Ask the agent to update step ${n}/${lj.j.steps.length}: ${lj.j.steps[n - 1].title}`, value: UPDATE_ASK,
    valueSelection: [UPDATE_ASK.length, UPDATE_ASK.length], prompt: 'Add what you know (where it moved, what changed). Enter saves the note; Esc cancels.',
  })
  if (!text?.trim() || tour.step !== n || walk.tourJourney() !== lj) return undefined
  const note = await askStep(text)
  if (note) { vscode.window.setStatusBarMessage('$(check) Asked the agent to update this step', 3000); card.show(lj, n); mapPanel.update() }
  return note
}
