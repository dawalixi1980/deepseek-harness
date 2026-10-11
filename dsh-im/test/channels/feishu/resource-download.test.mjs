import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { extractInboundMessage } from '../../../src/channels/feishu/message-utils.mjs';
import { stageInboundFiles } from '../../../src/channels/shared/inbound-file.mjs';

const RANGE_BYTES = 8 * 1024 * 1024;

function providerError(code, streamed = false) {
  const error = new Error('Request failed with status code 400');
  error.response = {
    status: 400,
    data: streamed
      ? Readable.from([Buffer.from(`{"code":${code},"msg":"resource unavailable"}`)])
      : { code },
  };
  return error;
}

function response(body, headers = {}, status = 206) {
  return {
    status,
    headers,
    data: body instanceof Readable ? body : Readable.from([Buffer.from(body)]),
  };
}

function ranged(body, range, headers = {}) {
  return response(body, { 'content-range': range, ...headers });
}

// The SDK returns { data, headers } and delegates status acceptance to Axios's
// validateStatus callback. Do not add a status field the real SDK omits.
function mockClient(responses, initialError = providerError(234037)) {
  const gets = [];
  const requests = [];
  const streams = [];
  const client = {
    im: { v1: { messageResource: { async get(request) {
      gets.push(request);
      throw initialError;
    } } } },
    async request(request) {
      requests.push(request);
      const next = responses[requests.length - 1];
      assert.ok(next, 'download must not issue an extra range request');
      const result = typeof next === 'function' ? await next(request) : next;
      streams.push(result.data);
      assert.equal(typeof request.validateStatus, 'function');
      if (!request.validateStatus(result.status)) {
        const error = new Error(`Request failed with status code ${result.status}`);
        error.response = result;
        throw error;
      }
      return { data: result.data, headers: result.headers };
    },
  };
  return { client, gets, requests, streams };
}

function message(client, type = 'image') {
  return extractInboundMessage({
    message: {
      message_id: 'om resource/id',
      message_type: type,
      content: JSON.stringify(type === 'image'
        ? { image_key: 'img key/part' }
        : { file_key: 'file key/part', file_name: 'report.bin' }),
    },
  }, client);
}

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-feishu-range-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function readFileSource(source, options = {}) {
  const loaded = await source.load(options);
  assert.equal(Buffer.isBuffer(loaded), false, 'files must stay streamed to the staging writer');
  assert.equal(typeof loaded?.stream?.[Symbol.asyncIterator], 'function');
  const chunks = [];
  for await (const chunk of loaded.stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test('Feishu retries 234037 with sequential ranges and preserves every binary byte', async () => {
  const bytes = Buffer.from([0x00, 0xff, 0x80, 0x01, 0x0a, 0x0d, 0xde]);
  const mock = mockClient([
    ranged(bytes.subarray(0, 2), 'bytes 0-1/7', { 'content-length': '2' }),
    ranged(bytes.subarray(2, 5), 'bytes 2-4/7'),
    ranged(bytes.subarray(5), 'bytes 5-6/7', { 'content-length': '2' }),
  ]);
  const controller = new AbortController();
  const source = message(mock.client).images[0];
  assert.equal(mock.gets.length, 0, 'download stays lazy until load');

  assert.deepEqual(await source.load({ signal: controller.signal, maxBytes: 10 }), bytes);
  assert.equal(mock.gets.length, 1);
  assert.deepEqual(mock.requests.map((request) => request.headers.Range), [
    'bytes=0-9', 'bytes=2-6', 'bytes=5-6',
  ]);
  for (const request of mock.requests) {
    assert.equal(request.url, 'open-apis/im/v1/messages/om%20resource%2Fid/resources/img%20key%2Fpart');
    assert.equal(request.method, 'GET');
    assert.deepEqual(request.params, { type: 'image' });
    assert.equal(request.responseType, 'stream');
    assert.equal(request.$return_headers, true);
    assert.equal(request.signal, controller.signal);
  }
});

test('Feishu recognizes 234037 in a streamed SDK error body and bounds the initial range', async () => {
  const mock = mockClient([ranged('ok', 'bytes 0-1/2')], providerError(234037, true));
  assert.deepEqual(await message(mock.client).images[0].load({ maxBytes: RANGE_BYTES + 1 }), Buffer.from('ok'));
  assert.equal(mock.requests[0].headers.Range, `bytes=0-${RANGE_BYTES - 1}`);
});

test('Feishu ordinary file ranges stream directly into inbound staging', async (t) => {
  const root = await workspace(t);
  const mock = mockClient([
    ranged('first', 'bytes 0-4/9'),
    ranged('last', 'bytes 5-8/9'),
  ]);
  const inbound = message(mock.client, 'file');
  const originalLoad = inbound.files[0].load;
  inbound.files[0].load = async (options) => {
    const loaded = await originalLoad(options);
    assert.equal(Buffer.isBuffer(loaded), false);
    assert.equal(typeof loaded?.stream?.[Symbol.asyncIterator], 'function');
    return loaded;
  };
  const staged = await stageInboundFiles(inbound, { workspace: root });

  assert.deepEqual(await readFile(join(root, staged.files[0].path)), Buffer.from('firstlast'));
  assert.deepEqual(mock.requests.map((request) => request.headers.Range), [
    `bytes=0-${RANGE_BYTES - 1}`, 'bytes=5-8',
  ]);
  assert.ok(mock.requests.every((request) => request.params.type === 'file'));
  assert.equal(mock.requests[0].url, 'open-apis/im/v1/messages/om%20resource%2Fid/resources/file%20key%2Fpart');
  await staged.cleanup();
  assert.deepEqual(await readdir(join(root, '.dsh-im', 'inbound')), []);
});

test('Feishu accepts a complete 200 response only on the first range request', async (t) => {
  for (const type of ['image', 'file']) {
    await t.test(type, async () => {
      const mock = mockClient([response('whole body', { 'content-length': '10' }, 200)]);
      const inbound = message(mock.client, type);
      const bytes = type === 'image'
        ? await inbound.images[0].load({ maxBytes: 10 })
        : await readFileSource(inbound.files[0]);
      assert.deepEqual(bytes, Buffer.from('whole body'));
      assert.equal(mock.requests.length, 1, 'an ignored Range response must not be appended repeatedly');
    });
  }
});

test('Feishu rejects incomplete, inconsistent, or reordered range responses', async (t) => {
  const cases = [
    ['missing Content-Range', [response('ab')]],
    ['malformed Content-Range', [ranged('ab', 'not a range')]],
    ['unknown total', [ranged('ab', 'bytes 0-1/*')]],
    ['non-byte range', [ranged('ab', 'items 0-1/2')]],
    ['unexpected first offset', [ranged('ab', 'bytes 1-2/3')]],
    ['end before start', [ranged('ab', 'bytes 0--1/2')]],
    ['end beyond total', [ranged('ab', 'bytes 0-2/2')]],
    ['unsafe total', [ranged('ab', 'bytes 0-1/9007199254740992')]],
    ['response exceeds requested range', [ranged('ab', `bytes 0-${RANGE_BYTES}/${RANGE_BYTES + 1}`)]],
    ['truncated range body', [ranged('abc', 'bytes 0-3/4')]],
    ['overflowing range body', [ranged('abcde', 'bytes 0-3/4')]],
    ['conflicting Content-Length', [ranged('abcd', 'bytes 0-3/4', { 'content-length': '3' })]],
    ['changed total', [ranged('ab', 'bytes 0-1/4'), ranged('cd', 'bytes 2-3/5')]],
    ['overlapping second range', [ranged('ab', 'bytes 0-1/4'), ranged('bc', 'bytes 1-2/4')]],
    ['gap before second range', [ranged('ab', 'bytes 0-1/4'), ranged('d', 'bytes 3-3/4')]],
    ['200 after a partial response', [ranged('ab', 'bytes 0-1/4'), response('abcd', {}, 200)]],
    ['truncated full response', [response('abc', { 'content-length': '4' }, 200)]],
    ['overflowing full response', [response('abcde', { 'content-length': '4' }, 200)]],
  ];
  for (const [name, responses] of cases) {
    await t.test(name, async () => {
      const mock = mockClient(responses);
      await assert.rejects(readFileSource(message(mock.client, 'file').files[0]), /range|length|bytes|resource|download/i);
      assert.equal(mock.requests.length, responses.length);
      assert.ok(mock.streams.every((stream) => stream.destroyed), 'invalid responses must release their streams');
    });
  }
});

test('Feishu range fallback preserves configured image limits for totals and full response bodies', async (t) => {
  for (const [name, result] of [
    ['Content-Range total', ranged('ab', 'bytes 0-1/9')],
    ['200 declared size', response('123456789', { 'content-length': '9' }, 200)],
    ['200 streamed size without Content-Length', response('123456789', {}, 200)],
  ]) {
    await t.test(name, async () => {
      const mock = mockClient([result]);
      await assert.rejects(message(mock.client).images[0].load({ maxBytes: 8 }), (error) => {
        assert.equal(error.code, 'image-too-large');
        return true;
      });
      assert.equal(mock.requests[0].headers.Range, 'bytes=0-7');
      assert.equal(mock.requests.length, 1);
      assert.equal(result.data.destroyed, true);
    });
  }
});

test('Feishu does not retry unrelated provider failures', async (t) => {
  for (const streamed of [false, true]) {
    await t.test(streamed ? 'streamed body' : 'object body', async () => {
      const error = providerError(99991400, streamed);
      const mock = mockClient([], error);
      await assert.rejects(message(mock.client).images[0].load({ maxBytes: 8 }), (actual) => actual === error);
      assert.equal(mock.requests.length, 0);
    });
  }
});

test('Feishu retains actionable permission errors from the range request', async () => {
  const permissionBody = Readable.from([Buffer.from('{"code":99991672}')]);
  const mock = mockClient([response(permissionBody, {}, 400)]);
  await assert.rejects(message(mock.client).images[0].load({ maxBytes: 8 }), (error) => {
    assert.equal(error.code, 'feishu-image-permission-required');
    assert.match(error.userMessage, /im:message:readonly/);
    assert.match(error.userMessage, /\/repair/);
    return true;
  });
  assert.equal(mock.requests.length, 1);
  assert.equal(permissionBody.destroyed, true);
});

test('Feishu destroys ordinary file range error streams and preserves the HTTP failure', async () => {
  let reads = 0;
  const errorBody = new Readable({ read() { reads += 1; } });
  const mock = mockClient([response(errorBody, {}, 503)]);
  await assert.rejects(readFileSource(message(mock.client, 'file').files[0]), (error) => {
    assert.equal(error.response.status, 503);
    assert.equal(error.response.data, errorBody);
    return true;
  });
  assert.equal(errorBody.destroyed, true);
  assert.equal(reads, 0, 'ordinary file failures do not need to buffer an HTTP error body');
  assert.equal(mock.requests.length, 1);
});

test('Feishu aborts an active image range stream without downloading the next range', { timeout: 10_000 }, async () => {
  const controller = new AbortController();
  const reason = new DOMException('cancel image download', 'AbortError');
  let started = false;
  const stream = new Readable({
    read() {
      if (started) return;
      started = true;
      this.push(Buffer.from('a'));
      setImmediate(() => controller.abort(reason));
    },
  });
  const mock = mockClient([ranged(stream, 'bytes 0-1/4')]);
  await assert.rejects(message(mock.client).images[0].load({ maxBytes: 8, signal: controller.signal }),
    (error) => error.name === 'AbortError');
  assert.equal(stream.destroyed, true);
  assert.equal(mock.requests.length, 1);
});

test('Feishu releases a range response arriving after cancellation', async () => {
  const controller = new AbortController();
  const stream = Readable.from([Buffer.from('ab')]);
  const mock = mockClient([() => {
    controller.abort(new DOMException('cancel pending request', 'AbortError'));
    return ranged(stream, 'bytes 0-1/2');
  }]);
  await assert.rejects(message(mock.client).images[0].load({ maxBytes: 8, signal: controller.signal }),
    (error) => error.name === 'AbortError');
  assert.equal(stream.destroyed, true);
  assert.equal(mock.requests.length, 1);
});

test('Feishu cancellation closes an ordinary file response before consumption', async () => {
  const controller = new AbortController();
  let reads = 0;
  const stream = new Readable({ read() { reads += 1; } });
  const client = { im: { v1: { messageResource: { async get() {
    return { getReadableStream: () => stream };
  } } } } };
  const loaded = await message(client, 'file').files[0].load({ signal: controller.signal });
  assert.equal(typeof loaded?.stream?.[Symbol.asyncIterator], 'function');
  assert.equal(reads, 0, 'loading a file must not eagerly buffer its response');
  controller.abort(new DOMException('cancel before staging', 'AbortError'));
  assert.equal(stream.destroyed, true);
  await assert.rejects(async () => {
    for await (const _chunk of loaded.stream) assert.fail('cancelled bytes must not be delivered');
  }, (error) => error.name === 'AbortError');
});

test('Feishu releases an ordinary response arriving after cancellation', async () => {
  const controller = new AbortController();
  const stream = Readable.from([Buffer.from('ordinary file')]);
  const client = { im: { v1: { messageResource: { async get() {
    controller.abort(new DOMException('cancel pending SDK request', 'AbortError'));
    return { getReadableStream: () => stream };
  } } } } };
  await assert.rejects(message(client, 'file').files[0].load({ signal: controller.signal }),
    (error) => error.name === 'AbortError');
  assert.equal(stream.destroyed, true);
});

test('Feishu cancellation removes partially staged file ranges', { timeout: 10_000 }, async (t) => {
  const root = await workspace(t);
  const controller = new AbortController();
  let started = false;
  const stream = new Readable({
    read() {
      if (started) return;
      started = true;
      this.push(Buffer.from('c'));
      setImmediate(() => controller.abort(new DOMException('cancel file download', 'AbortError')));
    },
  });
  const mock = mockClient([ranged('ab', 'bytes 0-1/4'), ranged(stream, 'bytes 2-3/4')]);
  await assert.rejects(stageInboundFiles(message(mock.client, 'file'), {
    workspace: root,
    signal: controller.signal,
  }), (error) => error.name === 'AbortError');
  assert.equal(mock.requests.length, 2);
  assert.equal(stream.destroyed, true);
  assert.deepEqual(await readdir(join(root, '.dsh-im', 'inbound')), []);
});

test('Feishu length failures remove the whole staged batch, including earlier complete files', async (t) => {
  const root = await workspace(t);
  const mock = mockClient([ranged('ab', 'bytes 0-1/4'), ranged('c', 'bytes 2-3/4')]);
  const inbound = message(mock.client, 'file');
  inbound.files.unshift({ name: 'earlier.txt', data: Buffer.from('remove me too') });
  await assert.rejects(stageInboundFiles(inbound, { workspace: root }), (error) => {
    assert.equal(error.code, 'inbound-file-download-failed');
    assert.match(error.cause.message, /range|length|bytes/i);
    return true;
  });
  assert.equal(mock.requests.length, 2);
  assert.deepEqual(await readdir(join(root, '.dsh-im', 'inbound')), []);
});
