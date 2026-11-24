// Asking about a step: a note on the step's lines that says which step it is about.

import * as vscode from 'vscode'
import { journeys, mapPanel, store } from '../app'
import { askClaude } from '../ask/run'
import { askAlways, claudeCli, claudeMode } from '../ask/settings'
import { fileOf, LoadedJourney } from '../journeys/steps'
import { createNote } from '../notes/create'
import { reveal } from '../notes/reveal'
import { Note } from '../notes/store'
import { card, tourState, walk } from './instances'
import { podcasts } from '../podcast/player'
import { fireAndForget } from '../platform/run'
import { stepDraftKey } from '../platform/keys'

export const UPDATE_ASK = 'This step is out of date: its code changed or was deleted. Please update the step.'

/** A note asking the agent to update its step (made by askUpdate: it starts with UPDATE_ASK). */
export const isUpdateRequest = (n: Note) => !!n.data.messages[0]?.body.startsWith(UPDATE_ASK.slice(0, 30))

/** "Ask about this step": a normal note on the step's lines. With text (tests, scripts): saved at once; else a box asks for it. */
export async function askStep(text?: string): Promise<Note | undefined> {
  const lj = walk.tourJourney()
  if (!lj || !tourState.step) {
    vscode.window.setStatusBarMessage('$(info) No journey step open', 2500)
    return undefined
  }
  if (typeof text === 'string' && text.trim()) return noteOnStep(lj, tourState.step, text.trim())
  const n = tourState.step
  const s = lj.j.steps[n - 1]
  const draftKey = stepDraftKey(lj.j.id, s.id)
  const uri = vscode.Uri.joinPath(lj.folder.uri, fileOf(lj, n))
  // A podcast playing pauses while the question is written: the step stays under the box (F126).
  podcasts.hold('question')
  const typed = await askWithDraft(`Ask about step ${n}/${lj.j.steps.length}: ${s.title}`, draftKey).finally(() => podcasts.released('question'))
  if (!typed?.trim()) return undefined
  // The walk moved on while typing: the question is still about the step it was asked on.
  if (walk.tourJourney() !== lj || tourState.step !== n) {
    askDrafts.set(draftKey, typed)
    vscode.window.setStatusBarMessage('$(info) The step changed: your question is kept for it', 4000)
    return undefined
  }
  const note = await askStep(typed)
  if (!note) return undefined
  askDrafts.delete(draftKey)
  // The note's thread, open, with the live answer in it (the status bar is only a second cue).
  const shownIn = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString())?.viewColumn
  await reveal(note, shownIn ?? walk.codeColumn())
  if (claudeMode() === 'button' && claudeCli()) fireAndForget(askClaude(note), 'askStep: askClaude')
  return note
}

/** The note for a question on step n: on the step's lines, saying which step it is about (by id and title: numbers
 *  change when the journey is edited). */
async function noteOnStep(lj: LoadedJourney, n: number, text: string): Promise<Note | undefined> {
  const s = lj.j.steps[n - 1]
  const at = lj.at[n - 1]
  const uri = vscode.Uri.joinPath(lj.folder.uri, fileOf(lj, n))
  const about = `_About the step “${s.title}” (id \`${s.id}\`) of the journey “${lj.j.title}”_`
  const doc = await vscode.workspace.openTextDocument(uri)
  const link = { journey: { id: lj.j.id, step: s.id, n } }
  const note = await createNote(doc, { start: at.start - 1, end: at.end - 1 }, `${text}\n\n${about}`, undefined, link)
  // An update request is about the step's code as written, not whatever sits at those lines now: it carries the
  // journey's copy of that code and is stale from the start.
  const was = journeys.anchorOf(lj, n)
  if (note && at.stale && was && 'text' in was) {
    note.data.anchor = { ...note.data.anchor, ...was }
    note.data.stale = true
    await store.save(note)
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
  box.value = askDrafts.get(draftKey) ?? ''
  return new Promise<string | undefined>((res) => {
    let done = false
    const accept = () => {
      if (!box.value.trim()) return
      done = true
      res(box.value)
      box.hide()
    }
    stepAskBox = { box, accept }
    box.onDidChangeValue((v) => {
      if (v.trim()) askDrafts.set(draftKey, v)
      else askDrafts.delete(draftKey)
    })
    box.onDidAccept(accept)
    box.onDidHide(() => {
      if (!done) res(undefined)
      box.dispose()
      if (stepAskBox?.box === box) stepAskBox = undefined
    })
    box.show()
  })
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
  if (!lj || !tourState.step) return undefined
  const n = tourState.step
  podcasts.hold('question')
  const text = await vscode.window.showInputBox({
    title: `Ask the agent to update step ${n}/${lj.j.steps.length}: ${lj.j.steps[n - 1].title}`,
    value: UPDATE_ASK,
    valueSelection: [UPDATE_ASK.length, UPDATE_ASK.length],
    prompt: 'Add what you know (where it moved, what changed). Enter saves the note; Esc cancels.',
  }).then((x) => { podcasts.released('question'); return x })
  if (!text?.trim() || tourState.step !== n || walk.tourJourney() !== lj) return undefined
  const note = await askStep(text)
  if (!note) return undefined
  vscode.window.setStatusBarMessage('$(check) Asked the agent to update this step', 3000)
  card.show(lj, n)
  mapPanel.update()
  return note
}
