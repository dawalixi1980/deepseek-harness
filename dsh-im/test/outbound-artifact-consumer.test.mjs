import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { OutboundArtifactRegistry } from '../src/channels/shared/semantic/artifact.mjs';

const SESSION_ID = 'session-copy-race';
const RPC_ID = 'rpc-copy-race';
const TURN = 7;

const races = [
  ['the tool execution is aborted', ({ controller }) => {
    controller.abort(new DOMException('File return cancelled', 'AbortError'));
  }, { name: 'AbortError' }],
  ['the consumer is released', ({ releaseConsumer }) => releaseConsumer()],
  ['the session is disposed', ({ registry, session }) => registry.disposeSession(session)],
  ['the registry is cleared', ({ registry }) => registry.clear()],
  ['the turn ends with a stale session snapshot', ({ registry, session }) => {
    registry.observeSessionEvent(session, { type: 'turn/end', data: { turn: TURN } });
  }],
  ['a new turn starts', ({ registry, session }) => {
    registry.openConsumer(SESSION_ID, 'rpc-next-turn');
    registry.observeSessionEvent(session, { type: 'turn/start', data: { turn: TURN + 1 } });
    registry.observeSessionEvent(session, {
      type: 'user/message',
      data: { turn: TURN + 1, source: { rpcId: 'rpc-next-turn' } },
    });
  }],
  ['another consumer replaces the same session, turn and request', ({ registry, session }) => {
    registry.openConsumer(SESSION_ID, RPC_ID);
    registry.observeSessionEvent(session, {
      type: 'user/message',
      data: { turn: TURN, source: { rpcId: RPC_ID } },
    });
  }],
];

// These tests run sequentially because the copyFile hook updates a built-in ESM
// binding. It pauses after a real copy, so cleanup must remove an actual file.
for (const [name, invalidateConsumer, expectedError = { code: 'artifact-consumer-required' }] of races) {
  test(`a pending file snapshot is removed when ${name}`, async (t) => {
    const workspace = await fs.mkdtemp(join(tmpdir(), 'dsh-im-consumer-race-'));
    const sourcePath = join(workspace, 'result.txt');
    const content = Buffer.from('Keep the original result file intact.\n');
    const registry = new OutboundArtifactRegistry();
    const controller = new AbortController();
    const session = {
      header: { id: SESSION_ID, cwd: workspace },
      events: [
        { type: 'turn/start', data: { turn: TURN } },
        { type: 'user/message', data: { turn: TURN, source: { rpcId: RPC_ID } } },
      ],
    };
    const releaseConsumer = registry.openConsumer(SESSION_ID, RPC_ID);
    for (const event of session.events) registry.observeSessionEvent(session, event);
    await fs.writeFile(sourcePath, content);

    const copied = Promise.withResolvers();
    const resume = Promise.withResolvers();
    const copyFile = fs.copyFile;
    let snapshotPath;
    let staging;
    const copyMock = t.mock.method(fs, 'copyFile', async (...args) => {
      await copyFile(...args);
      snapshotPath = args[1];
      copied.resolve();
      await resume.promise;
    });
    syncBuiltinESMExports();

    try {
      staging = registry.stage({ path: 'result.txt' }, {
        agent: { session },
        callId: 'call-copy-race',
        signal: controller.signal,
      });
      await Promise.race([
        copied.promise,
        staging.then(() => assert.fail('stage completed before its snapshot copy was paused')),
      ]);
      assert.notEqual(snapshotPath, sourcePath);
      assert.deepEqual(await fs.readFile(snapshotPath), content);

      invalidateConsumer({ registry, session, releaseConsumer, controller });
      resume.resolve();

      await assert.rejects(staging, expectedError);
      await assert.rejects(fs.stat(snapshotPath), { code: 'ENOENT' });
      assert.deepEqual(await fs.readFile(sourcePath), content);
      assert.deepEqual(registry.take(SESSION_ID, TURN), []);
      assert.deepEqual(registry.take(SESSION_ID, TURN + 1), []);
    } finally {
      resume.resolve();
      await staging?.catch(() => undefined);
      copyMock.mock.restore();
      syncBuiltinESMExports();
      releaseConsumer();
      registry.clear();
      if (snapshotPath) await fs.rm(snapshotPath, { force: true });
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
}
