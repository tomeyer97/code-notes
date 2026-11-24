// Asking about a step: a note on the step's lines that says which step it is about.

import * as vscode from 'vscode'
import { journeys, mapPanel, notesStore } from './ports'
import { askBoxes, card, podcast, tourState, walk } from './instances'
import { askClaude } from '../ask/run'
import { askAlways, claudeCli, claudeMode } from '../ask/settings'
import { LoadedJourney } from '../journeys/steps'
import { createNote } from '../notes/create'
import { reveal } from '../notes/reveal'
import { Note } from '../notes/store'
import { fireAndForget } from '../platform/run'
import { aboutStepLine, StepNoteKind, StepNoteLink, UPDATE_ASK, UPDATE_REQUEST } from './texts'
import { stepUri } from './stepPlace'
import { stepDraftKey } from '../platform/keys'


/** "Ask about this step": a normal note on the step's lines. With text (tests, scripts): saved at once; else a box asks for it. */
export async function askStep(text?: string): Promise<Note | undefined> {
  const at = walkedStep()
  if (!at) {
    vscode.window.setStatusBarMessage('$(info) No journey step open', 2500)
    return undefined
  }
  if (typeof text === 'string' && text.trim()) return askStepWith(at.lj, at.n, text.trim())
  return askStepInteractive(at.lj, at.n)
}

/** The step the walk is on, if any. */
function walkedStep(): { lj: LoadedJourney; n: number } | undefined {
  const lj = walk().tourJourney()
  return lj && tourState().step ? { lj, n: tourState().step } : undefined
}

/** The walk is still on step n of `lj` (it may move on while a question is typed). */
const stillOn = (lj: LoadedJourney, n: number) => walk().tourJourney() === lj && tourState().step === n

/** A question typed for a step the walk has left: kept as that step's draft (the next Ask there starts with it). */
function keepForStep(draftKey: string, typed: string): undefined {
  askBoxes().drafts.set(draftKey, typed)
  vscode.window.setStatusBarMessage('$(info) The step changed: your question is kept for it', 4000)
  return undefined
}

/** A podcast playing pauses while `what` is written: the step stays under the box. */
async function withPodcastHeld<T>(what: string, fn: () => Thenable<T>): Promise<T> {
  podcast()?.hold(what)
  try {
    return await fn()
  } finally {
    podcast()?.released(what)
  }
}

/** The box for a question on step n, then the note, its thread open with the live answer in it. */
async function askStepInteractive(lj: LoadedJourney, n: number): Promise<Note | undefined> {
  const s = lj.j.steps[n - 1]
  const draftKey = stepDraftKey(lj.j.id, s.id)
  const typed = await withPodcastHeld('question', () => askWithDraft(`Ask about step ${n}/${lj.j.steps.length}: ${s.title}`, draftKey))
  if (!typed?.trim()) return undefined
  // The walk moved on while typing: the question is still about the step it was asked on.
  if (!stillOn(lj, n)) return keepForStep(draftKey, typed)
  const note = await askStepWith(lj, n, typed.trim())
  if (!note) return undefined
  askBoxes().drafts.delete(draftKey)
  // The note's thread, open, with the live answer in it (the status bar is only a second cue).
  const uri = stepUri(lj, n).toString()
  const shownIn = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri)?.viewColumn
  await reveal(note, shownIn ?? walk().claimCodeColumn())
  if (claudeMode() === 'button' && claudeCli()) fireAndForget(askClaude(note), 'askStep: askClaude')
  return note
}

/**
 * The note for a question on step n: on the step's lines, saying which step it is about (by id and title: numbers
 * change when the journey is edited). `extra.journey` is the structured link the code-journey skill and the threads
 * read; `kind` says an update request from a question.
 */
async function askStepWith(lj: LoadedJourney, n: number, text: string, kind?: StepNoteKind): Promise<Note | undefined> {
  const s = lj.j.steps[n - 1]
  const at = lj.at[n - 1]
  const doc = await vscode.workspace.openTextDocument(stepUri(lj, n))
  const link: StepNoteLink = { id: lj.j.id, step: s.id, n, ...(kind ? { kind } : {}) }
  // The prose line stays until the threads render the link themselves (they read it back today).
  const body = `${text}\n\n${aboutStepLine(s.title, s.id, lj.j.title)}`
  const note = await createNote(doc, { start: at.start - 1, end: at.end - 1 }, body, undefined, { journey: link })
  // An update request is about the step's code as written, not whatever sits at those lines now: it carries the
  // journey's copy of that code and is stale from the start.
  const was = journeys().anchorOf(lj, n)
  if (note && at.stale && was && 'text' in was) {
    note.data.anchor = { ...note.data.anchor, ...was }
    note.data.stale = true
    await notesStore().save(note)
  }
  if (note && askAlways()) await askClaude(note)
  return note
}

/**
 * A box of its own (not the editor's comment box: that one needed the cursor on the step's line and could lose what
 * was typed). What is typed is kept under `draftKey`: Esc keeps it for the next ask there. Undefined: Esc.
 */
function askWithDraft(title: string, draftKey: string): Promise<string | undefined> {
  const box = vscode.window.createInputBox()
  box.title = title
  box.placeholder = 'Your question'
  // One hint: as a prompt, VS Code would add "(Press 'Enter' to confirm or 'Escape' to cancel)" after it.
  box.validationMessage = { message: 'Enter asks · Esc keeps the draft', severity: vscode.InputBoxValidationSeverity.Info }
  box.ignoreFocusOut = true
  box.value = askBoxes().drafts.get(draftKey) ?? ''
  return new Promise<string | undefined>((res) => {
    let done = false
    const accept = () => {
      if (!box.value.trim()) return
      done = true
      res(box.value)
      box.hide()
    }
    askBoxes().open = { box, accept }
    box.onDidChangeValue((v) => {
      if (v.trim()) askBoxes().drafts.set(draftKey, v)
      else askBoxes().drafts.delete(draftKey)
    })
    box.onDidAccept(accept)
    box.onDidHide(() => {
      if (!done) res(undefined)
      box.dispose()
      if (askBoxes().open?.box === box) askBoxes().open = undefined
    })
    box.show()
  })
}

/**
 * "Ask the agent to fix it": the request opens prefilled, to add what you know (e.g. where the code went);
 * Enter saves it as a note on the step (`journey`: {id, step, n, kind}, which the code-journey skill acts on), Esc
 * cancels.
 */
export async function askUpdate(): Promise<Note | undefined> {
  const at = walkedStep()
  if (!at) return undefined
  const { lj, n } = at
  const text = await withPodcastHeld('question', () => vscode.window.showInputBox({
    title: `Ask the agent to update step ${n}/${lj.j.steps.length}: ${lj.j.steps[n - 1].title}`,
    value: UPDATE_ASK,
    valueSelection: [UPDATE_ASK.length, UPDATE_ASK.length],
    prompt: 'Add what you know (where it moved, what changed). Enter saves the note; Esc cancels.',
  }))
  if (!text?.trim()) return undefined
  // As for a question: what was typed is kept for the step it was about.
  if (!stillOn(lj, n)) return keepForStep(stepDraftKey(lj.j.id, lj.j.steps[n - 1].id), text)
  const note = await askStepWith(lj, n, text.trim(), UPDATE_REQUEST)
  if (!note) return undefined
  vscode.window.setStatusBarMessage('$(check) Asked the agent to update this step', 3000)
  card().show(lj, n)
  mapPanel().update()
  return note
}
