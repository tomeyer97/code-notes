// A link to a journey's step (HiddenCmd.openStepLink, tour/commands.ts openStepLink): its arguments in one order, so a
// lens, a "See also" and a question's back-link can't disagree. No vscode here.
import { cmdLink, HiddenCmd } from '../platform/commands'

/** A step to open: its journey's id, its own id, its number (when the id is gone) and the workspace folder (uri). */
export interface StepTarget { journey: string; step: string; n: number; folder: string }

/** openStepLink's arguments, in its order: (id, stepId, n, folder). */
export type OpenStepLinkArgs = [journey: string, step: string, n: number, folder: string]

export const openStepLinkArgs = (s: StepTarget): OpenStepLinkArgs => [s.journey, s.step, s.n, s.folder]

/** A Markdown link that opens the step. */
export const stepLink = (label: string, s: StepTarget) => cmdLink(label, HiddenCmd.openStepLink, ...openStepLinkArgs(s))
