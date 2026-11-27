// What the chapters ask of the fake Claude (test/fixtures/fake-grader.js): one scenario file in the workspace's .git,
// read by the fake each time it looks. The fake's own comment says what each field does.
import * as fs from 'fs'
import * as path from 'path'
import { ws } from './context'

/** The fake's scenario (its `Scenario` type). */
export type FakeScenario = {
  /** Writing the questions fails as with a model that doesn't exist. */
  writeError?: boolean
  /** The fake waits there until released: before `start` of the questions, or before the tour's journey. */
  hold?: 'start' | 'tour'
  /** The tour is not written (as when Claude gives up). */
  noTour?: boolean
}

const scenarioFile = path.join(ws, '.git', 'fake-grader.json')
const holdingFile = path.join(ws, '.git', 'fake-grader-holding')
/** The marker the suite's entry (index.ts) writes for "no tour" before the scenario file existed. */
const noTourMarker = path.join(ws, '.git', 'fake-no-tour')

function readScenario(): FakeScenario {
  try { return JSON.parse(fs.readFileSync(scenarioFile, 'utf8')) } catch { return {} }
}

/** Changes the fields given (undefined removes one) and keeps the others. */
export function setFakeScenario(change: FakeScenario): void {
  fs.writeFileSync(scenarioFile, JSON.stringify({ ...readScenario(), ...change }))
}

/** Whether a fake run is waiting at `point` now. */
export const fakeHolding = (point: NonNullable<FakeScenario['hold']>): boolean => {
  try { return fs.readFileSync(holdingFile, 'utf8') === point } catch { return false }
}

/** Lets a held run go on (or the next run not wait). */
export function releaseFake(): void {
  setFakeScenario({ hold: undefined })
  fs.rmSync(holdingFile, { force: true })
}

/** From now on the fake writes the tour (the tests before the tour's are about the questions alone). */
export function fakeWritesTours(): void {
  fs.rmSync(noTourMarker, { force: true })
  setFakeScenario({ noTour: false })
}
