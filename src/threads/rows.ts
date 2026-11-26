// What a feature adds to a note's thread (Claude answering, the check's grading, a step question's link back), and
// the rows themselves: comments.ts renders a thread from these without knowing the features.
import * as vscode from 'vscode'
import { HiddenCmd, shortLinks, SYSTEM_COMMANDS } from '../platform/commands'
import type { Note } from '../notes/store'
import { COMMENT_CONTEXT, type ThreadWord } from './context'
import { Links } from './links'
import type { CodeLinkRef } from './text'

/** A row of a thread and what decides whether it changed (default: everything it shows). */
export interface ThreadRow {
  comment: vscode.Comment
  /** Set when part of what it shows is redrawn only with something else (Claude's elapsed seconds). */
  key?: string
}

/** What a feature says about a note's thread. */
export interface ThreadFacts {
  /** At work on the note (always shown, whatever the filters). */
  working?: boolean
  /** Its work failed: the thread says so (always shown). */
  failed?: boolean
  /** Listed like an open note (the check keeps a graded question in view). */
  pinned?: boolean
  /** Words for the thread's contextValue (the menus test them). */
  words?: ThreadWord[]
  /** Never shown resolved (VS Code collapses a resolved thread). */
  neverResolved?: boolean
}

/** How one message shows. */
export interface MessageShape {
  /** Shown as typed: its Markdown and HTML never render. */
  verbatim?: boolean
  /** Phrases that link to code (the check's question and grades). */
  codeLinks?: readonly CodeLinkRef[]
  /** The message's last line made into something else (a step question's "About the step …" line). */
  lastLine?: (body: string, links: Links) => { body: string; suffix: string } | undefined
  /** A link under the message ("Next question ›"). */
  after?: (links: Links) => string
}

export interface ThreadContribution {
  facts?(n: Note): ThreadFacts | undefined
  message?(n: Note, index: number): MessageShape | undefined
  /** Rows after the messages. */
  rows?(n: Note): ThreadRow[]
}

/** The features' contributions, in the order their rows are shown. */
export class ThreadContributions {
  private readonly list: ThreadContribution[] = []

  add(c: ThreadContribution): vscode.Disposable {
    this.list.push(c)
    return new vscode.Disposable(() => {
      const i = this.list.indexOf(c)
      if (i >= 0) this.list.splice(i, 1)
    })
  }

  facts(n: Note): Required<Omit<ThreadFacts, 'words'>> & { words: ThreadWord[] } {
    const all = this.list.map((c) => c.facts?.(n) ?? {})
    return {
      working: all.some((f) => !!f.working),
      failed: all.some((f) => !!f.failed),
      pinned: all.some((f) => !!f.pinned),
      words: all.flatMap((f) => f.words ?? []),
      neverResolved: all.some((f) => !!f.neverResolved),
    }
  }

  message(n: Note, index: number): MessageShape[] {
    return this.list.map((c) => c.message?.(n, index)).filter((s): s is MessageShape => !!s)
  }

  rows(n: Note): ThreadRow[] {
    return this.list.flatMap((c) => c.rows?.(n) ?? [])
  }
}

/** Markdown that may run what `links` says (nothing to run: untrusted). Links with arguments get a short key: a
 *  comment's Markdown is what a screen reader reads. */
export function linkedMarkdown(text: string, links: Links): vscode.MarkdownString {
  const commands = links.commands
  const md = new vscode.MarkdownString(commands.length ? shortLinks(text, commands) : text)
  if (commands.length) md.isTrusted = { enabledCommands: [...commands, HiddenCmd.link] }
  return md
}

/** A row the extension writes (not a message), by `author`; `text` may run the extension's own commands. */
export function systemRow(text: string | ((links: Links) => string), author: string, label?: string): vscode.Comment {
  const links = new Links(SYSTEM_COMMANDS)
  const body = linkedMarkdown(typeof text === 'string' ? text : text(links), links)
  return { body, mode: vscode.CommentMode.Preview, author: { name: author }, ...(label ? { label } : {}), contextValue: COMMENT_CONTEXT.system }
}

/** What a comment shows, as one string (a thread is redrawn only when this changes). */
export function shownKey(c: vscode.Comment): string {
  const b = c.body
  const body = typeof b === 'string' ? b : [b.value, b.isTrusted, b.supportHtml, b.baseUri?.toString()]
  return JSON.stringify([body, c.author.name, c.label, c.timestamp?.getTime(), c.contextValue, c.mode])
}
