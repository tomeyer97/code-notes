// The storyline as the podcast's chapter list (journey-podcast.js has the episode; episode.js groups its chapters by
// row): number and title, the row being said in bold, ▶ (on hover) to hear just that step, the parts on the map (the
// intro, the recap) as rows of their own, the transcript of the row being said under it (the Transcript switch).
// The rows drawn are kept by their key, so each podcast tick marks them without searching the page.
import { el } from '../common.js'
import { chapterAt, manySpeakers, rowsOf } from './episode.js'

/** A sentence starts this much (s) before its time: the voice is on it already. */
const SENTENCE_LEAD_S = 0.01

/** @param {import('./context.js').PanelContext} ctx */
export function makeChapters(ctx) {
  const { state } = ctx
  const listen = state.listen
  /** What the last storyline drew, by row key ('intro', 's3', 'map5', 'recap'): the row, its transcript, its
   *  sentences. */
  let rows = new Map(), transcripts = new Map(), sentences = new Map()
  /** What the last tick marked: the row being said, the sentence being said. */
  let nowRow, nowSentence

  /** The rows of the episode shown, for the storyline being drawn (undefined: no episode, a plain storyline). */
  function start() {
    rows = new Map()
    transcripts = new Map()
    sentences = new Map()
    nowRow = nowSentence = undefined
    return rowsOf(ctx.podcast && ctx.podcast.episode)
  }

  /** Step n's row in chapter list `byRow`: its button `b` and ▶ (none when the podcast skips the step), the
   *  transcript under them. Returns what goes into `li`. */
  function stepRow(li, b, n, byRow) {
    const c = byRow.steps.get(n)
    const row = el('div', 'strow')
    row.append(b)
    if (!c) {
      li.classList.add('unnarrated')
      b.title = b.title || "The podcast doesn't talk about this step: it pauses here"
    } else row.append(stepListen(n))
    li.dataset.pstep = String(n)
    rows.set(`s${n}`, li)
    return c ? [row, transcript(`s${n}`, c.segs)] : [row]
  }

  /** The parts on the map as rows of the list `groups` (one group of rows per step): the intro first, each map part
   *  after the step it follows, the recap last. Returns how many rows it added. */
  function addParts(groups, byRow, steps) {
    const before = rows.size
    if (byRow.intro) groups.unshift([partRow(byRow.intro, 'Intro')])
    for (const [i, s] of steps.entries()) {
      const after = byRow.after.get(s.n) || []
      groups[i + (byRow.intro ? 1 : 0)].push(...after.map((m) => partRow(m, 'Map')))
    }
    if (byRow.recap) groups.push([partRow(byRow.recap, 'Recap')])
    return rows.size - before
  }

  /** A part on the map as a row like the others (no number): its name, its transcript. */
  function partRow(c, name) {
    const li = el('li', 'ppart')
    const row = el('div', 'strow')
    const b = el('button', 'st part')
    b.append(el('span', 'n', ''), el('span', 't', name))
    b.title = `Listen from the ${name.toLowerCase()}`
    b.onclick = () => ctx.podcast.playFrom(c.start)
    li.dataset.ppart = c.key
    rows.set(c.key, li)
    row.append(b)
    li.append(row, transcript(c.key, c.segs))
    return li
  }

  /** ▶ on a row: that step alone, stopping at its end. */
  function stepListen(n) {
    const label = `Listen to step ${n} only`
    const b = el('button', 'icon plisten', '▶')
    b.title = label
    b.setAttribute('aria-label', label)
    b.onclick = () => ctx.podcast.playStep(n)
    return b
  }

  /** "Transcript" above the chapter list: the transcript of the row being said, under it, following the voice. */
  function transcriptHead() {
    const d = el('div', 'trhead')
    const b = el('button', 'link trtoggle', 'Transcript')
    b.setAttribute('aria-pressed', String(listen.transcriptOn))
    b.onclick = () => {
      listen.transcriptOn = !listen.transcriptOn
      b.setAttribute('aria-pressed', String(listen.transcriptOn))
      showTranscripts()
      ctx.saveState()
    }
    d.append(b)
    return d
  }

  /** The row being said's transcript shown (Transcript on), the others shut. */
  function showTranscripts() {
    for (const [key, t] of transcripts) setOpen(t, listen.transcriptOn && key === listen.row)
  }

  /** A row's transcript: its sentences, the one being said marked; a click goes there. */
  function transcript(key, segs) {
    const podcast = ctx.podcast
    const d = el('div', 'trx')
    d.dataset.tr = key
    setOpen(d, listen.transcriptOn && key === listen.row)
    const named = manySpeakers(podcast.episode)
    const spans = []
    let prevWho = ''
    for (const seg of segs) {
      const p = el('p', 'trp')
      if (named && seg.speaker && seg.speaker !== prevWho) p.append(el('b', 'trw', `${seg.speaker[0].toUpperCase()}${seg.speaker.slice(1)}: `))
      prevWho = seg.speaker || prevWho
      for (const sen of podcast.sentencesOf(seg)) {
        const x = el('span', 'trs', sen.text)
        x.dataset.t = String(sen.start)
        x.dataset.e = String(sen.end)
        x.tabIndex = -1
        x.onclick = () => podcast.seek(sen.start)
        spans.push(x)
        p.append(x, ' ')
      }
      d.append(p)
    }
    transcripts.set(key, d)
    sentences.set(key, spans)
    return d
  }

  /** The podcast's time is `t`: the row being said marked, its transcript the one open, the sentence being said
   *  marked (only when one of them changed). */
  function tick(t, playing) {
    const ep = ctx.podcast && ctx.podcast.episode
    if (!ep) return
    const { key } = chapterAt(ep, t)
    let sen
    for (const x of sentences.get(key) || []) if (t >= Number(x.dataset.t) - SENTENCE_LEAD_S) sen = x
    const k = `${key}|${sen ? sen.dataset.t : ''}|${playing}`
    if (k === listen.lastTick) return
    listen.lastTick = k
    if (key !== listen.row) { listen.row = key; showTranscripts() }
    nowRow?.classList.remove('pnow')
    nowRow = rows.get(key)
    nowRow?.classList.add('pnow')
    nowSentence?.classList.remove('cur')
    nowSentence = sen
    sen?.classList.add('cur')
  }

  return { start, stepRow, addParts, transcriptHead, tick }
}

/** Shut transcripts stay findable (Ctrl+F opens the one with the match: hidden="until-found"). */
function setOpen(t, open) {
  if (open) t.removeAttribute('hidden')
  else t.setAttribute('hidden', 'until-found')
}
