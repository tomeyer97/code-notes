// What the author is told about podcast files: Problems-view diagnostics on the `.podcast.json` (on the segment or
// field at fault) and warning lines in the "Code Notes" output (once per change, not per scan); and a watch on the
// audio files the podcasts name, so a podcast comes back as soon as its audio is there (or goes when it goes)
// without touching the JSON.

import * as vscode from 'vscode'
import { log } from '../platform/host'
import { PodcastProblem } from '../core/format/podcast/format'
import { lineCol, locate } from '../core/json/spans'

/** The audio files a podcast may name: a change to one of these that a podcast names reads the podcasts again. */
const AUDIO_EXTENSIONS = ['mp3', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'aac', 'flac', 'webm']
/** Changes to audio files this close together (ms) read the podcasts once. */
const AUDIO_SETTLE_MS = 300

/** A watch on the audio files the podcasts name (there or not): any change to one (created, rewritten, deleted)
 *  calls `changed`, once a burst of changes settles. */
class AudioWatcher implements vscode.Disposable {
  /** The audio files named in the last scan, by path. */
  private named = new Set<string>()
  private timer: NodeJS.Timeout | undefined
  private readonly watcher = vscode.workspace.createFileSystemWatcher(`**/*.{${AUDIO_EXTENSIONS.join(',')}}`)

  constructor(private readonly changed: () => void) {
    const onAudio = (u: vscode.Uri) => {
      if (!this.named.has(u.path)) return
      clearTimeout(this.timer)
      this.timer = setTimeout(this.changed, AUDIO_SETTLE_MS)
    }
    this.watcher.onDidCreate(onAudio)
    this.watcher.onDidChange(onAudio)
    this.watcher.onDidDelete(onAudio)
  }

  /** The audio files the podcasts of the last scan name. */
  watch(audio: vscode.Uri[]): void { this.named = new Set(audio.map((u) => u.path)) }

  dispose(): void {
    clearTimeout(this.timer)
    this.watcher.dispose()
  }
}

/** A podcast file read and checked (load.ts PodcastRead), as the reports need it. */
export interface ReportedPodcast { file: vscode.Uri; raw: string; audio?: vscode.Uri; v: { problems: PodcastProblem[] } }

/** Problems-view diagnostics on podcast files, the output's lines about them, and the watch on their audio. */
class PodcastReports {
  private diags: vscode.DiagnosticCollection | undefined
  private audio: AudioWatcher | undefined
  /** What was last reported per file (its problems): unchanged problems are not logged again. */
  private said = new Map<string, string>()

  init(context: vscode.ExtensionContext, rescan: () => void): void {
    this.diags = vscode.languages.createDiagnosticCollection('codeNotes.podcast')
    this.audio = new AudioWatcher(rescan)
    context.subscriptions.push(this.diags, this.audio)
  }

  /** The podcasts read in one scan: diagnostics set on each, cleared on files gone; new problems logged. */
  report(reads: ReportedPodcast[]): void {
    this.audio?.watch(reads.flatMap((r) => (r.audio ? [r.audio] : [])))
    const seen = new Set<string>()
    for (const r of reads) {
      const key = r.file.toString()
      seen.add(key)
      this.diags?.set(r.file, r.v.problems.map((p) => diagnostic(r.raw, p)))
      const sig = r.v.problems.map((p) => `${p.level}:${p.message}`).join('\n')
      if (this.said.get(key) === sig) continue
      this.said.set(key, sig)
      for (const p of r.v.problems) logProblem(r.file, p)
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

/** A problem's line in the output: an error says the podcast isn't played. */
function logProblem(file: vscode.Uri, p: PodcastProblem): void {
  const line = `podcast ${file.fsPath}: ${p.level === 'error' ? 'not played: ' : ''}${p.message}`
  if (p.level === 'info') log().info(line)
  else log().warn(line)
}

const SEVERITY = { error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning, info: vscode.DiagnosticSeverity.Information }

/** A problem as a diagnostic: on the field or segment at fault. */
function diagnostic(raw: string, p: PodcastProblem): vscode.Diagnostic {
  const span = locate(raw, p.path)
  const a = lineCol(raw, span.start)
  // A long value (a whole segment): its first line only.
  const eol = raw.indexOf('\n', span.start)
  const end = Math.min(span.end, eol >= 0 ? eol : span.end)
  const b = lineCol(raw, Math.max(end, span.start + 1))
  const d = new vscode.Diagnostic(new vscode.Range(a.line, a.col, b.line, b.col), p.message, SEVERITY[p.level])
  d.source = 'Code Notes podcast'
  d.code = p.code
  return d
}

export const podcastReports = new PodcastReports()
