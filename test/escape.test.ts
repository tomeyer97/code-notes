import { test } from 'node:test'
import assert from 'node:assert/strict'
import { escapeHtml, escapeMarkdown } from '../src/core/escape'

test('escapeHtml: text and attribute values', () => {
  assert.equal(escapeHtml('a < b && "c" > d'), 'a &lt; b &amp;&amp; &quot;c&quot; &gt; d')
  assert.equal(escapeHtml("it's"), "it's")
})

test('escapeMarkdown: every character Markdown reads gets a backslash', () => {
  assert.equal(escapeMarkdown('a_b *c* [d](e) `f` <g> \\'), 'a\\_b \\*c\\* \\[d\\](e) \\`f\\` \\<g\\> \\\\')
})
