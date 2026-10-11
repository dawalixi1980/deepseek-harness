import assert from 'node:assert/strict';
import test from 'node:test';
import { HarnessReplyTracker } from '../src/channels/shared/harness-client.mjs';
import { extractCompletedTurnAnswer } from '../src/channels/shared/deferred-delivery.mjs';

const text = (text) => ({ type: 'text', text });
const message = (step, content) => ({ type: 'assistant/message', data: { turn: 1, step, message: { content } } });
const delta = (step, index, text) => ({ type: 'assistant/chunk', data: { turn: 1, step, chunk: { type: 'text-delta', index, text } } });
const tool = (step = 0) => ({ type: 'tool/call', data: { turn: 1, step, name: 'bash', callId: `call-${step}` } });
const call = { type: 'tool-call', name: 'bash', callId: 'call-0' };
const reasoning = { type: 'reasoning', text: 'PRIVATE_REASONING_MUST_NOT_APPEAR' };

const cases = [
  ['tool preamble and final answer', [message(0, [text('Checking'), call]), tool(), message(1, [reasoning, text('Answer')])], 'Answer'],
  ['tool event before its canonical message', [delta(0, 0, 'Checking'), tool(), message(0, [text('Checking'), call]), message(1, [text('Answer')])], 'Answer'],
  ['canonical tool call without separate tool event', [message(0, [text('Checking'), call]), message(1, [text('Answer')])], 'Answer'],
  ['separate tool event without canonical tool call', [message(0, [text('Checking')]), tool(), message(1, [text('Answer')])], 'Answer'],
  ['multiple tools discard every intermediate step', [message(0, [text('Checking'), call]), tool(), message(1, [text('Verifying'), call]), tool(1), message(2, [text('Answer')])], 'Answer'],
  ['complete final blocks replace draft and keep following paragraphs', [message(0, [text('Checking'), call]), tool(), delta(1, 0, 'Draft'), message(1, [text('First'), reasoning, text('Second')]), message(2, [text('Third')])], 'First\nSecond\n\nThird'],
  ['delta-only final preserves part order', [delta(0, 0, 'Checking'), tool(), delta(1, 1, 'Second'), delta(1, 0, 'First'), delta(1, 0, '!')], 'First!\nSecond'],
  ['tool-only completion does not fall back to preamble', [message(0, [text('Checking'), call]), tool()], ''],
  ['empty canonical clears draft and earlier text', [message(0, [text('Checking')]), delta(1, 0, 'Draft'), message(1, [])], ''],
  ['reasoning-only canonical is not a final answer', [message(0, [text('Checking')]), message(1, [reasoning])], ''],
  ['legacy messages without step replace prior text', [message(undefined, [text('Checking'), call]), tool(undefined), message(undefined, [text('Draft')]), message(undefined, [text('Answer')])], 'Answer'],
  ['ordinary multi-step text remains complete', [message(0, [text('First')]), message(1, [text('Second')])], 'First\n\nSecond'],
];

for (const [name, body, expected] of cases) {
  test(`QQ final answer: ${name} (live and recovered history)`, () => {
    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { turn: 1, source: { rpcId: 'qq-final' } } },
      ...body,
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ].map((e, seq) => ({ ...e, seq }));
    const tracker = new HarnessReplyTracker({ promptRpcId: 'qq-final', finalAnswerOnly: true });
    // Different polls and repeated history must produce the same result.
    for (let i = 0; i < events.length; i += 2) tracker.consumeAll(events.slice(0, i + 2));
    assert.equal(tracker.finalAnswer, expected);
    const restored = extractCompletedTurnAnswer(events.toReversed().map(event => ({ event })), { turn: 1, finalAnswerOnly: true });
    assert.equal(restored.found, Boolean(expected));
    assert.equal(restored.text, expected || null);
    assert.equal(restored.reason, 'completed');
  });
}

test('QQ final selection preserves progress and accumulated partial text, ignoring foreign and late events', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: 'qq-final', finalAnswerOnly: true });
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { turn: 1, source: { rpcId: 'qq-final' } } },
    message(0, [text('Checking'), call]), tool(), message(1, [text('Answer')]),
    { type: 'tool/call', data: { turn: 2, name: 'foreign' } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    tool(),
  ].map((e, seq) => ({ ...e, seq }));
  const updates = tracker.consumeAll(events);
  assert.equal(tracker.answer, 'Checking\n\nAnswer');
  assert.equal(tracker.finalAnswer, 'Answer');
  assert.equal(updates.some(update => update.type === 'text' && update.text === 'Checking\n\nAnswer'), true);
  assert.equal(extractCompletedTurnAnswer(events, { turn: 1 }).text, 'Checking\n\nAnswer');
});
