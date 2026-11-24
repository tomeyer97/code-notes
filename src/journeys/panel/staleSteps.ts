// The stale steps of a journey for the list's preview: which, and when their file last changed. Pure (no vscode):
// how a file's last change is found is given.

export interface StaleStep { n: number; when: string }

/** Each stale step (1-based `n`, its `file`) with its file's last change; each file asked once, all files at once
 *  (a journey's stale steps often share a file, and each answer is a few git runs). */
export async function staleSince(steps: { n: number; file: string }[], lastChange: (file: string) => Promise<string>): Promise<StaleStep[]> {
  const files = [...new Set(steps.map((s) => s.file))]
  const when = new Map(files.map((f, i) => [f, i] as const))
  const answers = await Promise.all(files.map(lastChange))
  return steps.map((s) => ({ n: s.n, when: answers[when.get(s.file)!] }))
}
