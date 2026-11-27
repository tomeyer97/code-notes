// Tool calls as Claude's stream reports them, for the unit tests that read what the agent is doing from them.

/** A Bash tool call running `command`. */
export const bashCall = (command: string) => ({ name: 'Bash', input: { command } })
