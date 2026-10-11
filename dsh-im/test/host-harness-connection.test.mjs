import assert from 'node:assert/strict';
import test from 'node:test';

import { harnessConnection } from '../plugin-src/host/harness-connection.mjs';
import { inject as hostInject } from '../plugin-src/host/index.mjs';
import { toPosixPath } from './support/filesystem.mjs';

const IM_CHANNELS = [
  'weixin', 'feishu', 'dingtalk', 'wecom', 'qq',
  'slack', 'telegram', 'discord', 'whatsapp', 'matrix', 'wecom-app', 'imessage', 'email',
];

function modernContext(extra = {}) {
  return Object.defineProperties({ typertGateway: { invoke() {}, stream() {} }, on() {} }, Object.getOwnPropertyDescriptors(extra));
}

test('Host connections use the modern gateway and share the current Cordis root', () => {
  const root = {};
  const ctx = modernContext({ root, get apiProxy() { throw new Error('legacy service must not be read'); } });
  const first = harnessConnection(ctx);
  const second = harnessConnection(modernContext({ root }));
  assert.equal(first.apiProxy, second.apiProxy);
  assert.equal(first.interactionScope, root);
  assert.equal(first.competitiveApprovals, false);
  assert.notEqual(first.interactionScope, harnessConnection(modernContext({ root: {} })).interactionScope);
  const fixtureContext = modernContext();
  assert.equal(harnessConnection(fixtureContext).interactionScope, fixtureContext);
  assert.throws(() => harnessConnection({ apiProxy: {} }), /requires the modern Host Typert gateway/);
});

test('an explicit Harness URL preserves HTTP transport and never reads the Host apiProxy', () => {
  const ctx = { get apiProxy() { throw new Error('must not read local apiProxy'); } };
  const connection = harnessConnection(ctx, { harnessBaseUrl: 'https://harness.example/base/' });
  assert.equal(connection.baseUrl.href, 'https://harness.example/base/');
  assert.deepEqual(Object.keys(connection), ['baseUrl']);
  assert.throws(() => harnessConnection(ctx, { harnessBaseUrl: 'not a URL' }), TypeError);
});

test('a Host without a modern gateway fails clearly', () => {
  assert.throws(
    () => harnessConnection({ webServer: { port: 3080 } }),
    /requires the modern Host Typert gateway/,
  );
});

test('Host and all IM channel plugins require the modern gateway', async () => {
  assert.equal(hostInject.includes('apiProxy'), false);
  assert.equal(hostInject.includes('webServer'), false);
  assert.ok(hostInject.includes('typertGateway'));
  for (const channel of IM_CHANNELS) {
    const { inject } = await import(`../plugin-src/host/channels/${channel}/index.mjs`);
    assert.equal(inject.includes('apiProxy'), false, channel);
    assert.equal(inject.includes('webServer'), false, channel);
    assert.ok(inject.includes('typertGateway'), channel);
  }
});

async function assembledHarness(channel, ctx, config = {}) {
  const { createProductionController } = await import(
    `../plugin-src/host/channels/${channel}/production.mjs`
  );
  const constructed = {};
  class ConfigStore {
    async load() { return this; }
    list() { return []; }
  }
  class Harness {
    constructor(options) { constructed.harness = options; }
    stopManagedProcess() {}
  }
  class Controller {
    constructor(options) { constructed.controller = options; }
    async initialize() {}
    async close() {}
  }
  class Runtime {
    constructor(options) { constructed.runtime = options; }
  }
  const production = await createProductionController(ctx, {
    workspace: '/test/workspace',
    ...config,
  }, {
    ConfigStore,
    HarnessClient: Harness,
    Controller,
    Runtime,
    FeishuRuntime: Runtime,
    api: {},
    deviceAuth: {},
    qrAuth: {},
    lark: {},
    proxyEnv: {},
    workspaces: {
      async reconcile() {},
      async ensure() {},
      decorateStatus(value) { return value; },
    },
    createConnectionSupervisor: () => ({
      ready: Promise.resolve(),
      start() { return this; },
      async close() {},
    }),
  });
  try {
    if (channel === 'office') {
      constructed.controller.createRuntime({});
      constructed.runtime.createHarness({ workspace: '/test/workspace' });
    }
    return constructed.harness;
  } finally {
    await production.close();
  }
}

for (const channel of [...IM_CHANNELS, 'office']) {
  test(`${channel} production uses the modern Host gateway with no webServer or listening port`, async () => {
    const root = {};
    const ctx = modernContext({ credentials: {}, root });
    const options = await assembledHarness(channel, ctx);
    assert.equal(options.apiProxy, harnessConnection(ctx).apiProxy);
    assert.equal(options.competitiveApprovals, !['imessage', 'email', 'office'].includes(channel));
    assert.equal(options.interactionScope, root);
    assert.equal(Object.hasOwn(options, 'baseUrl'), false);
    assert.match(toPosixPath(options.workspace), /\/test\/workspace$/);
    assert.equal(options.autostart, false);
  });

  test(`${channel} production preserves an explicitly configured Harness URL`, async () => {
    const options = await assembledHarness(channel, {
      credentials: {},
      get apiProxy() { throw new Error('explicit URL must not use local apiProxy'); },
    }, { harnessBaseUrl: 'http://127.0.0.1:43210/custom/' });
    assert.equal(options.baseUrl.href, 'http://127.0.0.1:43210/custom/');
    assert.equal(Object.hasOwn(options, 'apiProxy'), false);
    assert.equal(Object.hasOwn(options, 'interactionScope'), false);
    assert.equal(options.autostart, false);
  });
}
