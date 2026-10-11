import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createProductionController } from '../../../plugin-src/host/channels/discord/production.mjs';

test('Discord production has no per-bot result-file Gate', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-discord-production-artifacts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimes = [];
  let controllerOptions;

  class ConfigStore {
    async load() { return this; }
    list() { return []; }
  }
  class StateStore {
    async load() { return this; }
  }
  class Harness {
    stopManagedProcess() {}
  }
  class Runtime {
    constructor(options) { runtimes.push(options); }
  }
  class Controller {
    constructor(options) { controllerOptions = options; }
    async close() {}
  }
  const supervisor = {
    ready: Promise.resolve(),
    start() { return this; },
    async close() {},
  };
  const internals = {
    ConfigStore,
    StateStore,
    HarnessClient: Harness,
    Controller,
    Runtime,
    createConnectionSupervisor: () => supervisor,
  };
  const ctx = {
    credentials: {},
    typertGateway: { invoke() {}, stream() {} },
    logger: () => ({ error() {}, warn() {}, info() {}, debug() {} }),
  };
  const createRuntime = (botId) => controllerOptions.createRuntime({
    botId,
    config: { botId, ownerUserId: '234567890123456789' },
    token: 'host-only',
  });

  const production = await createProductionController(ctx, {
    dataDir: join(root, 'default'),
  }, internals);
  await createRuntime('discord_enabled');
  await createRuntime('discord_not_listed');
  assert.equal(Object.hasOwn(runtimes[0], 'outboundArtifactsEnabled'), false);
  assert.equal(Object.hasOwn(runtimes[1], 'outboundArtifactsEnabled'), false);
  assert.equal(runtimes[0].accessPolicy.isPrivileged('234567890123456789', 'direct'), true);
  assert.equal(runtimes[0].accessPolicy.isPrivileged('234567890123456789', 'group'), true);
  assert.equal(runtimes[0].accessPolicy.isPrivileged('345678901234567890', 'direct'), false);
  await production.close();
});
