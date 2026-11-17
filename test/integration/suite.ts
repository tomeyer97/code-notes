// The main integration suite. Runs inside a real VS Code (see run.ts): drives the extension the way a person and an
// agent would, in one window and one workspace, each test starting from what the one before left.
//
// Where the tests are (and the source files they cover most):
//   main/notes.ts          notes from the first one to the trash   store.ts, anchor.ts, claude.ts, extension.ts
//   main/journeyTour.ts    walking a journey, step cards, lenses   journeys.ts, journeyModel.ts, extension.ts
//   main/keysAndMap.ts     chord keys, the tutorial, the whole map package.json keybindings, tutorialSpot.ts
//   main/journeyFiles.ts   a journey's files changing under it     journeys.ts, gitRenames.ts, anchor.ts, compact.ts
//   main/notesReview.ts    findings: R, severity, history, suggestions, file and folder notes   store.ts, extension.ts
//   main/writeJourney.ts   the agent writes a journey              writing.ts, claude.ts
//   main/repoJourneys.ts   journeys in the repo, compact anchors   journeys.ts, compact.ts
//   main/requests.ts       the request file and vscode:// links    extension.ts, match.ts, writing.ts
//   main/animation.ts      code links, value hints, animations     codeLinks.ts, codeLinkText.ts, valueHints.ts, beats.ts, beatLine.ts
//   roundTrips.ts          calls into the window per action (remote performance)
// The pure modules have unit tests next to this folder (test/<module>.test.ts).
import * as vscode from 'vscode'
import * as path from 'path'
import { activate, runTests, test } from './helpers'
import { ctx, until } from './main/context'
import { notesTests } from './main/notes'
import { journeyTourTests } from './main/journeyTour'
import { keysAndMapTests } from './main/keysAndMap'
import { journeyFilesTests } from './main/journeyFiles'
import { notesReviewTests } from './main/notesReview'
import { writeJourneyTests } from './main/writeJourney'
import { repoJourneysTests } from './main/repoJourneys'
import { requestsTests } from './main/requests'
import { animationTests } from './main/animation'
import { roundTrips } from './roundTrips'

export async function run(): Promise<void> {
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
    // On the animation journey the tests above leave open.
    test('calls into the window per action: within their counts (CODE_NOTES_RTT_MS: their time over a slow link)', () => roundTrips(ctx.api, ctx.ws, until)),
  ])
}
