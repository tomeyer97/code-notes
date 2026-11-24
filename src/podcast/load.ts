// Reading a journey's podcast file and telling the author what is wrong with it (validate.ts says what): Problems-view
// diagnostics on the `.podcast.json` (on the segment or field at fault), warning lines in the "Code Notes" output
// (once per change, not per scan), and a watch on the audio files the podcasts name, so a podcast comes back as soon
// as its audio is there (or goes when it goes) without touching the JSON. The player (player.ts) decides what it
// plays from the result.

import * as vscode from 'vscode'
import { journeys, log } from '../app'
import { stepFileUri } from '../journeys/codeGroup'
import { git } from '../platform/checkout'
import { fileOf, LoadedJourney } from '../journeys/steps'
import { readText } from '../platform/jsonFolder'
import { wfs } from '../platform/workspaceFs'
import { isPodcastFile, podcastFileOf, PodcastProblem } from './model'
import { audioPathProblem, lineCol, locate, markFileNames, validatePodcast, Validation } from './validate'

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
  const journey = {
    id: lj.j.id,
    steps: lj.j.steps.map((s) => ({
      id: s.id, beats: s.scene?.beats?.length ?? 0, file: s.file,
      beatFiles: (s.scene?.beats ?? []).map((b) => (typeof b.code?.file === 'string' ? b.code.file : null)),
    })),
  }
  // The audio, when the file names one that can be used: is it there, and how big.
  const first0 = validatePodcast(raw, { journey })
  // The files the marks are in, read for their check (the lines there, the match in them).
  const texts = new Map<string, string | null>()
  for (const f of first0.podcast ? markFileNames(first0.podcast, journey) : []) {
    texts.set(f, (await readText(stepFileUri(lj.folder.uri, journeys.renames(lj), f))) ?? null)
  }
  const files = (f: string) => (texts.has(f) ? texts.get(f) : undefined)
  const first = texts.size ? validatePodcast(raw, { journey, files }) : first0
  const name = first.podcast?.audio
  let audio: vscode.Uri | undefined
  let exists = false, size = 0
  if (name && !audioPathProblem(name)) {
    audio = vscode.Uri.joinPath(file, '..', name)
    try { size = (await wfs.stat(audio)).size; exists = true } catch { /* not there */ }
  }
  const commit = first.podcast?.journey.commit
  const changed = commit ? await changedSince(lj, commit) : undefined
  if (!audio) return { file, raw, audioSize: 0, v: changed ? validatePodcast(raw, { journey, changed, files }) : first }
  const audioDuration = exists ? audioLength(audio, size) : undefined
  return { file, raw, audio, audioSize: size, v: validatePodcast(raw, { journey, audio: { exists, size }, audioDuration, changed, files }) }
}

/** git's answers per journey and commit, for a few seconds (a scan reads every podcast; scans come in bursts). */
const changedCache = new Map<string, { at: number; steps: number[] | undefined }>()
const CHANGED_CACHE_MS = 10_000

/**
 * The steps of `lj` whose file changed since `commit` (committed since, or edited and not committed): by number.
 * Undefined when git can't say (no git, a commit this checkout doesn't have).
 */
async function changedSince(lj: LoadedJourney, commit: string): Promise<number[] | undefined> {
  const key = `${lj.key}|${commit}`
  const hit = changedCache.get(key)
  if (hit && Date.now() - hit.at < CHANGED_CACHE_MS) return hit.steps
  const out = /^[0-9a-f]{4,40}$/i.test(commit) ? await git(lj.folder, ['diff', '--name-only', '--relative', commit, '--']) : undefined
  const files = out === undefined ? undefined : new Set(out.split('\n').map((l) => l.trim()).filter(Boolean))
  const steps = files && lj.j.steps.map((s, k) => (files.has(fileOf(lj, k + 1)) || files.has(s.file) ? k + 1 : 0)).filter((n) => n > 0)
  changedCache.set(key, { at: Date.now(), steps })
  return steps
}

/**
 * Podcast files in the journeys folders that no journey reads: not named `<journey>.podcast.json` (F115). Said once
 * per file, with what it names and why it isn't played; `known`: the podcast files next to journeys.
 */
export async function strayPodcasts(folders: vscode.Uri[], known: Set<string>, journeyIds: Map<string, string>): Promise<void> {
  const seen = new Set<string>()
  for (const dir of folders) {
    let names: [string, vscode.FileType][] = []
    try { names = await wfs.readDirectory(dir) } catch { continue }
    for (const [name, type] of names) {
      if (type !== vscode.FileType.File || !isPodcastFile(name)) continue
      const file = vscode.Uri.joinPath(dir, name)
      if (known.has(file.toString())) continue
      seen.add(file.toString())
      if (strays.has(file.toString())) continue
      strays.add(file.toString())
      const raw = await readText(file)
      let id: unknown
      try { id = (JSON.parse(raw ?? '') as { journey?: { id?: unknown } })?.journey?.id } catch { /* said below without it */ }
      const journeyFile = name.replace(/\.podcast\.json$/i, '.json')
      const owner = typeof id === 'string' ? journeyIds.get(id) : undefined
      const named = typeof id === 'string'
        ? `; its journey.id is "${id}"${owner ? ` (whose podcast is ${owner})` : ', and no journey here has that id'}`
        : ''
      log.info(`podcast ${file.fsPath}: ignored: a podcast plays next to its journey, named <journey>.podcast.json, and there is no ${journeyFile}${named}`)
    }
  }
  for (const f of [...strays]) if (!seen.has(f)) strays.delete(f)
}
/** Stray podcast files already said. */
const strays = new Set<string>()

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
      for (const p of r.v.problems) {
        const line = `podcast ${r.file.fsPath}: ${p.level === 'error' ? 'not played: ' : ''}${p.message}`
        if (p.level === 'info') log.info(line)
        else log.warn(line)
      }
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
  const severity = { error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning, info: vscode.DiagnosticSeverity.Information }[p.level]
  const d = new vscode.Diagnostic(new vscode.Range(a.line, a.col, b.line, b.col), p.message, severity)
  d.source = 'Code Notes podcast'
  d.code = p.code
  return d
}

export const podcastReports = new PodcastReports()
