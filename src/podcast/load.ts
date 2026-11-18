// Reading a journey's podcast file and telling the author what is wrong with it (validate.ts says what): Problems-view
// diagnostics on the `.podcast.json` (on the segment or field at fault), warning lines in the "Code Notes" output
// (once per change, not per scan), and a watch on the audio files the podcasts name, so a podcast comes back as soon
// as its audio is there (or goes when it goes) without touching the JSON. The player (player.ts) decides what it
// plays from the result.

import * as vscode from 'vscode'
import { log } from '../app'
import { LoadedJourney } from '../journeys/steps'
import { readText } from '../jsonFolder'
import { wfs } from '../workspaceFs'
import { podcastFileOf, PodcastProblem } from './model'
import { audioPathProblem, lineCol, locate, validatePodcast, Validation } from './validate'

/** A podcast file next to a journey, read and checked. */
export interface PodcastRead {
  file: vscode.Uri
  raw: string
  /** The audio file it names (undefined: it names none, or one outside the journeys folder). */
  audio?: vscode.Uri
  audioSize: number
  v: Validation
}

/** The podcast next to `lj` (undefined: there is none), checked against `lj` and, once known, its audio's length. */
export async function readPodcast(lj: LoadedJourney, audioLength: (audio: vscode.Uri, size: number) => number | undefined): Promise<PodcastRead | undefined> {
  const file = lj.uri.with({ path: podcastFileOf(lj.uri.path) })
  const raw = await readText(file)
  if (raw === undefined) return undefined
  const journey = { id: lj.j.id, steps: lj.j.steps.map((s) => ({ id: s.id, beats: s.scene?.beats?.length ?? 0 })) }
  // The audio, when the file names one that can be used: is it there, and how big.
  const first = validatePodcast(raw, { journey })
  const name = first.podcast?.audio
  let audio: vscode.Uri | undefined
  let exists = false, size = 0
  if (name && !audioPathProblem(name)) {
    audio = vscode.Uri.joinPath(file, '..', name)
    try { size = (await wfs.stat(audio)).size; exists = true } catch { /* not there */ }
  }
  if (!audio) return { file, raw, audioSize: 0, v: first }
  const audioDuration = exists ? audioLength(audio, size) : undefined
  return { file, raw, audio, audioSize: size, v: validatePodcast(raw, { journey, audio: { exists, size }, audioDuration }) }
}

/** The audio files podcasts name (there or not), by path: a change to one reads the podcasts again. */
const WATCHED_AUDIO = new Set<string>()

/** Problems-view diagnostics on podcast files, and the output's lines about them. */
class PodcastReports {
  private diags: vscode.DiagnosticCollection | undefined
  /** What was last reported per file (its problems): unchanged problems are not logged again. */
  private said = new Map<string, string>()

  init(context: vscode.ExtensionContext, rescan: () => void): void {
    this.diags = vscode.languages.createDiagnosticCollection('codeNotes.podcast')
    // The audio files: any change to one that a podcast names (created, rewritten, deleted) reads the podcasts again.
    const w = vscode.workspace.createFileSystemWatcher('**/*.{mp3,ogg,oga,opus,wav,m4a,aac,flac,webm}')
    let timer: NodeJS.Timeout | undefined
    const onAudio = (u: vscode.Uri) => {
      if (!WATCHED_AUDIO.has(u.path)) return
      clearTimeout(timer)
      timer = setTimeout(rescan, 300)
    }
    w.onDidCreate(onAudio)
    w.onDidChange(onAudio)
    w.onDidDelete(onAudio)
    context.subscriptions.push(this.diags, w, { dispose: () => clearTimeout(timer) })
  }

  /** The podcasts read in one scan: diagnostics set on each, cleared on files gone; new problems logged. */
  report(reads: PodcastRead[]): void {
    WATCHED_AUDIO.clear()
    const seen = new Set<string>()
    for (const r of reads) {
      if (r.audio) WATCHED_AUDIO.add(r.audio.path)
      const key = r.file.toString()
      seen.add(key)
      this.diags?.set(r.file, r.v.problems.map((p) => diagnostic(r.raw, p)))
      const sig = r.v.problems.map((p) => `${p.level}:${p.message}`).join('\n')
      if (this.said.get(key) === sig) continue
      this.said.set(key, sig)
      for (const p of r.v.problems) log.warn(`podcast ${r.file.fsPath}: ${p.level === 'error' ? 'not played: ' : ''}${p.message}`)
    }
    for (const key of [...this.said.keys()]) {
      if (seen.has(key)) continue
      this.said.delete(key)
      this.diags?.delete(vscode.Uri.parse(key))
    }
  }

  /** The problems of one file (tests). */
  of(file: vscode.Uri): readonly vscode.Diagnostic[] { return this.diags?.get(file) ?? [] }
}

/** A problem as a diagnostic: on the field or segment at fault. */
function diagnostic(raw: string, p: PodcastProblem): vscode.Diagnostic {
  const span = locate(raw, p.path)
  const a = lineCol(raw, span.start)
  // A long value (a whole segment): its first line only.
  const end = Math.min(span.end, raw.indexOf('\n', span.start) >= 0 ? raw.indexOf('\n', span.start) : span.end)
  const b = lineCol(raw, Math.max(end, span.start + 1))
  const d = new vscode.Diagnostic(new vscode.Range(a.line, a.col, b.line, b.col), p.message, p.level === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning)
  d.source = 'Code Notes podcast'
  d.code = p.code
  return d
}

export const podcastReports = new PodcastReports()
