// journey.play: a journey walked from a step, as a step link opens it (its map when there is room, then the step).
import * as vscode from 'vscode'
import type { JourneyPlayParams } from '../protocol/bridge'
import { journeyById, LoadedJourney } from '../journeys/steps'
import { HiddenCmd } from '../platform/commands'
import { RequestError } from './failure'
import { journeys } from './ports'

/** A folder as the journeys know it (its URI): a URI as it is, a path as a file URI. */
const folderKey = (folder: string | undefined) =>
  folder === undefined ? undefined : /^[a-z][\w+.-]*:\/\//i.test(folder) ? folder : vscode.Uri.file(folder).toString()

/** The step's number: a number as it is, an id looked up; 0 when the journey has no such step. */
function stepNumber(lj: LoadedJourney, step: number | string | undefined): number {
  const count = lj.j.steps.length
  if (step === undefined) return count ? 1 : 0
  if (typeof step === 'number') return step <= count ? step : 0
  return lj.j.steps.findIndex((s) => s.id === step) + 1
}

export async function playJourney(p: JourneyPlayParams): Promise<{ id: string; title: string; step: number; steps: number }> {
  const lj = journeyById(journeys().list.values(), p.id, folderKey(p.folder))
  if (!lj) throw new RequestError(`no journey with id ${p.id}`)
  const n = stepNumber(lj, p.step)
  if (!n) throw new RequestError(`${p.id} has no step ${p.step ?? 1} (it has ${lj.j.steps.length})`)
  await vscode.commands.executeCommand(HiddenCmd.openStepLink, lj.j.id, lj.j.steps[n - 1].id ?? '', n, lj.folder.uri.toString())
  return { id: lj.j.id, title: lj.j.title, step: n, steps: lj.j.steps.length }
}
