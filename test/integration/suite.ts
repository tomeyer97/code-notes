// The main integration suite. Runs inside a real VS Code (see run.ts): drives the extension the way a person and an
// agent would, in one window and one workspace. `chapters` below is the suite: its order is the order the tests run
// in, and ONLY=<name> runs some of them (each chapter's setup gives it what the chapters before would have).
// The pure modules have unit tests next to this folder, named after the module: src/<module>.ts in
// test/<module>.test.ts, src/<folder>/<module>.ts in test/<folder, singular><Module>.test.ts (src/journeys/steps.ts:
// journeySteps.test.ts, src/tour/stepText.ts: tourStepText.test.ts).
import { Chapter, createSuiteContext, runChapters } from './helpers'
import { setMainContext, useFakeClaude } from './main/context'
import { notesTests } from './main/notes'
import { journeyTourTests } from './main/journeyTour'
import { keysAndMapTests } from './main/keysAndMap'
import { journeyFilesTests } from './main/journeyFiles'
import { notesReviewTests } from './main/notesReview'
import { writeJourneyTests } from './main/writeJourney'
import { repoJourneysTests } from './main/repoJourneys'
import { requestsTests } from './main/requests'
import { animationTests } from './main/animation'
import { journeyMarksTests } from './main/journeyMarks'
import { roundTripsTests } from './main/roundTrips'
import { podcastTests } from './main/podcast'
import { listenEditorTests } from './main/listenEditor'

/**
 * The fake claude CLI, wired up for a chapter that runs after the notes chapter. The notes chapter wires it up
 * itself, part-way through (set earlier, every note it creates before would be asked to Claude: src/notes/create.ts).
 */
const fakeClaude = { setup: useFakeClaude }

/** The main suite's chapters, in the order they run (and the source files each covers most). */
export const chapters: Chapter[] = [
  { name: 'notes', file: 'main/notes.ts', tests: notesTests,
    covers: 'notes from the first one to the trash   notes/, threads/, store.ts, anchor.ts, ask/, claude.ts' },
  { name: 'journeyTour', file: 'main/journeyTour.ts', tests: journeyTourTests, ...fakeClaude,
    covers: 'walking a journey, step cards, lenses   journeys/, journeyModel.ts, tour/' },
  { name: 'keysAndMap', file: 'main/keysAndMap.ts', tests: keysAndMapTests, ...fakeClaude,
    covers: 'chord keys, the tutorial, the whole map   package.json keybindings, tutorialSpot.ts' },
  { name: 'journeyFiles', file: 'main/journeyFiles.ts', tests: journeyFilesTests, ...fakeClaude,
    covers: 'a journey\'s files changing under it   journeys/, gitRenames.ts, anchor.ts, compact.ts' },
  { name: 'notesReview', file: 'main/notesReview.ts', tests: notesReviewTests, ...fakeClaude,
    covers: 'findings: R, severity, history, suggestions, file and folder notes   notes/, sidebar/, noteModel.ts' },
  { name: 'writeJourney', file: 'main/writeJourney.ts', tests: writeJourneyTests, ...fakeClaude,
    covers: 'the agent writes a journey   write/, writing.ts, claude.ts' },
  { name: 'repoJourneys', file: 'main/repoJourneys.ts', tests: repoJourneysTests, ...fakeClaude,
    covers: 'journeys in the repo, compact anchors   journeys/, compact.ts' },
  { name: 'requests', file: 'main/requests.ts', tests: requestsTests, ...fakeClaude,
    covers: 'the request file and vscode:// links   write/, match.ts, writing.ts' },
  { name: 'animation', file: 'main/animation.ts', tests: animationTests, ...fakeClaude,
    covers: 'code links, value hints, animations   codeLinks.ts, codeLinkText.ts, valueHints.ts, beats.ts, lineFollow.ts' },
  { name: 'roundTrips', file: 'main/roundTrips.ts', tests: roundTripsTests, ...fakeClaude,
    covers: 'calls into the window per action (remote performance), on the journey animation.ts leaves' },
  { name: 'journeyMarks', file: 'main/journeyMarks.ts', tests: journeyMarksTests, ...fakeClaude,
    covers: 'a walked step\'s marks and its beats\'   tour/stepMarks.ts, marks/lights.ts, card.ts, beats.ts' },
  { name: 'podcast', file: 'main/podcast/', tests: podcastTests, ...fakeClaude,
    covers: 'a journey\'s podcast: the walk follows the audio, seeks, the audio while hidden   podcast/' },
  { name: 'listenEditor', file: 'main/listenEditor.ts', tests: listenEditorTests, ...fakeClaude,
    covers: 'the editor while a podcast plays: the card, the marks, what goes quiet   tour/card.ts, podcast/marks.ts' },
]

/** The entry point run.ts starts VS Code with (extensionTestsPath). */
export async function run(): Promise<void> {
  setMainContext(await createSuiteContext())
  await runChapters('code-notes integration test', chapters)
  console.log('all passed')
}
