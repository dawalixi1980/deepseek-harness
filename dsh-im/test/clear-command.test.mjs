import assert from 'node:assert/strict';
import test from 'node:test';

import { runClearCommand } from '../src/channels/shared/clear-command.mjs';

function state(sessionId = 'session-one') {
  return { sessionFor: () => sessionId };
}

test('/clear validates plain text and preserves the bound Session', async () => {
  assert.equal(await runClearCommand('hello', {}, state(), 'direct:one'), null);
  assert.match((await runClearCommand('/clear now', {}, state(), 'direct:one')).message, /不带参数/);
  assert.match((await runClearCommand('/clear', {}, state(), 'direct:one', { hasFiles: true })).message, /不可附带/);
  assert.match((await runClearCommand('/clear', {}, state(null), 'direct:one')).message, /还没有可清空/);

  const calls = [];
  const result = await runClearCommand('/CLEAR', {
    executeCommand: async (...args) => {
      calls.push(args);
      return { commandId: 'command-one', result: { kind: 'success', text: 'Cleared.' } };
    },
  }, state(), 'direct:one');
  assert.match(result.message, /上下文已清空/);
  assert.match(result.message, /绑定和历史记录仍保留/);
  assert.deepEqual(calls, [['session-one', '/clear', {}]]);
});

test('/clear reports unsupported, busy, and failed Host outcomes without rebinding', async () => {
  assert.match((await runClearCommand('/clear', {
    executeCommand: async () => undefined,
  }, state(), 'direct:one')).message, /Host 不支持 \/clear/);
  assert.match((await runClearCommand('/clear', {
    executeCommand: async () => assert.fail('busy clear must not reach Host'),
  }, state(), 'direct:one', { pendingInteraction: true })).message, /等待交互/);
  assert.match((await runClearCommand('/clear', {
    executeCommand: async () => { throw Object.assign(new Error('busy'), { code: 'agent-busy' }); },
  }, state(), 'direct:one')).message, /等待交互/);
  assert.match((await runClearCommand('/clear', {
    executeCommand: async () => ({ commandId: 'command-one', result: { kind: 'error', text: 'Nope' } }),
  }, state(), 'direct:one')).message, /未修改/);
});
