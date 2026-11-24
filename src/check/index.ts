// The understanding check: questions about this branch's change, answered in their threads (controller.ts runs it;
// wiring.ts is its side of the notes, the tour and the code links). Its view and status item are there from the
// start; its git work starts with `start`.
import * as vscode from 'vscode'
import { STEP_PRIORITY, Steppers } from '../platform/chordKey'
import { Cmd, HiddenCmd } from '../platform/commands'
import { registerCommands } from '../platform/registerCommands'
import { hideNotes } from '../notes/visible'
import { handleAsks } from '../ask/handlers'
import { CheckController } from './controller'
import { CheckPorts, useCheckPorts } from './ports'
import { answerCheck, backToQuestion, checkAskHandler, checkConcern, checkHost, checkLinkNote, checkStepping, gradeCheck } from './wiring'

export interface CheckFeature {
  controller: CheckController
  /** A code link key of a check thread: its note and links; the way back to the question. */
  links: { noteOf: typeof checkLinkNote; backToQuestion: typeof backToQuestion }
  /** The check's git work, watchers and first refresh (once everything else is shown). */
  start(): Promise<void>
}

export function activateCheck(context: vscode.ExtensionContext, ports: CheckPorts, steppers: Steppers): CheckFeature {
  const controller = new CheckController(checkHost(context.extensionUri, ports))
  useCheckPorts({ ...ports, controller })
  context.subscriptions.push(
    controller,
    // Another branch's questions are not listed (their lines belong to that branch).
    hideNotes((n) => controller.offBranch(n)),
    // Ask Claude on a check question asks about its code instead.
    handleAsks(checkAskHandler(controller)),
    // D / A outside a walk, while the check has open questions.
    steppers.register(STEP_PRIORITY.check, { step: (dir) => checkStepping() && controller.step(dir) }),
  )
  registerCommands(context, {
    [Cmd.checkUnderstanding]: () => controller.run(),
    [HiddenCmd.nextCheckQuestion]: () => controller.step(1),
    [Cmd.answerCheck]: answerCheck,
    [Cmd.checkConcern]: checkConcern,
    [Cmd.gradeCheck]: gradeCheck,
  })
  return { controller, links: { noteOf: checkLinkNote, backToQuestion }, start: () => controller.init() }
}
