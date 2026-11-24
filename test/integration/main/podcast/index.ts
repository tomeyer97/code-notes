// A journey's podcast: it plays in the Listen view (the journey panel's player is its remote, so closing the panel
// never stops it) and the walk follows the voice (the step's code opens, the animation's beat lights its line, the
// marks light the words as they are said). The audio is a 40 s tone (test/fixtures/podcast/tone.mp3), so these also
// prove VS Code's own Electron plays mp3 from the workspace (fetched whole, as a blob) and seeks in it.
//
// One file per area; their shared parts:
//   fixtures.ts   the journeys and podcast files (writePodcast, seg, tonePath), when marks light (cues)
//   audio.ts      ten-minute recordings made from the tone
//   state.ts      the podcast's state, the walk's place, `podUntil`
//   player.ts     start, pause, play, seek, the panel, settings for one test, `podTest`
//   webview.ts    the two webviews' frames and players, real clicks, console errors, the editor's own DOM
// Each test sets up the journey it plays (written when missing, started when another one is listened to) and puts
// the camera's settings back when it ends. The first playback test must run first in the window: it checks that
// nothing can play before the first click, and its clicks unlock the players for the window.
import { brokenFileTests } from './brokenFiles'
import { cameraTests } from './camera'
import { listeningTests } from './listening'
import { marksTests } from './marks'
import { playbackTests } from './playback'

export const podcastTests = [...playbackTests, ...brokenFileTests, ...listeningTests, ...marksTests, ...cameraTests]
