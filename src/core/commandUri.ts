// A `command:` link target, for Markdown that runs one of the extension's commands. Pure, so core can build links too.

/** `command:<id>`, its arguments as JSON in the query. */
export const commandUri = (command: string, ...args: unknown[]) =>
  `command:${command}${args.length ? `?${encodeURIComponent(JSON.stringify(args))}` : ''}`
