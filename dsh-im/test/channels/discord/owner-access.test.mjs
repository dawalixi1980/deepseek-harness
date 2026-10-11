import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { inspectDiscordOwner } from '../../../src/channels/discord/discord-api.mjs';
import { DiscordConfigStore, deriveDiscordBotIdentity } from '../../../src/channels/discord/config-store.mjs';
import { DiscordController } from '../../../src/channels/discord/discord-controller.mjs';
import { accessPolicyProvider } from '../../../plugin-src/host/channels/shared/access-policy-production.mjs';
import { createAccessPolicy } from '../../../src/channels/shared/access-policy.mjs';
import { evaluateInboundAccess } from '../../../src/channels/shared/inbound-access.mjs';

const TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.ABCD.abcdefghijklmnopqrstuvwxyz123456';
const BOT = '123456789012345678';
const OWNER = '223456789012345678';
const TEAM_OWNER = '323456789012345678';
const MEMBER = '423456789012345678';
const identity = deriveDiscordBotIdentity(BOT);
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

test('Discord owner lookup authenticates the bot and selects only the personal or team owner', async () => {
  for (const [application, expected] of [
    [{ bot: { id: BOT }, owner: { id: OWNER } }, OWNER],
    [{ bot: { id: BOT }, owner: { id: OWNER }, team: { owner_user_id: TEAM_OWNER, members: [{ user: { id: MEMBER } }] } }, TEAM_OWNER],
    [{ owner: { id: OWNER } }, OWNER],
  ]) {
    const paths = [];
    const resolved = await inspectDiscordOwner(TOKEN, {
      platformId: BOT,
      fetchImpl: async (url, options) => {
        paths.push(url.pathname);
        assert.equal(options.headers.authorization, `Bot ${TOKEN}`);
        return json(url.pathname.endsWith('applications/@me') ? application : { id: BOT, bot: true });
      },
    });
    assert.equal(resolved, expected);
    assert.deepEqual(paths, application.bot
      ? ['/api/v10/applications/@me']
      : ['/api/v10/applications/@me', '/api/v10/users/@me']);
  }
});

test('Discord rejects incomplete, mismatched, wildcard and bot owner identities', async () => {
  for (const application of [
    {},
    { bot: { id: MEMBER }, owner: { id: OWNER } },
    { bot: { id: BOT }, owner: { id: '*' } },
    { bot: { id: BOT }, owner: { id: BOT } },
    { bot: { id: BOT }, owner: { id: OWNER, bot: true } },
    { bot: { id: BOT }, owner: { id: OWNER }, team: {} },
  ]) {
    await assert.rejects(inspectDiscordOwner(TOKEN, {
      platformId: BOT,
      fetchImpl: async (url) => json(url.pathname.endsWith('applications/@me')
        ? application : { id: BOT, bot: true }),
    }));
  }
});

test('Discord optional owner lookup has a total timeout and does not retry rate limits', async () => {
  let calls = 0;
  await assert.rejects(inspectDiscordOwner(TOKEN, {
    platformId: BOT,
    fetchImpl: async () => { calls += 1; return json({ retry_after: 60 }, 429); },
  }), { code: 'discord-429' });
  assert.equal(calls, 1);
  await assert.rejects(inspectDiscordOwner(TOKEN, {
    platformId: BOT, timeoutMs: 10,
    fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(json({})), 1_000);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    }),
  }), { name: 'TimeoutError' });
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-discord-owner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'config.json');
  const store = await new DiscordConfigStore(path).load();
  const secrets = new Map();
  const fx = {
    path, store, runtimes: [], warnings: [], lookups: 0,
    lookup: async () => OWNER,
    createController(configStore = store) {
      return new DiscordController({
        configStore,
        logger: { warn: (...args) => fx.warnings.push(args) },
        credentials: {
          resolve: async (ref) => secrets.has(ref) ? { value: secrets.get(ref) } : undefined,
          set: async (ref, value) => { secrets.set(ref, value); },
          unset: async (ref) => { secrets.delete(ref); },
        },
        inspectToken: async () => ({ platformId: BOT, name: 'Owner test' }),
        inspectOwner: async (...args) => { fx.lookups += 1; return fx.lookup(...args); },
        createRuntime: async ({ botId, config }) => {
          // The real production factory constructs the provider here, after
          // DiscordController has committed the optional owner metadata.
          const provider = accessPolicyProvider({ accessPolicyFor: () => createAccessPolicy() }, botId, {
            channel: 'discord', config,
          });
          const runtime = {
            config, provider, starts: 0, stops: 0,
            status: { ready: true },
            async start() { this.starts += 1; },
            async stop() { this.stops += 1; },
          };
          fx.runtimes.push(runtime);
          return runtime;
        },
      });
    },
  };
  fx.controller = fx.createController();
  t.after(() => fx.controller.close());
  return fx;
}

function decision(runtime, senderIds, conversationType = 'direct') {
  return evaluateInboundAccess(runtime.provider, { senderIds, conversationType, text: '/status' });
}

test('Discord commits owner before building runtime policy and refreshes only on normal startup paths', async (t) => {
  const fx = await fixture(t);
  await fx.controller.bindCredentials({ token: TOKEN });
  assert.equal(fx.store.get(identity.botId).ownerUserId, OWNER);
  for (const conversationType of ['direct', 'group']) {
    assert.equal(decision(fx.runtimes.at(-1), OWNER, conversationType).reason, 'privileged-sender');
    assert.equal(decision(fx.runtimes.at(-1), MEMBER, conversationType).allowed, false);
  }
  assert.doesNotMatch(JSON.stringify(fx.controller.status()), new RegExp(`${OWNER}|${TOKEN.replaceAll('.', '\\.')}`));
  fx.controller.status();
  assert.equal(fx.lookups, 1, 'status and access checks do not query Discord');

  fx.lookup = async () => TEAM_OWNER;
  await fx.controller.reconnectBot(identity.botId);
  assert.equal(decision(fx.runtimes.at(-1), TEAM_OWNER).allowed, true);
  assert.equal(decision(fx.runtimes.at(-1), OWNER).allowed, false);
  assert.equal(fx.runtimes[0].stops, 1);
  await fx.controller.close();
  const reloaded = await new DiscordConfigStore(fx.path).load();
  fx.controller = fx.createController(reloaded);
  await fx.controller.initialize();
  assert.equal(decision(fx.runtimes.at(-1), TEAM_OWNER).allowed, true);
  assert.equal(fx.lookups, 3);
});

test('Discord preserves committed owner across binding and failed queries without exposing provider errors', async (t) => {
  const fx = await fixture(t);
  await fx.controller.bindCredentials({ token: TOKEN });
  fx.lookup = async () => { throw new Error(`private provider details ${TOKEN} ${MEMBER}`); };
  await fx.controller.bindCredentials({ token: TOKEN });
  assert.equal(fx.store.get(identity.botId).ownerUserId, OWNER);
  assert.equal(decision(fx.runtimes.at(-1), OWNER).allowed, true);
  assert.equal(fx.runtimes.at(-1).starts, 1);
  assert.doesNotMatch(JSON.stringify(fx.warnings), /private provider|423456789012345678|MTIz/);
  await fx.controller.deleteBot(identity.botId);
  await fx.controller.bindCredentials({ token: TOKEN });
  assert.equal(fx.store.get(identity.botId).ownerUserId, null);
  assert.equal(decision(fx.runtimes.at(-1), OWNER).allowed, false, 'deleted owner is not inherited');
  assert.equal(fx.runtimes.at(-1).starts, 1, 'missing owner does not prevent startup');
});

test('Discord upgrades an existing config without owner metadata on startup', async (t) => {
  const fx = await fixture(t);
  await fx.controller.bindCredentials({ token: TOKEN });
  await fx.controller.close();
  const legacy = JSON.parse(await readFile(fx.path, 'utf8'));
  delete legacy.bots[0].ownerUserId;
  await writeFile(fx.path, JSON.stringify(legacy));
  const reloaded = await new DiscordConfigStore(fx.path).load();
  assert.equal(reloaded.get(identity.botId).ownerUserId, null);
  fx.controller = fx.createController(reloaded);
  await fx.controller.initialize();
  assert.equal(reloaded.get(identity.botId).ownerUserId, OWNER);
  assert.equal(decision(fx.runtimes.at(-1), OWNER).allowed, true);
  assert.deepEqual(fx.runtimes.at(-1).provider.getSettings(), createAccessPolicy(),
    'owner discovery leaves the existing empty allowlists intact');
});

test('Discord metadata write failure never publishes an uncommitted owner', async (t) => {
  const fx = await fixture(t);
  await fx.controller.bindCredentials({ token: TOKEN });
  const save = fx.store.save.bind(fx.store);
  fx.store.save = async (config) => {
    if (config.ownerUserId === TEAM_OWNER) throw new Error('disk write failed');
    return save(config);
  };
  fx.lookup = async () => TEAM_OWNER;
  await fx.controller.reconnectBot(identity.botId);
  assert.equal(decision(fx.runtimes.at(-1), TEAM_OWNER).allowed, false);
  assert.equal(decision(fx.runtimes.at(-1), OWNER).allowed, true);
  assert.equal(fx.runtimes.at(-1).starts, 1);
  assert.equal(JSON.parse(await readFile(fx.path, 'utf8')).bots[0].ownerUserId, OWNER);
});

test('Discord loads legacy configs and confines preserved owner data to the same bot', async (t) => {
  const fx = await fixture(t);
  const legacy = { ...identity, platformId: BOT, name: 'Legacy' };
  await writeFile(fx.path, JSON.stringify({ version: 1, bots: [legacy] }));
  const store = await new DiscordConfigStore(fx.path).load();
  assert.equal(store.get(identity.botId).ownerUserId, null);
  await store.save({ ...legacy, ownerUserId: OWNER });
  await store.save({ ...legacy, name: 'Renamed' });
  assert.equal(store.get(identity.botId).ownerUserId, OWNER);
  const other = { ...deriveDiscordBotIdentity(MEMBER), platformId: MEMBER, name: 'Other bot' };
  assert.equal((await store.save(other)).ownerUserId, null);
  for (const ownerUserId of ['*', BOT, 12345, 'not-an-id']) {
    await assert.rejects(store.save({ ...legacy, ownerUserId }));
  }
  await assert.rejects(store.save({ ...legacy, platformId: ` ${BOT} `, ownerUserId: BOT }));
  await store.save({ ...legacy, ownerUserId: null });
  assert.equal(store.get(identity.botId).ownerUserId, null);
});

test('Discord serializes deletion behind owner discovery and leaves no resurrected bot', async (t) => {
  const fx = await fixture(t);
  await fx.controller.bindCredentials({ token: TOKEN });
  let release;
  let started;
  const pending = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  fx.lookup = async () => { started(); return pending; };
  const reconnecting = fx.controller.reconnectBot(identity.botId);
  await entered;
  const deleting = fx.controller.deleteBot(identity.botId);
  release(TEAM_OWNER);
  await Promise.all([reconnecting, deleting]);
  assert.equal(fx.store.get(identity.botId), null);
  assert.equal(fx.controller.status().bots.length, 0);
  assert.equal(fx.runtimes.at(-1).stops, 1);
});

test('Discord close drains a runtime whose owner lookup was already in progress', async (t) => {
  const fx = await fixture(t);
  await fx.controller.bindCredentials({ token: TOKEN });
  let release;
  let started;
  const pending = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  fx.lookup = async () => { started(); return pending; };
  const reconnecting = fx.controller.reconnectBot(identity.botId);
  await entered;
  const closing = fx.controller.close();
  release(TEAM_OWNER);
  await Promise.all([reconnecting, closing]);
  assert.ok(fx.runtimes.every((runtime) => runtime.stops === 1));
});
