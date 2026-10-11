import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { initialAccessPolicyFor } from '../../../plugin-src/host/channels/shared/access-policy-production.mjs';
import { createAccessPolicy, createAccessPolicyScope } from '../../../src/channels/shared/access-policy.mjs';
import { evaluateInboundAccess } from '../../../src/channels/shared/inbound-access.mjs';

for (const channel of ['feishu', 'qq']) {
  test(`${channel} opens new bot messages and commands while preserving saved policies and legacy migration`, async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), `dsh-new-access-${channel}-`));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    const path = join(dataDir, 'workspaces.json');
    const chatOnlyScope = createAccessPolicyScope({
      mode: 'open',
      open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
      allowlist: { users: [] },
    });
    const chatOnly = createAccessPolicy({ direct: chatOnlyScope, group: chatOnlyScope });
    const restricted = createAccessPolicy({
      direct: createAccessPolicyScope({
        mode: 'allowlist',
        open: { defaultCanExecuteCommands: true, commandPermissionOverrides: [] },
        allowlist: { users: [{ id: 'member', canExecuteCommands: false }] },
      }),
    });
    await writeFile(path, JSON.stringify({
      version: 2,
      workspaces: { saved: dataDir, damaged: dataDir, chat_only: dataDir },
      accessPolicies: { saved: restricted, damaged: null, chat_only: chatOnly },
    }));
    const bot = (id, owner = 'owner') => ({
      id, botId: id, appId: `app_${id}`, secretRef: `secret_${id}`,
      ownerOpenIds: [owner], ownerUserOpenid: owner,
    });
    const bots = ['legacy', 'saved', 'damaged', 'chat_only'].map((id) => bot(id));
    let controllerOptions;
    let runtimeOptions;
    class ConfigStore {
      async load() { return this; }
      list() { return bots; }
      getBot(id) { return bots.find((config) => config.id === id); }
    }
    class StateStore { async load() { return this; } }
    class Harness { stopManagedProcess() {} }
    class Runtime { constructor(options) { runtimeOptions = options; } }
    class Controller {
      constructor(options) { controllerOptions = options; }
      status() { return { bots: bots.map(({ botId }) => ({ botId, configured: true })) }; }
      async close() {}
    }
    const { createProductionController } = await import(`../../../plugin-src/host/channels/${channel}/production.mjs`);
    const start = () => createProductionController({
      credentials: {}, typertGateway: { invoke() {}, stream() {} },
      logger: () => ({ error() {}, warn() {}, info() {}, debug() {} }),
    }, { dataDir, workspace: dataDir }, {
      ConfigStore, StateStore, HarnessClient: Harness, Controller, Runtime, FeishuRuntime: Runtime,
      qrAuth: {}, lark: {}, proxyEnv: {},
      createConnectionSupervisor: () => ({
        ready: Promise.resolve(), start() { return this; }, async close() {},
      }),
    });
    const connect = async (config) => {
      await controllerOptions.createRuntime({ botId: config.botId, config });
      return runtimeOptions.accessPolicy;
    };
    const checkAccess = (provider, conversationType, senderIds, text) => evaluateInboundAccess(provider, {
      conversationType, senderIds, text,
    });
    let production = await start();
    t.after(() => production.close());
    const legacyPolicy = initialAccessPolicyFor(channel, bots[0]);
    assert.deepEqual((await connect(bots[0])).getSettings(), legacyPolicy);
    assert.deepEqual((await connect(bots[1])).getSettings(), restricted);
    const damaged = await connect(bots[2]);
    assert.equal(damaged.getSettings(), null);
    assert.equal(checkAccess(damaged, 'direct', 'other', 'hello').reason, 'policy-unavailable');
    const existingChatOnly = await connect(bots[3]);
    for (const conversationType of ['direct', 'group']) {
      assert.equal(checkAccess(existingChatOnly, conversationType, 'other', 'hello').allowed, true);
      assert.equal(checkAccess(existingChatOnly, conversationType, 'other', '/status').reason, 'command-not-allowed');
    }

    const freshBot = bot('new');
    bots.push(freshBot);
    const fresh = await connect(freshBot);
    const freshPolicy = fresh.getSettings();
    for (const conversationType of ['direct', 'group']) {
      assert.equal(freshPolicy[conversationType].mode, 'open');
      assert.deepEqual(checkAccess(fresh, conversationType, 'other', 'hello'),
        { allowed: true, reason: 'allowed' });
      assert.equal(freshPolicy[conversationType].open.defaultCanExecuteCommands, true);
      assert.deepEqual(checkAccess(fresh, conversationType, 'other', '/status'),
        { allowed: true, reason: 'allowed' });
      assert.deepEqual(checkAccess(fresh, conversationType, 'owner', '/status'),
        { allowed: true, reason: 'privileged-sender' });
    }

    const manualBot = bot('manual', '*');
    bots.push(manualBot);
    const manual = await connect(manualBot);
    for (const conversationType of ['direct', 'group']) {
      assert.equal(checkAccess(manual, conversationType, 'other', '/status').allowed, true);
    }

    const customizedBot = bot('customized');
    bots.push(customizedBot);
    const customized = await connect(customizedBot);
    await production.controller.updateAccessPolicy(customizedBot.botId, restricted);
    assert.deepEqual(customized.getSettings(), restricted, 'saved restrictions apply without reconnecting');
    assert.deepEqual((await connect(customizedBot)).getSettings(), restricted, 'reconnecting keeps settings');

    await production.close();
    production = await start();
    const expected = [legacyPolicy, restricted, null, chatOnly, freshPolicy, manual.getSettings(), restricted];
    for (const [index, config] of bots.entries()) {
      assert.deepEqual((await connect(config)).getSettings(), expected[index], `${config.botId} after restart`);
    }
    const persisted = JSON.parse(await readFile(path, 'utf8')).accessPolicies;
    assert.deepEqual(persisted.new, freshPolicy);
    assert.deepEqual(persisted.customized, restricted);
    assert.deepEqual(persisted.legacy, legacyPolicy);
    assert.equal(persisted.damaged, null);
    assert.deepEqual(persisted.chat_only, chatOnly);
  });
}
