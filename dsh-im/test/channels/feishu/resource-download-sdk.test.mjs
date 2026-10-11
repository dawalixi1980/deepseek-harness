import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { Client, defaultHttpInstance, LoggerLevel } from '@larksuiteoapi/node-sdk';

import { extractInboundMessage } from '../../../src/channels/feishu/message-utils.mjs';

const FAKE_TOKEN = 'local-resource-download-test-token';

async function fixture(t, handleRange) {
  const requests = [];
  const sdkResponses = [];
  let streamedInitialError = false;
  const server = createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    if (!request.headers.range) {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.write('{"code":234037,');
      setImmediate(() => response.end('"msg":"Downloaded file size exceeds limit."}'));
      return;
    }
    handleRange(request, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  // The SDK's generated path substitution treats :port as a path parameter.
  // Rewrite this test-only domain at the HTTP boundary before any network I/O.
  const domain = 'http://feishu-resource.test';
  const client = new Client({
    appId: 'local-resource-download-test-app',
    appSecret: 'local-resource-download-test-secret',
    domain,
    loggerLevel: LoggerLevel.fatal,
    logger: { debug() {}, error() {}, info() {}, trace() {}, warn() {} },
    // Use the installed SDK's real Axios adapter and response interceptor. Only
    // bypass ambient proxies, so the fixture never leaves the loopback server.
    httpInstance: {
      async request(config) {
        assert.equal(new URL(config.url).origin, domain);
        try {
          const url = new URL(config.url);
          const result = await defaultHttpInstance.request({
            ...config, url: `${origin}${url.pathname}${url.search}`, proxy: false,
          });
          if (config.$return_headers) {
            assert.equal(Object.hasOwn(result, 'status'), false,
              'the real SDK strips HTTP status before the downloader sees the response');
            assert.equal(typeof result.data[Symbol.asyncIterator], 'function');
            sdkResponses.push(result);
          }
          return result;
        } catch (error) {
          if (!config.headers.Range) {
            assert.equal(error.response.status, 400);
            assert.equal(typeof error.response.data[Symbol.asyncIterator], 'function');
            streamedInitialError = true;
          }
          throw error;
        }
      },
    },
  });
  client.tokenManager.getTenantAccessToken = async () => FAKE_TOKEN;
  return { client, requests, sdkResponses, hasStreamedInitialError: () => streamedInitialError };
}

function source(client, type = 'file') {
  const message = extractInboundMessage({
    message: {
      message_id: 'om_sdk_resource',
      message_type: type,
      content: JSON.stringify(type === 'file'
        ? { file_key: 'file_sdk_resource', file_name: 'sdk.bin' }
        : { image_key: 'img_sdk_resource' }),
    },
  }, client);
  return type === 'file' ? message.files[0] : message.images[0];
}

async function collect(stream, onChunk = () => {}) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
    onChunk(chunk);
  }
  return Buffer.concat(chunks);
}

test('Feishu SDK retries a streamed 234037 response and preserves sequential range bytes', {
  timeout: 5_000,
}, async (t) => {
  const bytes = Buffer.from([0, 255, 128, 10, 13, 42, 99]);
  const local = await fixture(t, (request, response) => {
    const start = Number(/^bytes=(\d+)-\d+$/.exec(request.headers.range)[1]);
    const end = Math.min(start + 2, bytes.length - 1);
    response.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
      'Content-Length': end - start + 1,
    });
    response.end(bytes.subarray(start, end + 1));
  });

  const loaded = await source(local.client).load();
  assert.deepEqual(await collect(loaded.stream), bytes);
  assert.equal(local.hasStreamedInitialError(), true);
  assert.equal(local.sdkResponses.length, 3);
  assert.deepEqual(local.requests.map(({ headers }) => headers.range), [
    undefined, 'bytes=0-8388607', 'bytes=3-6', 'bytes=6-6',
  ]);
  for (const { url, headers } of local.requests) {
    assert.equal(url, '/open-apis/im/v1/messages/om_sdk_resource/resources/file_sdk_resource?type=file');
    assert.equal(headers.authorization, `Bearer ${FAKE_TOKEN}`);
  }
});

test('Feishu SDK accepts an ignored first Range as one full response', {
  timeout: 5_000,
}, async (t) => {
  const local = await fixture(t, (_request, response) => {
    response.writeHead(200, { 'Content-Length': '8' });
    response.end('complete');
  });

  assert.deepEqual(await source(local.client, 'image').load({ maxBytes: 8 }), Buffer.from('complete'));
  assert.equal(local.sdkResponses.length, 1);
  assert.deepEqual(local.requests.map(({ headers }) => headers.range), [undefined, 'bytes=0-7']);
});

test('Feishu SDK cancels a range request before response headers arrive', {
  timeout: 5_000,
}, async (t) => {
  const started = Promise.withResolvers();
  const closed = Promise.withResolvers();
  const local = await fixture(t, (_request, response) => {
    response.on('close', closed.resolve);
    started.resolve();
  });
  const controller = new AbortController();
  const pending = source(local.client, 'image').load({ maxBytes: 8, signal: controller.signal });
  const rejected = assert.rejects(pending, (error) => error.name === 'AbortError');
  await started.promise;
  controller.abort(new DOMException('cancel pending SDK range', 'AbortError'));
  await rejected;
  await closed.promise;
  assert.equal(local.requests.length, 2);
  assert.equal(local.sdkResponses.length, 0);
});

test('Feishu SDK cancels an active range stream and closes its HTTP connection', {
  timeout: 5_000,
}, async (t) => {
  const closed = Promise.withResolvers();
  const local = await fixture(t, (_request, response) => {
    response.on('close', closed.resolve);
    response.writeHead(206, { 'Content-Range': 'bytes 0-3/6', 'Content-Length': '4' });
    response.write('ab');
  });
  const controller = new AbortController();
  const loaded = await source(local.client).load({ signal: controller.signal });
  const pending = collect(loaded.stream, () => {
    controller.abort(new DOMException('cancel active SDK range', 'AbortError'));
  });
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  await closed.promise;
  assert.equal(local.requests.length, 2, 'cancellation must prevent the remaining range');
  assert.equal(local.sdkResponses.length, 1);
  assert.equal(local.sdkResponses[0].data.destroyed, true);
});
