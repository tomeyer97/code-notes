// The lines a fake `claude -p --output-format stream-json` prints: the few event shapes src/platform/agent/stream.ts
// reads, written in one place for every fake (test/fixtures/claude-stream.jsonl is a real transcript of them).
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n')

module.exports = {
  /** The session starts. */
  init: () => say({ type: 'system', subtype: 'init' }),
  /** A finished tool call. */
  toolUse: (name, input) => say({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } }),
  /** More of the answer's text. */
  textDelta: (text) => say({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }),
  /** The run's end: its answer (or error), session and cost. */
  result: (text, o = {}) => say({
    type: 'result',
    result: text,
    ...(o.session ? { session_id: o.session } : {}),
    ...(o.cost !== undefined ? { total_cost_usd: o.cost } : {}),
    is_error: !!o.error,
  }),
}
