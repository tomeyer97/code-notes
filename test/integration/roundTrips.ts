// Calls into the window per user action. Over Remote-SSH the extension host runs on the remote machine and each awaited
// call into the window (show a file, a context key, a stored value) waits one network round trip, so an action that
// awaits six of them in a row takes six round trips. This counts them for the actions people repeat all the time
// (a code link, Back, the next and the previous step, a link from a chat) and checks the counts stay small.
// CODE_NOTES_RTT_MS=<ms>: each such call also waits that long (a slow link), and the time each action takes is printed.
import * as vscode from 'vscode'
import * as path from 'path'
import assert from 'assert'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Counts (and with a round trip set, delays) the calls into the window the extension makes while `run` is running. */
export function callCounter(api: { mementos?: () => vscode.Memento[] }) {
  const rtt = Number(process.env.CODE_NOTES_RTT_MS) || 0
  let calls: string[] = []
  let on = false
  const undo: (() => void)[] = []
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const wrap = (obj: any, name: string, label: (...a: any[]) => string | undefined) => {
    const orig = obj[name]
    obj[name] = function (this: unknown, ...a: any[]) {
      const l = on ? label(...a) : undefined
      if (!l) return orig.apply(this, a)
      calls.push(l)
      const r = orig.apply(this, a)
      return rtt ? Promise.resolve(r).then(async (v: unknown) => { await sleep(rtt); return v }) : r
    }
    undo.push(() => { obj[name] = orig })
  }
  const known = (u: vscode.Uri) => vscode.workspace.textDocuments.some((d) => d.uri.toString() === u.toString())
  wrap(vscode.window, 'showTextDocument', (u: any) => `show ${path.basename((u?.uri ?? u)?.path ?? '')}`)
  // Already open: the extension host has it, nothing goes to the window.
  wrap(vscode.workspace, 'openTextDocument', (u: any) => (u instanceof vscode.Uri && !known(u) ? `open ${path.basename(u.path)}` : undefined))
  // Commands the extension registered itself run in the extension host; the window's own ones (setContext, focus, …) don't.
  wrap(vscode.commands, 'executeCommand', (id: string, ...a: any[]) => (id.startsWith('codeNotes.') && !id.endsWith('.focus') ? undefined : `command ${id}${id === 'setContext' ? ` ${a[0]}` : ''}`))
  for (const m of api.mementos?.() ?? []) wrap(m, 'update', (k: string) => `store ${k}`)
  return {
    rtt,
    async measure(what: string, run: () => PromiseLike<unknown>, settled: () => boolean | Promise<boolean>): Promise<{ calls: string[]; ms: number }> {
      calls = []
      on = true
      const t0 = Date.now()
      try {
        await run()
        for (let i = 0; i < 200 && !(await settled()); i++) await sleep(25)
      } finally { on = false }
      const ms = Date.now() - t0
      console.log(`    ${what}: ${calls.length} call${calls.length === 1 ? '' : 's'} into the window, ${ms} ms${rtt ? ` with ${rtt} ms per round trip` : ''}${calls.length ? ` (${calls.length > 12 ? Object.entries(calls.reduce((m: Record<string, number>, x) => { const k = x.split(' ').slice(0, 2).join(' '); m[k] = (m[k] ?? 0) + 1; return m }, {})).map(([k, n]) => `${n}× ${k}`).join(', ') : calls.join(', ')})` : ''}`)
      return { calls: [...calls], ms }
    },
    dispose() { for (const u of undo.splice(0)) u() },
  }
}

/** The main suite's journey with code links ("anim", step 1: links into its own file and into tok.ts). */
export async function roundTrips(api: any, ws: string, until: <T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, ms?: number) => Promise<T>): Promise<void> {
  const bt = () => api.snapshot().tour
  const animUri = vscode.Uri.file(path.join(ws, 'src', 'anim.ts')).toString(), tokUri = vscode.Uri.file(path.join(ws, 'src', 'tok.ts')).toString()
  const c = callCounter(api)
  const r0: Record<string, { calls: string[]; ms: number }> = {}
  try {
    // Reading every note and journey, as at activation (files: test/wfs.test.ts checks none go through the window).
    r0.load = await c.measure('reading the notes and journeys', () => vscode.commands.executeCommand('codeNotes.refresh'), () => true)
    await vscode.commands.executeCommand('codeNotes.openJourney', 'anim')
    await until('walking anim', () => bt().journey === 'anim' && bt().step >= 1, 10000)
    if (bt().step !== 1) await vscode.commands.executeCommand('codeNotes.previousStep')
    await until('step 1', () => bt().step === 1 && !!bt().card, 10000)
    await sleep(500)
    const r: Record<string, { calls: string[]; ms: number }> = {}
    r.next = await c.measure('next step', () => vscode.commands.executeCommand('codeNotes.nextStep'), () => bt().step === 2 && !!bt().card)
    await sleep(300)
    r.previous = await c.measure('previous step', () => vscode.commands.executeCommand('codeNotes.previousStep'), () => bt().step === 1 && !!bt().card && vscode.window.activeTextEditor?.document.uri.toString() === animUri)
    await sleep(300)
    r.link = await c.measure('code link into another file', () => vscode.commands.executeCommand('codeNotes.codeLink', bt().codeLinks.key, 4), () => bt().codeLinks.active === 4 && bt().codeLinks.back)
    await sleep(300)
    r.back = await c.measure('Back to the step', () => vscode.commands.executeCommand('codeNotes.codeLinkBack'), () => bt().codeLinks.active === -1 && vscode.window.activeTextEditor?.document.uri.toString() === animUri && !!bt().card)
    await sleep(300)
    r.same = await c.measure('code link into the card\'s file', () => vscode.commands.executeCommand('codeNotes.codeLink', bt().codeLinks.key, 1), () => bt().codeLinks.active === 1)
    await vscode.commands.executeCommand('codeNotes.codeLink', bt().codeLinks.key, 1)
    await until('off again', () => bt().codeLinks.active === -1, 10000)
    // Next, Next, Next before the first has shown anything: the walk ends on the last step asked for, its file and
    // its card (an older step never shows its file or takes the newer card away). Steps in four files.
    const files = ['anim.ts', 'tok.ts', 'flow.ts', 'flow2.ts'].filter((f) => require('fs').existsSync(path.join(ws, 'src', f)))
    require('fs').writeFileSync(path.join(ws, '.code-notes', 'journeys', 'hop.json'), JSON.stringify({
      version: 2, id: 'hop', question: 'Where does it go?', title: 'Hop', summary: '', nodes: [{ id: 'f', kind: 'function', label: 'f' }], edges: [],
      steps: files.map((f, k) => ({ id: `h${k}`, title: `In ${f}`, node: 'f', file: `src/${f}`, range: { start: 1, end: 1 }, lead: `Step ${k + 1}.`, refs: [] })),
    }))
    await until('hop read', () => api.snapshot().journeys.some((x: any) => x.id === 'hop'), 10000)
    await vscode.commands.executeCommand('codeNotes.openJourney', 'hop')
    await until('walking hop', () => bt().journey === 'hop' && bt().step === 1 && !!bt().card, 10000)
    await sleep(500)
    const last = files.length
    r.rapid = await c.measure(`Next ×${last - 1} at once`, async () => { await Promise.all(files.slice(1).map(() => vscode.commands.executeCommand('codeNotes.nextStep'))) },
      () => bt().step === last && !!bt().card && vscode.window.activeTextEditor?.document.uri.path.endsWith(`/src/${files[last - 1]}`) === true)
    await sleep(1000)
    assert.ok(bt().step === last && !!bt().card && vscode.window.activeTextEditor?.document.uri.path.endsWith(`/src/${files[last - 1]}`), `after quick Nexts: step ${bt().step}, card ${!!bt().card}, editor ${vscode.window.activeTextEditor?.document.uri.path}`)
    await vscode.commands.executeCommand('codeNotes.endJourney')
    require('fs').rmSync(path.join(ws, '.code-notes', 'journeys', 'hop.json'))
    // A link from a chat (its vscode:// link): its lines lit, Back to where the reader was.
    await vscode.commands.executeCommand('codeNotes.endJourney')
    await until('the walk ended', () => !bt().journey || !bt().step, 10000)
    // Set up with chat links off (a caret restored at a line start right after a show reads as a link).
    const links = vscode.workspace.getConfiguration('codeNotes')
    await links.update('claudeLinks', false, vscode.ConfigurationTarget.Workspace)
    await sleep(300)
    const tok = await vscode.window.showTextDocument(vscode.Uri.parse(tokUri), { preview: false })
    tok.selection = new vscode.Selection(3, 2, 3, 2)
    await sleep(300)
    await links.update('claudeLinks', undefined, vscode.ConfigurationTarget.Workspace)
    await until('nothing lit', () => api.snapshot().claudeLinks && !api.snapshot().claudeLinks.lit, 10000)
    await sleep(1200)
    // Whole lines selected in an editor that was already in front (a command, an extension): not a link.
    tok.selection = new vscode.Selection(4, 0, 5, 0)
    await sleep(400)
    assert.ok(!api.snapshot().claudeLinks.lit, 'whole lines selected in the editor in front: not a chat link')
    tok.selection = new vscode.Selection(3, 2, 3, 2)
    await sleep(300)
    // As the chat opens a link: the file shown with its lines selected (VS Code reports no kind up to 1.14x, Command after).
    r.chat = await c.measure('link from a chat', () => vscode.window.showTextDocument(vscode.Uri.parse(animUri), { preview: true, selection: new vscode.Selection(1, 0, 2, 0) }),
      () => api.snapshot().claudeLinks.lit?.start === 1 && api.snapshot().claudeLinks.back)
    await sleep(300)
    r.chatBack = await c.measure('Back from a chat link', () => vscode.commands.executeCommand('codeNotes.claudeLinkBack'), () => !api.snapshot().claudeLinks.lit && vscode.window.activeTextEditor?.document.uri.toString() === tokUri && vscode.window.activeTextEditor.selection.active.line === 3)
    // Its vscode:// link (a terminal) lights the lines too.
    const pkg = JSON.parse(require('fs').readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'))
    await vscode.env.openExternal(vscode.Uri.parse(`${vscode.env.uriScheme}://${pkg.publisher}.${pkg.name}/link?file=src/anim.ts&start=2&end=3`))
    await until('the vscode:// link lit its lines', () => api.snapshot().claudeLinks.lit?.start === 1, 10000)
    await vscode.commands.executeCommand('codeNotes.claudeLinkBack')
    // What each action may call at most besides storing its place (stored in the background, not waited for; each one a
    // round trip over a remote link).
    const most: Record<string, number> = { next: 1, previous: 1, link: 1, back: 1, same: 0, chatBack: 1 }
    for (const [k, n] of Object.entries(most)) {
      const waited = r[k].calls.filter((x) => !x.startsWith('store '))
      assert.ok(waited.length <= n, `${k}: ${waited.length} calls into the window (at most ${n}): ${waited.join(', ')}`)
    }
  } finally { c.dispose() }
}
