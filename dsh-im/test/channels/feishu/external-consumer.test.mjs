import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeExternalText, ExclusiveInboundConsumers } from '../../../src/channels/feishu/external-consumer.mjs';

const fingerprint = 'a'.repeat(64);
function event() {
  return {
    event_id: 'event-1', app_id: 'app',
    sender: { sender_type: 'user', sender_id: { open_id: 'actor' } },
    message: { message_id: 'message', chat_id: 'conversation', chat_type: 'group',
      message_type: 'text', content: JSON.stringify({ text: '@_user_1 hello' }),
      mentions: [{ id: { open_id: 'bot-open-id' }, key: '@_user_1', name: 'Platform Bot' }],
      create_time: '1790787600000', thread_id: 'thread', root_id: 'root', parent_id: 'parent' },
  };
}
function normalized(value = event()) {
  return normalizeExternalText(value, { botId: 'bot', appId: 'app', botOpenId: 'bot-open-id', fingerprint });
}

test('normalized authenticated text retains causal identities without raw payload or secrets', () => {
  const input = event();
  input.secret = 'private-material';
  const evidence = normalized(input);
  assert.deepEqual(evidence.reply, { messageId: 'message', conversationId: 'conversation', actorId: 'actor',
    threadId: 'thread', rootId: 'root', parentId: 'parent' });
  assert.equal(evidence.replay.gapPossible, true);
  assert.equal(Object.isFrozen(evidence.reply), true);
  assert.equal(JSON.stringify(evidence).includes('private-material'), false);
  input.message.chat_id = 'other';
  assert.equal(evidence.conversation.id, 'conversation');
  assert.throws(() => normalized({ ...input, app_id: 'other' }), { code: 'account-changed' });
  assert.equal(normalized({ ...input, sender: { sender_type: 'bot' } }), null);
  assert.equal(evidence.conversation.kind, 'group');
  assert.equal(evidence.mentionedAccount, true);
  assert.deepEqual(evidence.mentions, [{ id: 'bot-open-id', key: '@_user_1', name: 'Platform Bot' }]);
  assert.equal(Object.isFrozen(evidence.mentions[0]), true);
  assert.equal(normalized({ ...input, message: { ...input.message, chat_type: 'unknown' } }), null);
});

test('exclusive registration waits for durable acceptance and disposal never substitutes another consumer', async () => {
  const consumers = new ExclusiveInboundConsumers();
  let commit;
  const committed = new Promise(resolve => { commit = resolve; });
  let calls = 0;
  const dispose = consumers.register('bot', { fingerprint, onEvent: async () => {
    calls++; await committed; return { accepted: true };
  } });
  assert.throws(() => consumers.register('bot', { fingerprint, onEvent() {} }), { code: 'consumer-conflict' });
  let acknowledged = false;
  const pending = consumers.accept('bot', normalized()).then(() => { acknowledged = true; });
  await Promise.resolve();
  assert.equal(acknowledged, false);
  commit(); await pending;
  assert.equal(calls, 1);
  dispose(); dispose();
  await assert.rejects(consumers.accept('bot', normalized()), { code: 'consumer-unavailable' });
});

test('consumer loss during commit rejects acknowledgement even when a new registration appears', async () => {
  const consumers = new ExclusiveInboundConsumers();
  let commit;
  const committed = new Promise(resolve => { commit = resolve; });
  const dispose = consumers.register('bot', { fingerprint, onEvent: async () => {
    await committed; return { accepted: true };
  } });
  const pending = consumers.accept('bot', normalized());
  dispose();
  consumers.register('bot', { fingerprint, onEvent: async () => ({ accepted: true }) });
  commit();
  await assert.rejects(pending, { code: 'consumer-unavailable' });
  consumers.close();
});

test('fingerprint mismatch, uncommitted result and canceled registrations fail closed', async () => {
  const consumers = new ExclusiveInboundConsumers();
  const controller = new AbortController();
  let calls = 0;
  consumers.register('bot', { fingerprint, signal: controller.signal, onEvent: async () => {
    calls++; return { accepted: false };
  } });
  await assert.rejects(consumers.accept('bot', { ...normalized(), fingerprint: 'b'.repeat(64) }), { code: 'account-changed' });
  assert.equal(calls, 0);
  await assert.rejects(consumers.accept('bot', normalized()), { code: 'ingress-not-accepted' });
  controller.abort();
  await assert.rejects(consumers.accept('bot', normalized()), { code: 'consumer-unavailable' });
});


test('ordinary group text and another Bot mention retain context without implying attention for this account', () => {
  const input = event();
  input.message.mentions = [{ id: { open_id: 'other-bot' }, key: '@_user_2' }];
  const otherMention = normalized(input);
  assert.equal(otherMention.mentionedAccount, false);
  assert.deepEqual(otherMention.mentions, [{ id: 'other-bot', key: '@_user_2' }]);
  input.message.mentions = [];
  input.message.content = JSON.stringify({ text: 'ordinary team context' });
  assert.equal(normalized(input).mentionedAccount, false);
  assert.equal(normalized(input).text, 'ordinary team context');
  input.message.chat_type = 'p2p';
  assert.equal(normalized(input).conversation.kind, 'dm');
});

test('group evidence requires authenticated account identity and valid mention and timestamp fields', () => {
  assert.throws(() => normalizeExternalText(event(), { botId: 'bot', appId: 'app', fingerprint }), { code: 'account-unverified' });
  const input = event();
  input.message.mentions = [{ id: { open_id: 'bot-open-id' }, key: '' }];
  assert.throws(() => normalized(input), { code: 'invalid-inbound' });
  input.message.mentions = [];
  input.message.create_time = '9e99';
  assert.throws(() => normalized(input), { code: 'invalid-inbound' });
});
