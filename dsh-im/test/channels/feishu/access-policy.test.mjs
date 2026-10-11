import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createProductionController } from '../../../plugin-src/host/channels/feishu/production.mjs';
import { createFeishuRpcHandler, FEISHU_ENDPOINTS } from '../../../plugin-src/host/channels/feishu/rpc.mjs';
import { PluginConfigStore } from '../../../src/channels/feishu/plugin-config-store.mjs';
import { createAccessPolicy, createAccessPolicyScope } from '../../../src/channels/shared/access-policy.mjs';
import { setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';

const allowlist = (ids, mode = 'allowlist') => createAccessPolicyScope({
  mode,
  open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
  allowlist: { users: ids.map((id) => ({ id, canExecuteCommands: true })) },
});

test('Feishu production rejects its own bot ID only in active allowlists and exposes the save error', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-feishu-access-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configs = await new PluginConfigStore(join(directory, 'config.json')).load();
  for (const id of ['first', 'second']) {
    await configs.saveBot({
      id, appId: `cli_${id}`, secretRef: `TEST_${id}`, ownerOpenIds: ['*'], botOpenId: `ou_bot_${id}`,
    });
  }
  class Harness {
    stopManagedProcess() {}
  }
  class Controller {
    constructor({ configStore }) { this.configStore = configStore; }
    status() {
      return { bots: this.configStore.list().map((bot) => ({ botId: bot.id, configured: true })) };
    }
    async startRegistration() { return this.status(); }
    async cancelRegistration() { return this.status(); }
    async disconnect() { return this.status(); }
    async close() {}
  }
  const production = await createProductionController({
    credentials: {}, typertGateway: { invoke() {}, stream() {} }, logger: { warn() {}, info() {}, error() {} },
  }, { dataDir: directory, workspace: directory }, {
    Controller, HarnessClient: Harness,
    createConnectionSupervisor: () => ({ ready: Promise.resolve(), start() { return this; }, async close() {} }),
  });
  t.after(() => production.close());
  const rpc = createFeishuRpcHandler(production.controller);
  const path = join(directory, 'workspaces.json');
  const original = await readFile(path, 'utf8');
  const invalid = createAccessPolicy({ direct: allowlist(['ou_bot_first']), group: allowlist([]) });
  for (const scene of ['direct', 'group']) {
    const policy = createAccessPolicy({ [scene]: allowlist(['  ou_bot_first  ']) });
    const result = await rpc(FEISHU_ENDPOINTS.setAccessPolicy, { botId: 'first', policy });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'access-policy-invalid');
    assert.match(result.error.message, /不能填写机器人自己的 Open ID/);
    assert.equal(await readFile(path, 'utf8'), original, 'validation must not commit or rewrite a policy');
  }
  setImHostLanguage('en');
  try {
    const result = await rpc(FEISHU_ENDPOINTS.setAccessPolicy, { botId: 'first', policy: invalid });
    assert.match(result.error.message, /not the bot’s own Open ID/);
  } finally {
    setImHostLanguage('zh');
  }
  // Hidden historical rows are retained so switching back to open can recover
  // access, without silently deleting the user's other mode draft.
  const reopened = createAccessPolicy({ direct: allowlist(['ou_bot_first'], 'open'), group: allowlist([]) });
  assert.equal((await rpc(FEISHU_ENDPOINTS.setAccessPolicy, { botId: 'first', policy: reopened })).ok, true);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).accessPolicies.first, reopened);
  assert.equal((await rpc(FEISHU_ENDPOINTS.setAccessPolicy, { botId: 'first', policy: invalid })).ok, false);
  const valid = createAccessPolicy({ direct: allowlist(['ou_person']), group: allowlist([]) });
  assert.equal((await rpc(FEISHU_ENDPOINTS.setAccessPolicy, { botId: 'first', policy: valid })).ok, true);
  assert.equal((await rpc(FEISHU_ENDPOINTS.setAccessPolicy, { botId: 'second', policy: invalid })).ok, true,
    'self-ID validation uses the selected bot, not any bot in the account');
  const savedConfig = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'));
  assert.deepEqual(savedConfig.bots.map((bot) => bot.ownerOpenIds), [['*'], ['*']],
    'saving access settings must not guess or rewrite owners');
});
