// Tool calls as Claude's stream reports them, for the unit tests of the phase readers (checkModel.ts's checkPhase,
// writing.ts's phaseOf).

/** A Bash tool call running `command`. */
export const bashCall = (command: string) => ({ name: 'Bash', input: { command } })
