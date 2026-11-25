// Claude's question before it writes a journey (a page: webview/clarify.html, media/clarify.js and .css; its messages:
// src/protocol/clarify.ts), and the answer that lets it go on.

import * as vscode from 'vscode'
import { extUri, log } from '../platform/host'
import { LoadedJourney } from '../journeys/steps'
import type { FromClarify, ToClarify } from '../protocol/clarify'
import { pageBody, pageScript, webviewPage } from '../webview/page'
import { WebviewChannel } from '../webview/channel'
import { escapeHtml } from '../core/escape'
import { writeJourney } from './writeJourney'
import { fireAndForget } from '../platform/run'

/** The question Claude asked, and the session its answer resumes. */
interface Asked { question: string; session: string; text: string; model?: string }

/** "Claude asks": the page with Claude's question rendered, and a box whose answer resumes the same session. */
class ClarifyPanel implements Asked {
  readonly question: string
  readonly session: string
  readonly text: string
  readonly model?: string
  private readonly panel: vscode.WebviewPanel
  private readonly channel = new WebviewChannel<FromClarify, ToClarify>('Claude asks (webview)', log())

  constructor(a: Asked, body: string) {
    this.question = a.question
    this.session = a.session
    this.text = a.text
    this.model = a.model
    this.panel = vscode.window.createWebviewPanel('codeNotes.claudeAsks', 'Claude asks',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, { enableScripts: true, retainContextWhenHidden: true })
    const media = (f: string) => vscode.Uri.joinPath(extUri(), 'media', f)
    // Claude's text is rendered Markdown: its images (https:, data:) and style attributes are let in.
    this.panel.webview.html = webviewPage(this.panel.webview, {
      css: [media('common.css'), media('clarify.css')],
      body: pageBody('clarify', { question: escapeHtml(a.question), body }),
      scripts: [pageScript(extUri(), 'clarify')],
      allow: { images: true, inlineStyles: true },
    })
    // The channel logs the page's errors; a reply is checked here too (a webview's message).
    const listening = this.channel.attach(this.panel.webview, (m) => {
      if (m?.type !== 'reply' || typeof m.text !== 'string' || !m.text.trim()) return
      fireAndForget(answerClarify(m.text), 'clarify: answerClarify')
    })
    this.panel.onDidDispose(() => {
      listening.dispose()
      this.channel.detach()
      if (clarify === this) clarify = undefined
    })
  }

  dispose(): void { this.panel.dispose() }
}

/** The open "Claude asks" (one at a time); the integration tests read it through src/testApi.ts. */
export let clarify: ClarifyPanel | undefined

/** Shows Claude's question `text` about `question` (the session `session` goes on with the answer). */
export async function showClarify(question: string, session: string, text: string, model?: string): Promise<void> {
  clarify?.dispose()
  let body: string
  try { body = await vscode.commands.executeCommand<string>('markdown.api.render', text) } catch { body = '' }
  if (!body) body = `<pre>${escapeHtml(text)}</pre>`
  clarify = new ClarifyPanel({ question, session, text, model }, body)
}

/** Your answer to Claude's question: the same session goes on and writes the journey. */
export async function answerClarify(reply: string): Promise<LoadedJourney | undefined> {
  const c = clarify
  if (!c || !reply.trim()) return undefined
  clarify = undefined
  c.dispose()
  return writeJourney(c.question, { model: c.model, resume: { session: c.session, reply: reply.trim() } })
}
