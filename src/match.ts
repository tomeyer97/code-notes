// Which journey answers a question: most of its telling words, in the question/title first, with light stems
// and synonyms ("change" finds "update"). No vscode API here (unit-tested in test/match.test.ts).

/** Words that say nothing about which journey ("how does … work?"). */
export const STOP = new Set(('a an and are as at be by can could did do does doing for from get gets go goes how i in into is it its me my of on or our ' +
  'should so that the their there this to us was we what when where which who why will with work works would you your explain happen happens ' +
  'whole application app code flow most').split(' '))

const SYNONYMS = [
  ['update', 'change', 'modify', 'edit', 'upgrade'], ['delete', 'remove', 'drop', 'destroy'], ['create', 'add', 'new', 'make'],
  ['start', 'launch', 'begin', 'boot'], ['stop', 'end', 'halt', 'teardown', 'shutdown'], ['auth', 'authentication', 'login', 'signin', 'sign'],
  ['permission', 'rbac', 'access', 'role', 'authorization'], ['save', 'store', 'persist', 'storage', 'write'], ['load', 'read', 'fetch'],
  ['test', 'check', 'verify', 'verdict'], ['deploy', 'install', 'release', 'rollout'], ['error', 'fail', 'failure', 'crash'],
  ['config', 'configuration', 'setting', 'settings'], ['user', 'account', 'member'], ['env', 'environment'], ['cert', 'certificate', 'tls', 'ssl'],
]

/** Light stems: "environments", "versioned", "running" → "environment", "version", "runn". */
export const stem = (w: string) => w.replace(/(?:ing|ed|es|s)$/, (m) => (w.length - m.length >= 4 ? '' : m))

const words = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(Boolean)

/** The telling words of a question, stemmed. */
export function tellingWords(q: string): string[] {
  return [...new Set(words(q).filter((w) => !STOP.has(w)).map(stem))]
}

/** A word and its synonyms (stemmed). */
function variants(w: string): string[] {
  const out = new Set([w])
  for (const g of SYNONYMS) if (g.some((x) => stem(x) === w)) for (const x of g) out.add(stem(x))
  return [...out]
}

const hit = (v: string, hay: string[]) => hay.some((h) => h === v || (v.length >= 4 && h.startsWith(v)) || (h.length >= 4 && v.startsWith(h)))

export interface JourneyText { title: string; question: string; summary: string; steps: string[] }

/**
 * How well a journey answers a question: `matched` telling words (of `total`), `weight` (title/question 3, summary 2,
 * step titles 1; a synonym counts a little less), `answers`: most of the words matched (all of 1-2 words, else 60 %).
 */
export function scoreJourney(j: JourneyText, question: string): { matched: number; total: number; weight: number; answers: boolean } {
  const qs = tellingWords(question)
  const head = [...words(j.title), ...words(j.question)].map(stem)
  const sum = words(j.summary).map(stem)
  const steps = j.steps.flatMap(words).map(stem)
  let matched = 0, weight = 0
  for (const w of qs) {
    let best = 0
    for (const v of variants(w)) {
      const k = v === w ? 1 : 0.8
      best = Math.max(best, hit(v, head) ? 3 * k : hit(v, sum) ? 2 * k : hit(v, steps) ? 1 * k : 0)
    }
    if (best) { matched++; weight += best }
  }
  const total = qs.length
  const need = total <= 2 ? total : Math.ceil(total * 0.6)
  return { matched, total, weight, answers: total > 0 && matched >= need }
}
