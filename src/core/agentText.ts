// Words the extension uses about an agent, the same in every feature: how a prompt names a skill (core/agentRun.ts names
// the model). No vscode API here.

/**
 * How a prompt starts on skill `name` (at `dir`): by name when Claude Code knows it; the copy inside the extension is
 * not installed as a skill, so Claude reads its SKILL.md instead. No closing punctuation: each prompt goes on its own way.
 */
export function skillPreamble(name: string, dir: string, bundled: boolean): string {
  return bundled
    ? `Read ${dir}/SKILL.md and follow it exactly (it is the ${name} skill; it is not installed, so do not look for it with the Skill tool)`
    : `Use the ${name} skill`
}
