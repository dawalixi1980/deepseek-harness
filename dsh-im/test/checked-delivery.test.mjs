import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createDeliveryAdapter } from '../plugin-src/host/delivery-adapter.mjs';
import { createDeliveryService } from '../plugin-src/host/delivery-service.mjs';
import { verifyFeishuApp } from '../src/channels/feishu/feishu-app.mjs';
import { MultiBotDshFeishuController } from '../src/channels/feishu/multi-bot-controller.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture({ verifyApp, sendText } = {}) {
  const config = {
    id: 'bot_checked', appId: 'cli_checked', secretRef: 'DSH_CHECKED_TEST_SECRET',
    domain: 'feishu', botOpenId: 'ou_bot_checked', botName: 'Checked bot',
    ownerOpenIds: ['ou_owner'], activated: 1,
  };
  const target = { targetId: 'owner', kind: 'user', route: { openId: 'ou_owner' } };
  const sends = [];
  const verificationCalls = [];
  let credentialError;
  const runtime = {
    status: { ready: false, feishuLongConnectionState: 'idle', harnessReachable: false },
    async start() {
      runtime.status = { ready: true, feishuLongConnectionState: 'connected', harnessReachable: true };
    },
    async stop() { runtime.status.ready = false; },
    async sendProactiveText(...args) {
      sends.push(args);
      if (sendText) return sendText(...args);
      return { sent: true };
    },
  };
  const controller = new MultiBotDshFeishuController({
    registerApp: async () => ({}),
    verifyApp: async (options) => {
      verificationCalls.push(options);
      return verifyApp ? verifyApp(options) : { openId: config.botOpenId, name: config.botName };
    },
    credentials: {
      async resolve() {
        if (credentialError) throw credentialError;
        return { value: 'checked-test-secret' };
      },
    },
    configStore: {
      list: () => [structuredClone(config)],
      getBot: (botId) => botId === config.id ? structuredClone(config) : null,
    },
    createRuntime: async () => runtime,
  });
  await controller.initialize();
  const adapter = createDeliveryAdapter({
    channel: 'feishu', coreController: controller,
    stateFor: async () => ({ snapshot: () => ({ sessions: {} }) }),
    workspaces: {
      has: (botId) => botId === config.id,
      listBotIds: () => [config.id],
      listDeliveryTargets: () => [structuredClone(target)],
    },
  });
  const service = createDeliveryService();
  const dispose = service.registerAdapter(adapter);
  const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return {
    service, controller, adapter, dispose, sends, verificationCalls,
    failCredentialReads() { credentialError = new Error('Credential provider unavailable'); },
    options: {
      expectedFingerprint: digest({
        provider: 'feishu', domain: config.domain, appId: config.appId, botOpenId: config.botOpenId,
      }),
      expectedTargetDigest: digest({ kind: target.kind, route: target.route }),
    },
  };
}

test('legacy Feishu delivery does not require the new authenticated account capability', async (t) => {
  const fx = await fixture({ verifyApp: async () => { throw new Error('Verification unavailable'); } });
  t.after(() => fx.controller.close());
  assert.deepEqual(await fx.service.send('bot_checked', 'owner', 'legacy message', { format: 'markdown' }), {
    sent: true,
  });
  assert.equal(fx.verificationCalls.length, 0);
  assert.equal(fx.sends.length, 1);
  assert.deepEqual(fx.sends[0][2], { signal: undefined, format: 'markdown' });
});

for (const action of ['dispose', 'replace', 'register-same-adapter', 'close-controller', 'dispose-and-close']) {
  test(`checked Feishu delivery refuses ${action} during the final account verification`, async (t) => {
    const entered = deferred();
    const release = deferred();
    let calls = 0;
    const fx = await fixture({
      verifyApp: async () => {
        if (++calls === 2) {
          entered.resolve();
          await release.promise;
        }
        return { openId: 'ou_bot_checked' };
      },
    });
    t.after(() => fx.controller.close());
    const sending = fx.service.sendChecked('bot_checked', 'owner', 'checked message', fx.options);
    await entered.promise;
    assert.equal(fx.sends.length, 0);
    let closing;
    if (action === 'replace') fx.service.registerAdapter({ ...fx.adapter });
    else if (action === 'register-same-adapter') fx.service.registerAdapter(fx.adapter);
    else if (action === 'close-controller') closing = fx.controller.close();
    else {
      assert.equal(fx.dispose(), true);
      if (action === 'dispose-and-close') closing = fx.controller.close();
    }
    release.resolve();
    await assert.rejects(sending, { code: 'capability-unavailable' });
    await closing;
    assert.equal(fx.sends.length, 0);
  });
}

for (const failureAt of [1, 2]) {
  test(`checked Feishu delivery identifies authentication failure at verification ${failureAt} as a pre-send refusal`, async (t) => {
    let calls = 0;
    const fx = await fixture({
      verifyApp: (options) => ++calls === failureAt ? verifyFeishuApp({
        ...options,
        httpInstance: { request: async () => ({ code: 99991663, msg: 'Invalid app secret' }) },
      }) : { openId: 'ou_bot_checked' },
    });
    t.after(() => fx.controller.close());
    await assert.rejects(fx.service.sendChecked('bot_checked', 'owner', 'checked message', fx.options), {
      code: 'account-unverified',
    });
    assert.equal(fx.sends.length, 0);
  });
}

test('checked account discovery refuses a controller closed during platform verification', async (t) => {
  const entered = deferred();
  const release = deferred();
  const fx = await fixture({ verifyApp: async () => {
    entered.resolve();
    await release.promise;
    return { openId: 'ou_bot_checked' };
  } });
  t.after(() => fx.controller.close());
  const describing = fx.service.describeBot('bot_checked');
  await entered.promise;
  const closing = fx.controller.close();
  release.resolve();
  await assert.rejects(describing, { code: 'capability-unavailable' });
  await closing;
});

test('checked Feishu delivery identifies credential read failure as a pre-send refusal', async (t) => {
  const fx = await fixture();
  t.after(() => fx.controller.close());
  fx.failCredentialReads();
  await assert.rejects(fx.service.sendChecked('bot_checked', 'owner', 'checked message', fx.options), {
    code: 'account-unverified',
  });
  assert.equal(fx.sends.length, 0);
});

test('checked Feishu delivery cancels before sending when aborted during its final verification', async (t) => {
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  const fx = await fixture({
    verifyApp: async () => {
      if (++calls === 2) {
        entered.resolve();
        await release.promise;
      }
      return { openId: 'ou_bot_checked' };
    },
  });
  t.after(() => fx.controller.close());
  const abort = new AbortController();
  const sending = fx.service.sendChecked('bot_checked', 'owner', 'checked message', {
    ...fx.options, signal: abort.signal,
  });
  await entered.promise;
  abort.abort();
  release.resolve();
  await assert.rejects(sending, { code: 'cancelled' });
  assert.equal(fx.sends.length, 0);
});

test('checked Feishu delivery preserves uncertainty after a send starts and never retries', async (t) => {
  const fx = await fixture({ sendText: async () => { throw new DOMException('Response lost', 'AbortError'); } });
  t.after(() => fx.controller.close());
  await assert.rejects(fx.service.sendChecked('bot_checked', 'owner', 'checked message', fx.options), {
    code: 'delivery-failed',
  });
  assert.equal(fx.sends.length, 1);
});
