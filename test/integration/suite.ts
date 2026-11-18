// The main integration suite. Runs inside a real VS Code (see run.ts): drives the extension the way a person and an
// agent would, in one window and one workspace, each test starting from what the one before left.
//
// Where the tests are (and the source files they cover most):
//   main/notes.ts          notes from the first one to the trash   notes/, threads/, store.ts, anchor.ts, ask.ts, claude.ts
//   main/journeyTour.ts    walking a journey, step cards, lenses   journeys/, journeyModel.ts, tour/
//   main/keysAndMap.ts     chord keys, the tutorial, the whole map package.json keybindings, tutorialSpot.ts
//   main/journeyFiles.ts   a journey's files changing under it     journeys/, gitRenames.ts, anchor.ts, compact.ts
//   main/notesReview.ts    findings: R, severity, history, suggestions, file and folder notes   notes/, sidebar/, noteModel.ts
//   main/writeJourney.ts   the agent writes a journey              write/, writing.ts, claude.ts
//   main/repoJourneys.ts   journeys in the repo, compact anchors   journeys/, compact.ts
//   main/requests.ts       the request file and vscode:// links    write/, match.ts, writing.ts
//   main/animation.ts      code links, value hints, animations     codeLinks.ts, codeLinkText.ts, valueHints.ts, beats.ts, lineFollow.ts
//   main/roundTrips.ts     calls into the window per action (remote performance), on the journey animation.ts leaves
// The pure modules have unit tests next to this folder, named after the module: src/<module>.ts in
// test/<module>.test.ts, src/<folder>/<module>.ts in test/<folder, singular><Module>.test.ts (src/journeys/steps.ts:
// journeySteps.test.ts, src/tour/stepText.ts: tourStepText.test.ts).
// Set up here: `ctx` (main/context.ts). The fake claude CLI is wired up later, by the first test that asks Claude
// (main/notes.ts "Ask Claude: …", `useFakeClaude`): set earlier, every note created before it would be asked to
// Claude (src/notes/create.ts). The tests after it (writeJourney.ts, requests.ts) read its log.
import * as vscode from 'vscode'
import * as path from 'path'
import { activate, runTests } from './helpers'
import { ctx } from './main/context'
import { notesTests } from './main/notes'
import { journeyTourTests } from './main/journeyTour'
import { keysAndMapTests } from './main/keysAndMap'
import { journeyFilesTests } from './main/journeyFiles'
import { notesReviewTests } from './main/notesReview'
import { writeJourneyTests } from './main/writeJourney'
import { repoJourneysTests } from './main/repoJourneys'
import { requestsTests } from './main/requests'
import { animationTests } from './main/animation'
import { roundTripsTests } from './main/roundTrips'

/** The entry point run.ts starts VS Code with (extensionTestsPath). */
export async function run(): Promise<void> {
  console.log('code-notes integration test')
  ctx.folder = vscode.workspace.workspaceFolders![0]
  ctx.ws = ctx.folder.uri.fsPath
  ctx.notesDir = path.join(ctx.ws, '.code-notes')
  ctx.api = await activate()
  await runTests([
    ...notesTests,
    ...journeyTourTests,
    ...keysAndMapTests,
    ...journeyFilesTests,
    ...notesReviewTests,
    ...writeJourneyTests,
    ...repoJourneysTests,
    ...requestsTests,
    ...animationTests,
    ...roundTripsTests,
  ])
  console.log('all passed')
}
