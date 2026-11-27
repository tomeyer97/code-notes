// Everything the journey panel keeps between renders, in one object (render() draws from it): the walk, the panel's
// own view, the step's animation and the podcast. Each part of the page gets this object through the panel context
// (context.js) and reads or changes only what it says it does.

/** @typedef {import('../../src/core/format/journeyModel').Journey} Journey */
/** @typedef {import('../../src/protocol/map').TourInfo} TourInfo */

/**
 * The walk as the last tour message said it, drawn from until the next one.
 * @param {Partial<TourInfo>} m
 * @param {number} cur
 */
export const tourOf = (m, cur) => ({
  /** The walk was just finished: Done, the summary. */
  done: !!m.done,
  /** step number -> 'stale' */
  marks: m.marks || {},
  /** Rule breaks only the author can fix (a link to the Output panel). */
  authors: m.authors || 0,
  /** Why the journey can't be read, for readers. */
  problems: m.problems || [],
  /** The step card, when it lives here ("panel"); undefined: it is in the editor. */
  card: m.card && cur ? m.card : undefined,
  /** Steps asked about: n -> { id, count, unread }. */
  asked: m.asked || {},
  /** A check's tour: its questions, each after the step that shows its answer ({ id, n, step, text, state, cur }). */
  stops: m.stops || [],
  /** Who wrote it and when; steps whose code changed since: { text, tip, changed }. */
  prov: m.prov,
})
/** @typedef {ReturnType<typeof tourOf>} Tour */

/** The panel's state, starting from what the webview kept over a reload (`saved`: snapshot()'s last value). */
export function createState(saved = {}) {
  return {
    walk: {
      /** @type {Journey | undefined} The journey shown. */
      journey: undefined,
      /** The current step (0: not walking). */
      cur: 0,
      /** @type {Tour} */
      tour: tourOf({}, 0),
      /** The journey's file is gone: its name ('' while it is there). */
      deleted: '',
      /** The keys' prefix (Ctrl+' …), as the extension binds them. */
      key: "Ctrl+'",
    },
    view: {
      legendHidden: false,
      /** Narrow panels: the map above the storyline, folded away under "Map" by hand (shown by default). */
      mapShut: !!saved.mapShut,
      /** The map column's width when wide, dragged on the splitter; 0: the default. Kept here and by the extension. */
      mapW: saved.mapW || 0,
      /** The next render starts at the top. */
      toTop: false,
      /** The scroll to restore once after a reload (the first render). */
      savedScroll: saved.scroll || 0,
      firstRender: true,
      /** What the last scroll followed ("step|question"): the storyline scrolls to the current row once per change. */
      scrolled: '',
      /** The sticky header's height (px) at the last render; the page's --headH is set from it. */
      headH: 0,
      /** When the reader last scrolled by hand (ms): the podcast does not scroll the page for a moment after. */
      readerScrolled: 0,
    },
    anim: {
      /** The step's animation is shown in place of the map: a toggle on the rows of steps that have one. */
      on: !!saved.animOn,
      /** The scene on screen ("journey|step"), so the editor's highlight is cleared when it goes. */
      sceneKey: '',
      /** @type {Record<string, number>} The beat each step's animation was on, during this walk: next step and back
       *  returns to it. */
      beatAt: {},
      /** The next render puts the keyboard focus in the scene (it was started: ← → work at once). */
      focusScene: false,
      /** @type {Record<string, boolean>} Scenes ("journey|step") the podcast jumped to: shown at their beat without
       *  its flight. */
      stillAt: {},
      /** @type {'reader' | 'podcast'} Who moved the animation last: the podcast's moves keep the keyboard where it
       *  is and are not reported as the reader's. */
      movedBy: 'reader',
    },
    listen: {
      /** The audio is playing (its host says so): the step's animation (or the map) alone under a one-line header.
       *  On pause the chapter list comes back. */
      playing: false,
      /** The episode listened to in this panel and not over yet (its key; '' none): the header stays one line,
       *  paused too, until it ends (or End). */
      session: saved.podSession || '',
      /** The Transcript switch: the transcript of the row being said shows under it (across re-renders). */
      transcriptOn: !!saved.trOn,
      /** The row the voice is on ('intro', 's3', 'map5', 'recap'): its transcript is the one shown. */
      row: '',
      /** What the last tick marked ("row|sentence|playing"): the rows are marked again only when it changes. */
      lastTick: '',
      /** The voice moved to another step: the next render scrolls to it. */
      scrollToVoice: false,
    },
  }
}
/** @typedef {ReturnType<typeof createState>} PanelState */

/** What the webview keeps over a reload (src/tour/commands.ts reads `id`, `q`, `cur`, `n`). */
export function snapshot(s) {
  const j = s.walk.journey
  return {
    id: j && j.id,
    q: j && j.question,
    cur: s.walk.cur,
    n: j ? j.steps.length : 0,
    scroll: window.scrollY,
    mapShut: s.view.mapShut,
    mapW: s.view.mapW,
    animOn: s.anim.on,
    trOn: s.listen.transcriptOn,
    podSession: s.listen.session,
  }
}

/** Step `n`'s animation, when it has one with beats. */
export function sceneOf(s, n) {
  const step = s.walk.journey && s.walk.journey.steps[n - 1]
  const ok = step && step.scene && Array.isArray(step.scene.beats) && step.scene.beats.length
  return ok ? step.scene : undefined
}
