// A writer's run of Claude (src/core/agentRun.ts): the model's name, the progress line, the phase from a tool call.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_MODEL_NAME, modelLabel, phaseFromTool, runProgress, type PhaseTable } from '../src/core/agentRun'
import { bashCall } from './toolCalls'

test('modelLabel: the model set, else Claude Code\'s default, one name for the logs, the UI and the scripts', () => {
  assert.equal(modelLabel('opus'), 'opus')
  assert.equal(modelLabel(undefined), DEFAULT_MODEL_NAME)
  assert.equal(modelLabel(''), 'Claude Code default')
})

test('runProgress: the clock since the start, then the phase', () => {
  assert.equal(runProgress({ started: 1000, phase: 'reading the code' }, 66_000), '1:05 · reading the code')
})

test('phaseFromTool: read tools, Bash commands and other tools through one table', () => {
  const table: PhaseTable = {
    readTools: ['Read'],
    onRead: (prev) => (prev === 'writing' ? prev : 'reading'),
    onCommand: (cmd, prev) => (/script go/.test(cmd) ? 'writing' : /script peek/.test(cmd) && prev === 'starting' ? 'reading' : undefined),
  }
  assert.equal(phaseFromTool(undefined, 'starting', table), 'starting')
  assert.equal(phaseFromTool({ name: 'Read', input: {} }, 'starting', table), 'reading')
  assert.equal(phaseFromTool({ name: 'Read', input: {} }, 'writing', table), 'writing')
  assert.equal(phaseFromTool({ name: 'Edit', input: {} }, 'reading', table), 'reading', 'another tool: the phase goes on')
  assert.equal(phaseFromTool(bashCall('script go'), 'reading', table), 'writing')
  assert.equal(phaseFromTool(bashCall('script peek'), 'starting', table), 'reading')
  assert.equal(phaseFromTool(bashCall('git diff'), 'writing', table), 'writing', 'a command the table does not know')
  assert.equal(phaseFromTool({ name: 'Bash' }, 'writing', table), 'writing', 'no input')
})
