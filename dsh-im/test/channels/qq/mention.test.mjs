import assert from 'node:assert/strict';
import test from 'node:test';
import { isQqMessageAddressed, normalizeQqMentions } from '../../../src/channels/qq/qq-mention.mjs';

const openid = 'ABCDEF0123456789ABCDEF0123456789';
const group = (content, fields = {}) => ({ kind: 'group', rawEventType: 'GROUP_MESSAGE_CREATE', content, ...fields });

test('QQ recognizes only explicit self mentions and removes only their markers', () => {
  for (const field of ['id', 'user_openid', 'member_openid']) {
    for (const prefix of ['<@', '<@!']) {
      const raw = group(`${prefix}${openid}> /new <@other>`, {
        mentions: [{ is_you: true, [field]: openid }, { id: 'other', bot: true }],
        raw: { content: `${prefix}${openid}> /new <@other>` },
      });
      const normalized = normalizeQqMentions(raw, new Set(['123']));
      assert.equal(isQqMessageAddressed(normalized), true);
      assert.equal(normalized.content, '/new <@other>');
      assert.equal(normalized.rawEventType, 'GROUP_MESSAGE_CREATE');
      assert.ok(raw.raw.content.startsWith(prefix), 'normalization does not alter the raw payload');
      assert.equal(isQqMessageAddressed(normalizeQqMentions(normalized)), true,
        'a later normalization preserves the decision after stripping');
    }
  }
});

test('QQ content fallback uses exact appId or verified self identity, including before sanitization', () => {
  const ids = new Set(['123']);
  for (const content of ['<@123> /status', '<@!123> /status']) {
    const normalized = normalizeQqMentions(group(content), ids);
    assert.equal(isQqMessageAddressed(normalized), true);
    assert.equal(normalized.content, '/status');
  }
  const sanitized = normalizeQqMentions(group('/status', { raw: { content: '<@123> /status' } }), ids);
  assert.equal(isQqMessageAddressed(sanitized), true);
  normalizeQqMentions(group(`<@${openid}> first`, { mentions: [{ is_you: true, member_openid: openid }] }), ids);
  const learned = normalizeQqMentions(group(`<@!${openid}> 2`), ids);
  assert.equal(isQqMessageAddressed(learned), true);
  assert.equal(learned.content, '2');
  assert.equal(isQqMessageAddressed(normalizeQqMentions(group(`<@${openid}> 2`), new Set(['456']))), false);
});

test('QQ leaves unmentioned messages, other mentions and quoted mentions silent', () => {
  const ids = new Set(['123']);
  for (const message of [
    group('ordinary message'), group('<@1234> /new'), group('<@!other> /new'),
    group(`<@${openid}> /new`, { mentions: [{ id: openid, bot: true }] }),
    group(`<@${openid}> /new`, { mentions: [{ id: openid, is_you: 'true' }] }),
    group('quote', { msgElements: [{ content: '<@123> /new' }], refMsgIdx: 'quoted' }),
    group('@winBot /new'), group('<@all> /new', { mentions: [{ scope: 'all' }] }),
  ]) {
    const originalContent = message.content;
    const normalized = normalizeQqMentions(message, ids);
    assert.equal(isQqMessageAddressed(normalized), false, message.content);
    assert.equal(normalized.content, originalContent);
  }
  assert.deepEqual([...ids], ['123'], 'unknown mentions cannot poison the self identity cache');
});

test('QQ retains dedicated mention events, empty mentions and direct-message behavior', () => {
  assert.equal(isQqMessageAddressed(normalizeQqMentions(group('/status', { rawEventType: 'GROUP_AT_MESSAGE_CREATE' }))), true);
  assert.equal(isQqMessageAddressed(normalizeQqMentions(group('', { mentions: [{ is_you: true }] }))), true);
  const direct = { kind: 'c2c', content: '<@123> text' };
  assert.equal(normalizeQqMentions(direct), direct);
  assert.equal(isQqMessageAddressed(direct), true);
  assert.equal(isQqMessageAddressed(null), false);
  assert.equal(isQqMessageAddressed(normalizeQqMentions(group('', { mentions: {} }))), false);
});
