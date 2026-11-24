// Code Notes: notes on code that agents answer in threads, and code journeys. This file is the composition root: it
// makes each feature (its activate, in src/<feature>/index.ts) and hands it what it needs from the others as ports.
// A feature only gets what is made before it; a port to a feature made later is a function that reads `later`, which
// throws if it is called before that feature is made (nothing calls one before activate returns).

import * as vscode from 'vscode'
import { activateAsk } from './ask'
import { activateCheck, CheckFeature } from './check'
import { ChordSteppers } from './chords'
import { activateCodeLinks } from './codeLinks'
import { activateJourneys } from './journeys'
import { activateNotes, inNotesFolder } from './notes'
import { activatePodcast } from './podcast'
import { prefixUsed, startChordKey } from './platform/chordKey'
import { checkouts } from './platform/checkout'
import { Cmd } from './platform/commands'
import { devReload } from './platform/devReload'
import { WorkspaceEvents } from './platform/events'
import { startHost } from './platform/host'
import { portsSlot } from './platform/ports'
import { registerCommands } from './platform/registerCommands'
import { StateStore } from './platform/state'
import { activateSidebar, SidebarFeature } from './sidebar'
import { activateThreads } from './threads'
import { createTour, TourFeature } from './tour'
import { activateWrite } from './write'

export async function activate(context: vscode.ExtensionContext) {
  const features = await compose(context)
  // The test surface exists only for the extension's own tests (not in an installed extension).
  if (context.extensionMode === vscode.ExtensionMode.Production) return undefined
  const { testApi } = await import('./testApi')
  return testApi(features)
}

/** Everything the extension made is in context.subscriptions: each feature pushes what it makes there. */
export function deactivate(): void { /* context.subscriptions are disposed by VS Code */ }

async function compose(context: vscode.ExtensionContext) {
  // activate hands both Mementos to the one StateStore (platform/state.ts).
  const host = startHost(context, new StateStore(context.workspaceState, context.globalState))
  devReload(context, host.log)
  startChordKey(context, host.stored)
  const steppers = new ChordSteppers(prefixUsed)
  // Git's own files, and the notes folder (the store watches it), are no file the notes or steps are on.
  const events = new WorkspaceEvents(checkouts, (u) => inNotesFolder(u) || u.path.includes('/.git/'))
  context.subscriptions.push(events, checkouts)
  const later = { tour: portsSlot<TourFeature>('the tour'), check: portsSlot<CheckFeature>('the check'), sidebar: portsSlot<SidebarFeature>('the views') }
  const tourApi = () => later.tour.get().api
  const check = () => (later.check.ready ? later.check.get().controller : undefined)
  // Before the views are made there is no Journeys view to draw again.
  const refreshJourneyList = () => { if (later.sidebar.ready) later.sidebar.get().refreshJourneys() }

  const journeys = activateJourneys(context, {
    onMapMessage: (lj, m) => later.tour.get().onMapMessage(lj, m),
    mapState: (lj) => later.tour.get().mapState(lj),
  })
  const codeLinks = activateCodeLinks(context, {
    tour: tourApi,
    check: () => (later.check.ready ? later.check.get().links : undefined),
  })
  const threadsLater = portsSlot<{ has(id: string): boolean }>('the threads')
  const notes = await activateNotes(context, {
    journeys: journeys.journeys,
    map: journeys.mapPanel,
    layout: {
      codeColumn: () => tourApi().codeColumn(),
      columnFor: (uri) => tourApi().columnFor(uri),
      walking: () => (tourApi().touring() ? tourApi().tourJourney() : undefined),
      openRef: (lj, file, line, end, step) => tourApi().openRef(lj, file, line, end, step),
      narrates: (e) => tourApi().narrates(e),
      refreshCard: () => tourApi().refreshCard(),
      tourMovedCursor: () => Date.now() < tourApi().state.cursorUntil,
    },
    fixApplied: async (fixFor, file) => { await check()?.fixApplied(fixFor, file) },
    isCheck: (n) => !!check()?.isCheck(n),
    hasThread: (id) => threadsLater.get().has(id),
  }, events, steppers)
  const tour = createTour(context, {
    journeys: journeys.journeys,
    mapPanel: journeys.mapPanel,
    ...codeLinks,
    store: notes.store,
    check,
    isCheckLink: (key) => !!later.check.ready && !!later.check.get().links.noteOf(key),
    refreshJourneyList,
  }, steppers)
  later.tour.set(tour)
  const threads = activateThreads(context, { controller: notes.controller, journeys: journeys.journeys, tour: tour.api, check })
  threadsLater.set(threads)
  const ask = activateAsk(context, { store: notes.store, codeColumn: () => tour.api.codeColumn(), check })
  const sidebar = activateSidebar(context, {
    journeys: journeys.journeys, mapPanel: journeys.mapPanel, store: notes.store, tour: tour.api,
    podcastStatus: (lj) => tour.api.podcast()?.status(lj),
  })
  later.sidebar.set(sidebar)
  const write = activateWrite(context, {
    journeys: journeys.journeys, mapPanel: journeys.mapPanel, claudeLinks: codeLinks.claudeLinks, tour: tour.api,
    refreshJourneyList,
  })
  const podcast = activatePodcast(context, {
    journeys: journeys.journeys, mapPanel: journeys.mapPanel, beats: codeLinks.beats, tour: tour.api, refreshJourneyList,
  }, { steppers, drafting: notes.onDidChangeDrafting })
  const checkFeature = activateCheck(context, {
    store: notes.store, mapPanel: journeys.mapPanel, tour: tour.api, refreshJourneyList,
  }, steppers)
  later.check.set(checkFeature)
  registerCommands(context, {
    [Cmd.next]: (a?: unknown) => steppers.step(1, a),
    [Cmd.previous]: (a?: unknown) => steppers.step(-1, a),
    [Cmd.refresh]: async () => { await notes.store.load(); await journeys.journeys.load() },
  })

  // What follows the notes' changes, in this order: the threads first (the list, the marks and the keys read them),
  // then the views, the notes' own keys, marks and cursor, the status item, the tour. Then the files.
  context.subscriptions.push(
    threads.follow(notes.model, events),
    sidebar.followNotes(notes.model),
    notes.follow(),
    ask.follow(notes.model),
    // Questions asked from a step are listed and linked through their journey.
    journeys.journeys.onDidChange(() => notes.model.changed({ kind: 'journeys' })),
    tour.follow(notes.model, events),
    sidebar.followJourneys(),
    notes.followFiles(),
    journeys.follow(events, { stepsFollowed: (c) => tour.api.stepsFollowed(c), relocated: () => notes.model.changed({ kind: 'branch' }) }),
    notes.followSettings({ loadJourneys: () => journeys.journeys.load(), lensesChanged: () => tour.api.lensesChanged() }),
  )
  await events.watchBranches(vscode.workspace.workspaceFolders ?? [])

  // Everything read, then shown; the walk and the check where they were.
  await Promise.all([notes.load(), journeys.journeys.load()])
  await notes.journeysRead()
  tour.journeysLoaded()
  await notes.shown()
  await tour.restore()
  await checkFeature.start().catch((e) => host.log.error(`understanding check: ${e}`))
  write.takeRequests()
  return { host, journeys, codeLinks, notes, tour, threads, ask, podcast, sidebar, write, check: checkFeature }
}
