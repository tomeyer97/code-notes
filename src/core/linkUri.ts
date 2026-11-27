// The vscode://<publisher>.code-notes/link URI (for a terminal, an agent's answer): its query read as the lines to light.
// write/uriRoutes.ts handles the URI; claudeChatLinks.ts lights the lines. No vscode API here (unit-tested in
// test/answerLinks.test.ts).

/** vscode://…/link?file=<path, absolute or workspace-relative>&start=<1-based>&end=<1-based>: the lines, lit. */
export function linkTarget(query: string): { file: string; start: number; end: number } | undefined {
  const p = new URLSearchParams(query)
  const file = p.get('file'), start = Number(p.get('start')), end = Number(p.get('end') ?? p.get('start'))
  if (!file || !(start >= 1)) return undefined
  return { file, start, end: end >= start ? end : start }
}
