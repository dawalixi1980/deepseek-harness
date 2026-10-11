import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import * as Lark from '@larksuiteoapi/node-sdk';
import { readExternalHistory } from '../src/channels/feishu/history-reader.mjs';

const identity = { botId: 'fixture-bot', appId: 'fixture-app', botOpenId: 'fixture-open', fingerprint: 'a'.repeat(64) };
const route = { messageId: 'om-anchor', conversationId: 'oc-fixture', actorId: 'ou-fixture' };
const anchor = { message_id: route.messageId, chat_id: route.conversationId, msg_type: 'text',
  sender: { sender_type: 'user', id_type: 'open_id', id: route.actorId },
  create_time: '1790830000000', body: { content: JSON.stringify({ text: 'fixture' }) } };

async function httpFixture(t, stage, providerCode, abort) {
  const seen = [];
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url.includes('/auth/')) {
      response.end(JSON.stringify({ code: 0, tenant_access_token: 'synthetic-fixture-token', expire: 7200 }));
      return;
    }
    const operation = request.url.startsWith('/open-apis/im/v1/messages/om-anchor') ? 'get' : 'list';
    seen.push(operation);
    if (operation === stage) {
      abort?.abort(); response.statusCode = 403;
      response.end(JSON.stringify({ code: providerCode, msg: 'fixture permission failure' }));
    } else response.end(JSON.stringify({ code: 0, data: { items: [anchor], has_more: false } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const localUrl = url => url.replace('https://fixture.invalid', origin);
  const bot = new Lark.Client({ appId: identity.appId, appSecret: 'synthetic-fixture-secret',
    domain: 'https://fixture.invalid',
    httpInstance: { request: config => Lark.defaultHttpInstance.request({ ...config, url: localUrl(config.url), proxy: false }),
      post: (url, data, config) => Lark.defaultHttpInstance.post(localUrl(url), data, { ...config, proxy: false }) },
    logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} } });
  return { bot, seen };
}

for (const stage of ['get', 'list']) {
  for (const providerCode of [230027, 99991672, 99991679]) {
    test(`SDK HTTP ${stage} 403/${providerCode} maps to history-permission-denied`, async t => {
      const { bot, seen } = await httpFixture(t, stage, providerCode);
      let code;
      try { await readExternalHistory(bot, identity, route, { scope: 'group', limit: 1 }); }
      catch (error) { code = error.code; }
      assert.equal(code, 'history-permission-denied');
      assert.deepEqual(seen, stage === 'get' ? ['get'] : ['get', 'list']);
    });
  }
  test(`SDK HTTP ${stage} rejection preserves concurrent cancellation`, async t => {
    const abort = new AbortController();
    const { bot } = await httpFixture(t, stage, 99991672, abort);
    let name;
    try { await readExternalHistory(bot, identity, route, { scope: 'group', limit: 1 }, abort.signal); }
    catch (error) { name = error.name; }
    assert.equal(name, 'AbortError');
  });
}


for (const stage of ['get', 'list']) {
  test(`SDK HTTP ${stage} other provider refusals remain history-unavailable`, async t => {
    const { bot, seen } = await httpFixture(t, stage, 123456);
    let code;
    try { await readExternalHistory(bot, identity, route, { scope: 'group', limit: 1 }); }
    catch (error) { code = error.code; }
    assert.equal(code, 'history-unavailable');
    assert.deepEqual(seen, stage === 'get' ? ['get'] : ['get', 'list']);
  });
}
