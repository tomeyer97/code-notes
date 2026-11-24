// Podcast files in the journeys folders that no journey reads: not named `<journey>.podcast.json`. Each is said once
// in the output (with the journey it names, and why it isn't played), again only after it was gone for a scan.

import * as vscode from 'vscode'
import { readText } from '../platform/jsonFolder'
import { wfs } from '../platform/workspaceFs'
import { isPodcastFile } from '../core/format/podcast/format'
import { strayLine } from './strayLine'

export class StrayPodcasts {
  /** The stray files already said (by uri). */
  private said = new Set<string>()
  constructor(private readonly say: (line: string) => void) {}

  /** The podcast files in `folders` that aren't `known` (the ones next to journeys); `journeyIds`: each journey's
   *  podcast file by journey id. */
  async check(folders: vscode.Uri[], known: Set<string>, journeyIds: Map<string, string>): Promise<void> {
    const seen = new Set<string>()
    for (const dir of folders) {
      for (const file of await podcastFilesIn(dir)) {
        const key = file.toString()
        if (known.has(key)) continue
        seen.add(key)
        if (this.said.has(key)) continue
        this.said.add(key)
        this.say(strayLine(file.fsPath, await readText(file), journeyIds))
      }
    }
    for (const f of [...this.said]) if (!seen.has(f)) this.said.delete(f)
  }
}

/** The `.podcast.json` files directly in `dir` (none when it can't be read). */
async function podcastFilesIn(dir: vscode.Uri): Promise<vscode.Uri[]> {
  let names: [string, vscode.FileType][] = []
  try { names = await wfs.readDirectory(dir) } catch { return [] }
  return names.filter(([name, type]) => type === vscode.FileType.File && isPodcastFile(name)).map(([name]) => vscode.Uri.joinPath(dir, name))
}
