// Command links in a thread's Markdown that always work: the text may run every command it links to (VS Code drops
// a link to a command the text is not allowed to run). No vscode here: unit-tested.
import { type CommandId, cmdLink, titledCmdLink } from '../platform/commands'

export class Links {
  private readonly used = new Set<string>()

  /** `allowed`: what the text may run anyway (a message may hold links its writer made). */
  constructor(private readonly allowed: readonly string[]) {}

  /** A link that runs `command` with `args`. */
  to(label: string, command: CommandId, ...args: unknown[]): string {
    this.used.add(command)
    return cmdLink(label, command, ...args)
  }

  /** The same with a tooltip. */
  titled(label: string, title: string, command: CommandId, ...args: unknown[]): string {
    this.used.add(command)
    return titledCmdLink(label, title, command, ...args)
  }

  /** The commands the text may run: the allowed ones, then each one linked to. */
  get commands(): string[] {
    return [...new Set([...this.allowed, ...this.used])]
  }
}
