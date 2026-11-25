// What lights code beside the text that names it: a step's code links and value hints, an animation's beats, the
// lines Claude's chat names; and a code link's click with its way back.
import * as vscode from 'vscode'
import { cfg } from '../platform/settings'
import { HiddenCmd } from '../platform/commands'
import { log } from '../platform/host'
import { registerCommands } from '../platform/registerCommands'
import { Beats } from './beats'
import { ClaudeLinks } from './claudeChatLinks'
import { codeLinkBack, openCodeLink } from './codeLinkClick'
import { CodeLinks } from './codeLinks'
import { registerLinkLenses } from './lenses'
import { CodeLinkPorts, useCodeLinkPorts } from './ports'
import { ValueHints } from './valueHints'

export interface CodeLinksFeature {
  beats: Beats
  codeLinks: CodeLinks
  claudeLinks: ClaudeLinks
  valueHints: ValueHints
}

export function activateCodeLinks(context: vscode.ExtensionContext, ports: Omit<CodeLinkPorts, 'codeLinks'>): CodeLinksFeature {
  const beats = new Beats(log())
  const codeLinks = new CodeLinks(log())
  const claudeLinks = new ClaudeLinks(log(), () => cfg().get<boolean>('claudeLinks', true))
  const valueHints = new ValueHints(log())
  useCodeLinkPorts({ ...ports, codeLinks })
  context.subscriptions.push(claudeLinks, beats, codeLinks, valueHints, registerLinkLenses({ codeLinks, claudeLinks, valueHints }))
  registerCommands(context, {
    [HiddenCmd.codeLink]: openCodeLink,
    [HiddenCmd.codeLinkBack]: codeLinkBack,
    [HiddenCmd.claudeLinkBack]: () => claudeLinks.goBack(),
  })
  return { beats, codeLinks, claudeLinks, valueHints }
}
