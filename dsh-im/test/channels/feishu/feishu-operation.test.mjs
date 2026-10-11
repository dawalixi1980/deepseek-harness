import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import * as lark from '@larksuiteoapi/node-sdk';
import { waitForFeishuOperation } from '../../../src/channels/feishu/feishu-channel.mjs';

test('cancellation before the SDK microtask prevents the request from starting', async () => {
  const controller = new AbortController();
  let calls = 0;
  const waiting = waitForFeishuOperation(() => { calls++; }, {
    signal: controller.signal, timeoutMs: 15_000,
  });
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(calls, 0);
});

for (const firstTimeout of ['SDK wait', 'HTTP request']) {
  test(`the real Feishu SDK recovers from a silent HTTP endpoint via the ${firstTimeout} deadline`, { timeout: 5_000 }, async t => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      if (requests === 1) return; // Keep the first real HTTP request pending.
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 0 }));
    });
    t.after(() => { server.closeAllConnections(); server.close(); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const client = new lark.Client({
      appId: 'synthetic-test-app', appSecret: 'synthetic-test-secret',
      disableTokenCache: true,
      domain: 'https://sdk-test.invalid',
      logger: { info() {}, warn() {}, error() {}, debug() {}, trace() {} },
      httpInstance: {
        ...lark.defaultHttpInstance,
        request: options => lark.defaultHttpInstance.request({
          ...options,
          // The SDK treats a URL's port as a path placeholder. Route its
          // already-formatted request to the loopback server in the adapter.
          url: options.url.replace('https://sdk-test.invalid', `http://127.0.0.1:${server.address().port}`),
          timeout: firstTimeout === 'HTTP request' ? 100 : 1_000,
        }),
      },
    });
    const patch = () => client.im.v1.message.patch({
      path: { message_id: 'synthetic-message' }, data: { content: '{}' },
    }, lark.withTenantToken('synthetic-test-token'));
    await assert.rejects(waitForFeishuOperation(patch, {
      timeoutMs: firstTimeout === 'SDK wait' ? 100 : 1_000,
      stage: 'step card patch',
    }), firstTimeout === 'SDK wait' ? { code: 'provider-timeout' } : { code: 'ECONNABORTED' });
    assert.equal(requests, 1, 'the SDK reached the silent HTTP endpoint');
    assert.deepEqual(await waitForFeishuOperation(patch, { timeoutMs: 1_000 }), { code: 0 });
    assert.equal(requests, 2, 'a subsequent request completes without restarting the client');
  });
}
