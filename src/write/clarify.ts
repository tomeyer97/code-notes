// Claude's question before it writes a journey (a page: webview/clarify.html, media/clarify.js and .css), and the
// answer that lets it go on.

import * as vscode from 'vscode'
import { extUri, log } from '../platform/host'
import { LoadedJourney } from '../journeys/steps'
import { escapeHtml, pageBody, webviewPage } from '../webview/page'
import { writeJourney } from './writeJourney'
import { fireAndForget } from '../platform/run'

/** Claude's question before it writes a journey: rendered, with a box whose answer resumes the same session. */
export let clarify: { panel: vscode.WebviewPanel; question: string; session: string; text: string; model?: string } | undefined

export async function showClarify(question: string, session: string, text: string, model?: string): Promise<void> {
  clarify?.panel.dispose()
  let body: string
  try { body = await vscode.commands.executeCommand<string>('markdown.api.render', text) } catch { body = '' }
  if (!body) body = `<pre>${escapeHtml(text)}</pre>`
  const panel = vscode.window.createWebviewPanel('codeNotes.claudeAsks', 'Claude asks',
    { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, { enableScripts: true, retainContextWhenHidden: true })
  const media = (f: string) => vscode.Uri.joinPath(extUri(), 'media', f)
  // Claude's text is rendered Markdown: its images (https:, data:) and style attributes are let in.
  panel.webview.html = webviewPage(panel.webview, {
    css: [media('clarify.css')],
    body: pageBody('clarify', { question: escapeHtml(question), body }),
    scripts: [media('clarify.js')],
    allow: { images: true, inlineStyles: true },
  })
  const c = { panel, question, session, text, model }
  clarify = c
  // The page's messages (media/clarify.js lists them).
  panel.webview.onDidReceiveMessage((m: { type?: string; text?: unknown }) => {
    if (m?.type === 'reply' && typeof m.text === 'string' && m.text.trim()) fireAndForget(answerClarify(m.text), 'clarify: answerClarify')
    else if (m?.type === 'error') log().error(`Claude asks (webview): ${String(m.text)}`)
  })
  panel.onDidDispose(() => { if (clarify === c) clarify = undefined })
}

/** Your answer to Claude's question: the same session goes on and writes the journey. */
export async function answerClarify(reply: string): Promise<LoadedJourney | undefined> {
  const c = clarify
  if (!c || !reply.trim()) return undefined
  clarify = undefined
  c.panel.dispose()
  return writeJourney(c.question, { model: c.model, resume: { session: c.session, reply: reply.trim() } })
}
