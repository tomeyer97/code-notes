// Asking for a journey from outside the window: the request file (.code-notes/.request.json, written by a script or
// another tool, answered in .result.json) and vscode://<extension id>/explain links. A match opens; no match asks
// first and then writes one with Claude (or Claude asks back); a link never starts Claude.
// Source: src/write/requests.ts (requests, links), src/write/rank.ts (the confirm and pick), src/match.ts (matching),
// src/writing.ts.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'
import { EXT_ID, claudeRuns, fakeCalls, flag, quiet, readJson, test, untilEqual } from '../helpers'
import { readResult, requestFile, writeRequest } from '../fixtures'
import { closeAllEditors, ctx, noteById, setting, snap, until } from './context'
import { repoJourneysDir, savingJourney } from './shared'

/* eslint-disable @typescript-eslint/no-explicit-any */
const requestPath = () => requestFile(ctx.notesDir)
/** Writes a request, stamped now. */
const request = (o: object) => writeRequest(ctx.notesDir, o)
/** What the script reads back. */
const result = () => readResult(ctx.notesDir)
/** Every request and link handled so far: { action, question, via, outcome }. */
const outcomes = (): { action: string; question: string; via: string; outcome: string }[] => ctx.api.explainLog()
/** The link `code --open-url` delivers. */
const explainLink = (q: string, repo = ctx.ws, extra = '') => vscode.Uri.parse(`${vscode.env.uriScheme}://${EXT_ID}/explain?action=ask&q=${encodeURIComponent(q)}${extra}&repo=${encodeURIComponent(repo)}`)
const removeWritten = async () => {
  fs.unlinkSync(path.join(repoJourneysDir(), 'written.json'))
  await until('written gone', () => !snap().journeys.some((x: any) => x.id === 'written'))
}

export const requestsTests = [
  test('request file, ask: the matching journey opens; the file is deleted', async () => {
    await closeAllEditors()
    request({ action: 'ask', question: 'How does saving a note work?', model: '', id: 'req-1', needs: '0.1.0' })
    await until('ask matched', () => outcomes().some((x) => x.via === 'file' && x.outcome === 'opened:saving'))
    await until('result for the script', () => result()?.id === 'req-1')
    assert.deepEqual(result(), { id: 'req-1', outcome: 'opened', title: 'Saving a note' }, 'the result names the journey that opened')
    await until('its map is open', () => snap().tour.map === 'saving')
    await until('request file deleted', () => !fs.existsSync(requestPath()))
    assert.equal(snap().notes.filter((n: any) => n.path.endsWith('.request.json')).length, 0, 'the request file is not a note')
    assert.equal(snap().broken, 0, 'nor a broken one')
  }),

  test('request file, overview: the panel\'s Journeys list', async () => {
    const seen = outcomes().length
    request({ action: 'overview', question: '' })
    await until('overview', () => outcomes().length > seen && outcomes()[seen].outcome === 'overview')
    // The panel's Journeys list (no picker), the tab titled "Journeys".
    await until('the Journeys list in the panel', () => snap().tour.map && snap().tour.mapTitle === 'Journeys', 8000)
  }),

  test('a request older than 2 minutes is ignored', async () => {
    // And deleted.
    const seen = outcomes().length
    writeRequest(ctx.notesDir, { action: 'ask', question: 'saving a note' }, new Date(Date.now() - 5 * 60_000))
    await until('stale request deleted', () => !fs.existsSync(requestPath()))
    await quiet(500, 'the old request handled after all')
    assert.equal(outcomes().length, seen, 'an old request does nothing')
  }),

  test('a request that needs a newer Code Notes is left for it', async () => {
    // For the reloaded window.
    const seen = outcomes().length
    request({ action: 'ask', question: 'How does saving a note work?', id: 'req-new', needs: '99.0.0' })
    await until('too new', () => outcomes().slice(seen).some((x) => x.outcome === 'too-new'))
    await quiet(500, 'the request deleted or answered')
    assert.ok(fs.existsSync(requestPath()) && result()?.id !== 'req-new', 'left alone, no result')
    fs.unlinkSync(requestPath())
  }),

  test('no match asks first, closest journeys first; Cancel starts nothing', async () => {
    const runsBefore = claudeRuns().length
    request({ action: 'ask', question: 'How are saved widgets frobnicated?', model: 'claude-fake-x', id: 'req-2' })
    const confirm = await until('confirm shown', () => ctx.api.confirming())
    assert.match(confirm.title ?? '', /^No journey answers this yet\. Write one with Claude \(claude-fake-x, about 3 min\)\?$/)
    const closest = confirm.items.findIndex((x: string) => /Saving a note/.test(x))
    assert.ok(closest >= 0 && closest < confirm.items.indexOf('$(sparkle) Write') && confirm.items.at(-1) === 'Cancel', `closest journeys first, then Write, Cancel: ${confirm.items}`)
    await untilEqual('result: confirm', () => [result()?.id, result()?.outcome, result()?.model], ['req-2', 'confirm', 'claude-fake-x'])
    ctx.api.answerConfirm('Cancel')
    await until('cancelled', () => outcomes().some((x) => x.question === 'How are saved widgets frobnicated?' && x.outcome === 'cancelled'))
    await quiet(500, 'a Claude run after Cancel')
    assert.equal(claudeRuns().length, runsBefore, `Cancel: no Claude run: ${claudeRuns().slice(runsBefore).map((a) => JSON.stringify(a).slice(0, 200)).join('\n')}`)
  }),

  test('an unknown model is refused before any Claude run, with the message in the result', async () => {
    // The request's model or the setting's.
    const runsBefore = claudeRuns().length
    request({ action: 'ask', question: 'How are gadgets frobnicated?', model: 'sonet', id: 'req-m' })
    await until('result: error', () => result()?.id === 'req-m' && result().outcome === 'error')
    assert.equal(result().message, "Unknown model 'sonet'. Use sonnet, opus, haiku or fable.")
    assert.equal(ctx.api.confirming(), undefined, 'no confirm for a run that can\'t happen')
    await setting('journeys.model', 'sonet')
    assert.equal(await ctx.api.writeJourney('How are gadgets frobnicated?'), undefined)
    await setting('journeys.model', undefined)
    assert.equal(claudeRuns().length, runsBefore, 'nothing spawned')
  }),

  test('request file, ask with no match: after Write, the agent writes the journey with the requested model; its map opens', async () => {
    // Its map opens (not while you walk another journey: then the notice's Open).
    await vscode.commands.executeCommand('codeNotes.endJourney')
    await until('no walk', () => !snap().tour.touring)
    const callsBefore = fakeCalls().length
    request({ action: 'ask', question: 'How are widgets frobnicated?', model: 'claude-fake-x', id: 'req-3' })
    await until('confirm shown', () => ctx.api.confirming()?.question === 'How are widgets frobnicated?')
    ctx.api.answerConfirm('Write')
    await until('writing', () => outcomes().some((x) => x.question === 'How are widgets frobnicated?' && x.outcome === 'writing'))
    await until('result: writing', () => result()?.id === 'req-3' && result().outcome === 'writing')
    await until('written journey map open', () => snap().tour.map === 'written', 15000)
    const cli = fakeCalls()[callsBefore]
    assert.match(flag(cli, '-p')!, /^Use the code-journey skill to answer: How are widgets frobnicated\?/)
    assert.equal(flag(cli, '--model'), 'claude-fake-x')
    assert.match(flag(cli, '-p')!, /--dir \.code-notes\/\.writing\/\S+`.*moves the journey into journeys\//s)
    assert.equal(readJson(path.join(repoJourneysDir(), 'written.json')).model, 'claude-fake-x', 'stamped with the model')
    await removeWritten()
  }),

  test('a clarifying answer is shown with a reply box; the reply resumes the session and the journey is written', async () => {
    // Claude asks a question instead of writing.
    const callsBefore = fakeCalls().length
    const none = await ctx.api.writeJourney('Something unclear about things')
    assert.equal(none, undefined, 'no journey yet')
    const question = await until('Claude\'s question shown', () => ctx.api.clarify())
    assert.equal(question.session, 'sess-clarify')
    assert.match(question.text, /Which part do you mean/)
    const resumedId = await ctx.api.answerClarify('The saving part')
    assert.equal(resumedId, 'written', 'the answer led to the journey')
    const runs = fakeCalls().slice(callsBefore).filter((a) => a.includes('-p'))
    assert.equal(runs.length, 2)
    assert.equal(flag(runs[1], '--resume'), 'sess-clarify', 'the same session goes on')
    assert.match(flag(runs[1], '-p')!, /^The saving part\n/)
    assert.equal(ctx.api.clarify(), undefined, 'the question panel closed')
    await removeWritten()
  }),

  test('"already in journeys/<slug>.json": that journey opens', async () => {
    // Claude writes nothing because a journey already answers it: no error.
    await vscode.commands.executeCommand('codeNotes.endJourney')
    assert.equal(await ctx.api.writeJourney('Something already answered'), 'saving', 'the existing journey opened')
    await until('its map', () => snap().tour.map === 'saving')
    assert.equal(ctx.api.clarify(), undefined, 'not shown as a question')
  }),

  test('Ask on a step opens its own box; the thread stays open under the step with the answer, titled by the question', async () => {
    // Its own box (no cursor needed), the note's thread open with Claude's answer.
    request({ action: 'ask', question: 'How is a note saved to disk?', id: 'req-4' })
    await until('saving opened by that request', () => result()?.id === 'req-4' && result().outcome === 'opened', 8000)
    await until('saving open on a step', () => snap().tour.journey === 'saving' && snap().tour.step >= 1, 8000)
    await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup')
    const notesBefore = snap().notes.length
    void vscode.commands.executeCommand('codeNotes.askStep')
    const box = await until('the Ask box', () => ctx.api.askBox())
    assert.match(box.title ?? '', /^Ask about step \d+\/2: /)
    assert.ok(ctx.api.askBoxSend('Where is the note written?'))
    const asked = await until('step question saved', () => snap().notes.length === notesBefore + 1 && snap().notes.find((x: any) => x.messages[0].body.startsWith('Where is the note written?')))
    await untilEqual('its thread open, titled by the question', () => [!!noteById(asked.id)?.threadExpanded, noteById(asked.id)?.threadLabel], [true, 'Where is the note written?'])
    await until('Claude answered in it', () => noteById(asked.id)?.messages.at(-1)?.author === 'Claude', 10000)
    // The answer as the thread shows it (once re-rendered): its reference is a link.
    await until('the answer\'s reference is a link', () => ctx.api.thread(asked.id)?.comments.some((c: vscode.Comment) => c.author.name === 'Claude' && /\[`src\/renamed\.ts:3`\]\(command:codeNotes\.openAt\?/.test((c.body as vscode.MarkdownString).value)))
    fs.unlinkSync(asked.path)
  }),

  test('a vscode:// link never starts Claude', async () => {
    // Whatever it asks (and its model is ignored): the overview instead.
    const runsBefore = claudeRuns().length
    const seen = outcomes().length
    await vscode.env.openExternal(explainLink('How are gizmos teleported?', ctx.ws, '&model=evil'))
    await until('link handled', () => outcomes().slice(seen).some((x) => x.via === 'uri'), 8000)
    await quiet(800, 'a confirm or a Claude run after the link')
    assert.equal(outcomes().slice(seen).find((x) => x.via === 'uri')!.outcome, 'overview', 'the overview, not a run')
    assert.equal(ctx.api.confirming(), undefined, 'not even the confirm')
    assert.equal(claudeRuns().length, runsBefore, 'no Claude run from a link')
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen')
  }),

  test('vscode://<extension id>/explain links: handled once with the request file; another repo\'s link ignored', async () => {
    // The link (what `code --open-url` delivers), for this repo; the same request as a file is handled once.
    await closeAllEditors()
    await until('map closed', () => !snap().tour.map)
    const seen = outcomes().length
    request({ action: 'ask', question: 'loadNote parses' })
    await vscode.env.openExternal(explainLink('loadNote parses'))
    await until('link handled', () => outcomes().slice(seen).some((x) => x.outcome === 'opened:saving'), 8000)
    await until('map open', () => snap().tour.map === 'saving')
    await quiet(800, 'the same request handled a second time')
    const handled = outcomes().slice(seen)
    assert.equal(handled.filter((x) => x.outcome.startsWith('opened')).length, 1, `handled once: ${JSON.stringify(handled)}`)
    assert.ok(!fs.existsSync(requestPath()), 'request file consumed')
    // A link for another repository: left to the window that has it.
    const before = outcomes().length
    await vscode.env.openExternal(explainLink('loadNote parses', path.join(ctx.ws, '..', 'not-this-repo')))
    await quiet(1000, 'another repo\'s link handled here')
    assert.equal(outcomes().length, before, 'another repo\'s link is ignored here')
  }),

  test('close matches: a pick of them (result "choose"), the one picked opens', async () => {
    // Two journeys answer about equally: a short pick, not one opened silently.
    fs.writeFileSync(path.join(repoJourneysDir(), 'drafts.json'), JSON.stringify({ ...savingJourney, id: 'drafts', title: 'Saving a draft', question: 'How is a draft kept?' }, null, 2))
    await ctx.api.reloadJourneys()
    await until('drafts read', () => snap().journeys.some((x: any) => x.id === 'drafts'))
    const seen = outcomes().length
    request({ action: 'ask', question: 'How does saving work?', id: 'req-5' })
    const titles = await until('the pick', () => ctx.api.choosing() as string[] | undefined)
    assert.deepEqual([...titles].sort(), ['Saving a draft', 'Saving a note'])
    await until('result: choose', () => result()?.id === 'req-5' && result().outcome === 'choose')
    ctx.api.choose('Saving a note')
    await until('opened the one picked', () => outcomes().slice(seen).some((x) => x.outcome === 'opened:saving'))
    fs.rmSync(repoJourneysDir(), { recursive: true, force: true })
    fs.rmSync(path.join(ctx.notesDir, 'journeys', 'saving-copy.json'), { force: true })
  }),
]

