// Text as the lists and threads show it: one line of markdown as plain text, ages, shortened questions.

/** One line of a markdown message, as plain text. */
export function plain(s: string, max = 80): string {
  const l = (s.split('\n').find((x) => x.trim()) ?? '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^\s*(#+|>)\s*/, '').replace(/\*\*|__|~~|`/g, '')
    .replace(/(^|[^\w*])[*_](?=\S)(.+?)(?<=\S)[*_](?![\w*])/g, '$1$2').replace(/\s+/g, ' ').trim()
  return l.length > max ? l.slice(0, max - 1) + '…' : l
}

export function ago(at?: string): string {
  const t = Date.parse(at ?? '')
  if (!t) return ''
  const s = Math.max(0, (Date.now() - t) / 1000)
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`
}

/** Text in a Unicode isolate (FSI…PDI) when it holds right-to-left letters; plain text stays as it is. */
export const isolate = (t: string) => (/[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(t) ? `\u2068${t}\u2069` : t)

export const shortQ = (q: string, max = 60) => { const t = q.replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t }
