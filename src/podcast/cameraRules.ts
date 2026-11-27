// The camera's rules without the editor (camera.ts makes the moves): its tunables, the listen settings with their
// defaults, and what each way a wait can end leads to. No vscode here: test/cameraRules.test.ts reads them.

/** The heads-up shows this long (s) before a move. */
export const CUE_LEAD_S = 0.8
/** A heads-up further off than this (ms) is not scheduled yet: a later report schedules it. */
export const CUE_HORIZON_MS = 5000
/** After asking the audio to hold, its time may still move this long (ms): then it did not stop. */
export const PAUSE_CHECK_MS = 250
/** After a hold that did not stop the audio, no waits for this long (ms): the moves go at once. */
export const WAITS_OFF_MS = 30000
/** Audio that moved more than this (s) since the hold was asked did not stop. */
const STILL_S = 0.1

/** The listen settings (package.json `codeNotes.listen.*`) and their defaults, which package.json repeats
 *  (test/cameraRules.test.ts checks the two agree). */
export const LISTEN_DEFAULTS = {
  /** What is lit stays on screen at least this long (s) before the code moves. */
  readBeforeMove: 2.5,
  /** After the code moved, the audio waits this long (s) with the new light on. */
  settleAfterMove: 0.8,
}
export type ListenSettings = typeof LISTEN_DEFAULTS

/** The listen settings as `read(key)` gives them: a number of 0 or more, else the default. */
export function listenSettingsFrom(read: (key: keyof ListenSettings) => unknown): ListenSettings {
  const seconds = (key: keyof ListenSettings) => {
    const v = read(key)
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : LISTEN_DEFAULTS[key]
  }
  return { readBeforeMove: seconds('readBeforeMove'), settleAfterMove: seconds('settleAfterMove') }
}

/** How a wait ended: its time ran out; the reader played on or looked around (`skip`, `release`); the audio did not
 *  stop (`abandon`); a seek, a pause, the session over (`cancel`). */
export type WaitEnd = 'time' | 'skip' | 'release' | 'abandon' | 'cancel'

/** What follows a wait: the audio plays on (`ownResume`: that play report is the camera's, not the reader's ▶); the
 *  walk is put where the audio is now (the move that waited is never made late); waits are off for a while. */
export interface AfterWait { resume: boolean; ownResume: boolean; resync: boolean; backOff: boolean }

export function afterWait(how: WaitEnd): AfterWait {
  switch (how) {
    case 'time': return { resume: true, ownResume: true, resync: false, backOff: false }
    case 'release': return { resume: true, ownResume: true, resync: true, backOff: false }
    case 'skip': return { resume: true, ownResume: false, resync: true, backOff: false }
    case 'abandon': return { resume: true, ownResume: false, resync: true, backOff: true }
    case 'cancel': return { resume: false, ownResume: false, resync: false, backOff: false }
  }
}

/** The audio, asked to hold at `from` (s), is at `now` and still playing: it did not stop. */
export const audioKeptPlaying = (from: number, now: { t: number; playing: boolean }) => now.playing && now.t - from > STILL_S
