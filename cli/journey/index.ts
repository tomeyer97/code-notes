// The code-journey skill's checks on the extension's own rules: journey.py runs `node journey-check.mjs` and sends one
// JSON request per line on stdin; each answer is one JSON line on stdout, {"ok": result} or {"error": "why"}.
// Requests: shape (a journey's fields), scene, mark, podcast, place (an anchor), line (a line found by its text).
import readline from 'node:readline'
import { fileLines, lineOf, place } from './anchors'
import { checkMark } from './marks'
import { checkPodcast, PodcastRequest } from './podcast'
import { sceneIssues } from './scene'
import { shapeProblems } from './shape'

type Request = { op: string } & Record<string, any>

export function answer(r: Request): unknown {
  switch (r.op) {
    case 'shape': return shapeProblems(r.journey)
    case 'scene': return sceneIssues(r.step, r.scene)
    case 'mark': return checkMark(r.mark, r.file, r.doc ?? null, r.onMissing ?? 'drop')
    case 'podcast': return checkPodcast(r as unknown as PodcastRequest)
    case 'place': {
      const lines = r.lines ?? fileLines(r.repo, r.file)
      return lines ? place(lines, r.anchor, r.hint) : null
    }
    case 'line': {
      const lines = r.lines ?? fileLines(r.repo, r.file)
      return lines ? lineOf(lines, r.line, r.text) : -1
    }
    default: throw new Error(`unknown request "${r.op}"`)
  }
}

function serve() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', (line) => {
    if (!line.trim()) return
    let out: unknown
    try { out = { ok: answer(JSON.parse(line)) } } catch (e) { out = { error: (e as Error).message } }
    process.stdout.write(JSON.stringify(out) + '\n')
  })
}

serve()
