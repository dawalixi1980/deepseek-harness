import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HarnessClient, HarnessHealthError } from '../../../src/channels/shared/harness-client.mjs';
import { extractConnectionEvidence } from '../../../src/channels/shared/connection-error.mjs';
import { normalizeDiagnosticDetails } from '../../../src/channels/shared/diagnostic-details.mjs';
import { classifyMessageFailure, messageFailureDiagnostic, publicMessageFailure } from '../../../src/channels/shared/message-failure.mjs';
import { normalizeLastMessageError } from '../../../plugin-src/client/last-message-error.js';
import { LastMessageErrorSummary } from '../../../plugin-src/client/channel-card-meta.js';
import { formatConnectionDiagnostic } from '../../../plugin-src/client/connection-error.js';

for (const transport of ['host-api', 'http']) {
  test(`${transport}: RPC diagnostics survive health wrapping, public projection, rendering, copy and logging`, async t => {
    let clock = 100;
    t.mock.method(performance, 'now', () => clock);
    const reject = ({ rpcId }) => {
      clock += 125.4;
      return { rpcId, result: { ok: false, error: { code: 'internal', message: 'private-token', details: {
        method: 'session.prompt', transport: 'private-transport', durationMs: 99, timeoutMs: 999,
        payload: 'private-payload', url: 'https://private.example',
      } } } };
    };
    const client = new HarnessClient(transport === 'host-api'
      ? { apiProxy: { host: { describe: reject } } }
      : { baseUrl: 'http://localhost:1234', fetchImpl: async (_url, options) => ({
        ok: true, json: async () => ({ type: 'server-response', ...reject(JSON.parse(options.body)) }),
      }) });
    await assert.rejects(client.health(), error => {
      assert.ok(error instanceof HarnessHealthError);
      const expected = { reason: 'unknown', method: 'host.describe', transport, durationMs: 125, timeoutMs: 5000 };
      assert.deepEqual(extractConnectionEvidence(error).details, expected);
      const failure = classifyMessageFailure(error, { referenceId: 'MF-12AB34CD' });
      assert.equal(failure.code, 'HARNESS_SERVICE');
      const displayed = normalizeLastMessageError(publicMessageFailure(failure));
      assert.deepEqual(displayed.details, { ...expected, referenceId: 'MF-12AB34CD' });
      const logged = messageFailureDiagnostic(error, failure);
      assert.deepEqual(logged.details, expected);
      const copied = formatConnectionDiagnostic(displayed);
      for (const [field, value] of Object.entries(expected)) assert.ok(copied.includes(`${field}: ${value}`));
      const markup = renderToStaticMarkup(React.createElement(LastMessageErrorSummary, { error: displayed }));
      for (const text of ['RPC 方法', 'host.describe', '调用方式', transport === 'host-api' ? '宿主 API（进程内）' : 'HTTP', '125', '5000']) {
        assert.ok(markup.includes(text), text);
      }
      assert.doesNotMatch(JSON.stringify([displayed, logged, copied, markup]), /private-/);
      return true;
    });
  });
}

test('all RPC failure exits record elapsed time and preserve transport error codes', async t => {
  let clock = 100;
  t.mock.method(performance, 'now', () => { clock += 7; return clock; });
  const cases = [
    [{ apiProxy: {} }, 'harness-api-not-found'],
    [{ apiProxy: { host: { describe: () => { throw new Error('private'); } } } }, 'harness-connect-failed'],
    [{ apiProxy: { host: { describe: () => ({ rpcId: 'wrong' }) } } }, 'harness-response-invalid'],
    [{ apiProxy: { host: { describe: ({ rpcId }) => ({ rpcId, result: {} }) } } }, 'harness-response-invalid'],
    [{ fetchImpl: async () => { throw new Error('private'); } }, 'harness-connect-failed'],
    [{ fetchImpl: async () => new Response('', { status: 500 }) }, 'harness-http-failed'],
    [{ fetchImpl: async () => new Response('{') }, 'harness-response-invalid'],
  ];
  for (const [options, code] of cases) {
    const transport = options.apiProxy ? 'host-api' : 'http';
    const client = new HarnessClient({ ...(transport === 'http' ? { baseUrl: 'http://localhost:1234' } : {}), ...options });
    await assert.rejects(client.rpc('host.describe', {}, 1000), error => {
      assert.equal(error.code, code);
      assert.equal(error.method, 'host.describe');
      assert.equal(error.transport, transport);
      assert.equal(error.durationMs, 7);
      assert.equal(error.timeoutMs, 1000);
      return true;
    });
  }
});

test('RPC method and transport diagnostics admit only owned values, including serialized causes', () => {
  assert.deepEqual(normalizeDiagnosticDetails({ method: 'https://private.example?token=secret', transport: 'private-transport' }), {});
  const details = { method: 'workspace.list', transport: 'host-api', durationMs: 30005, timeoutMs: 30000 };
  const error = { code: 'harness-timeout', cause: { details } };
  assert.deepEqual(extractConnectionEvidence(error).details, { reason: 'unknown', ...details });
  assert.equal(classifyMessageFailure(error).code, 'HARNESS_TIMEOUT');
  assert.equal(publicMessageFailure(classifyMessageFailure(error)).details.method, 'workspace.list');
});
