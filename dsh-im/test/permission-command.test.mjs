import assert from 'node:assert/strict';
import test from 'node:test';
import { isPermissionCommand, runPermissionCommand } from '../src/channels/shared/permission-command.mjs';
import { COMMAND_LIST_TTL_MS } from '../src/channels/shared/command-list-snapshots.mjs';
import { setImHostLanguage } from '../src/channels/shared/i18n.mjs';

function fixture() {
  let sessionId = 'session-one';
  let currentValue = 'workspace-write';
  let options = [
    { value: 'workspace-write', name: 'workspace-write' },
    { value: 'danger-full-access', description: 'Full file access without approval prompts.' },
    { value: 'auto' },
  ];
  const calls = [];
  const session = {
    permissions: async () => ({ currentValue, options }),
    executeCommand: async (line, request) => {
      calls.push({ line, request });
      const id = line.slice('/permission '.length);
      if (!options.some((item) => item.value === id)) {
        return { result: { kind: 'error', text: `unknown preset "${id}"` } };
      }
      currentValue = id;
      return { result: { kind: 'success', text: `preset ${id}` } };
    },
  };
  const state = { sessionFor: () => sessionId };
  const harness = { workspaceSession: (id, key) => {
    assert.equal(id, sessionId);
    assert.ok(key);
    return session;
  } };
  return {
    calls, session, state, harness,
    bind: (id) => { sessionId = id; },
    catalog: (items) => { options = items; },
    current: (id) => { currentValue = id; },
    run: (text, opts = {}, key = 'chat') => runPermissionCommand(text, harness, state, key, opts),
  };
}

test('permission command boundaries and syntax keep malformed requests local', async () => {
  for (const text of ['/permission', ' /PERMISSION 2 ', '/permissionlist extra']) assert.ok(isPermissionCommand(text));
  for (const text of [null, '', '/permissions', '/permissionx', 'hello /permission']) assert.equal(isPermissionCommand(text), false);
  const f = fixture();
  for (const text of ['/permission a b', '/permissionlist 1', '/permission --default', '/permission custom', '/permission id:abc']) {
    assert.match((await f.run(text)).message, /用法/);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(await f.run('hello'), null);
});

test('permission commands reject media and never create a missing session', async () => {
  const f = fixture();
  for (const opts of [{ hasImages: true }, { hasFiles: true }]) {
    assert.match((await f.run('/permission 2', opts)).message, /纯文字/);
  }
  f.bind(null);
  for (const command of ['/permission', '/permissionlist', '/permission auto']) {
    assert.match((await f.run(command)).message, /尚未绑定会话/);
  }
  assert.equal(f.calls.length, 0);
});

test('numbered list is Host-owned and full access switches in one invocation', async () => {
  const f = fixture();
  const listed = await f.run('/permissionlist');
  assert.match(listed.message, /1\. workspace-write ✓ 当前/);
  assert.match(listed.message, /2\. danger-full-access — 完全文件访问，不再请求审批/);
  const response = await f.run('/permission 2', { pendingInteraction: true });
  assert.match(response.message, /已切换为：danger-full-access/);
  assert.match(response.message, /恢复工作区权限/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].line, '/permission danger-full-access');
  assert.ok(f.calls[0].request.signal instanceof AbortSignal);
  assert.match((await f.run('/permission')).message, /当前会话权限：danger-full-access/);
});

test('a query reflects external changes without replacing the displayed number mapping', async () => {
  const f = fixture();
  await f.run('/permissionlist');
  f.catalog([{ value: 'auto' }, { value: 'workspace-write' }, { value: 'danger-full-access' }]);
  f.current('auto');
  assert.match((await f.run('/permission')).message, /当前会话权限：auto/);
  await f.run('/permission 2');
  assert.equal(f.calls[0].line, '/permission danger-full-access');
  await f.run('/permissionlist');
  await f.run('/permission 2');
  assert.equal(f.calls[1].line, '/permission workspace-write');
});

test('numeric selection requires the same bot, conversation and bound session', async () => {
  const f = fixture();
  assert.match((await f.run('/permission 2')).message, /先执行 \/permissionlist/);
  await f.run('/permissionlist');
  assert.match((await f.run('/permission 2', {}, 'other-chat')).message, /先执行/);
  const other = { sessionFor: () => 'session-one' };
  assert.match((await runPermissionCommand('/permission 2', f.harness, other, 'chat')).message, /先执行/);
  f.bind('session-two');
  assert.match((await f.run('/permission 2')).message, /先执行/);
  assert.equal(f.calls.length, 0);
});

test('expired lists and invalid numbers never invoke a mutation', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const f = fixture();
  await f.run('/permissionlist');
  for (const number of ['0', '4', '99999999999999999999']) {
    assert.match((await f.run(`/permission ${number}`)).message, /序号无效/);
  }
  t.mock.timers.tick(COMMAND_LIST_TTL_MS);
  assert.match((await f.run('/permission 2')).message, /先执行/);
  assert.equal(f.calls.length, 0);
});

test('removed presets are rejected by Host and never silently remapped', async () => {
  const f = fixture();
  await f.run('/permissionlist');
  f.catalog([{ value: 'workspace-write' }, { value: 'auto' }]);
  assert.match((await f.run('/permission 2')).message, /不存在或已不可用/);
  assert.equal(f.calls[0].line, '/permission danger-full-access');
});

test('full and numeric IDs work without a list and preserve case', async () => {
  const f = fixture();
  f.catalog([{ value: 'MyPreset' }, { value: '123' }]);
  await f.run('/PeRmIsSiOn MyPreset');
  await f.run('/permission id:123');
  assert.deepEqual(f.calls.map((call) => call.line), ['/permission MyPreset', '/permission 123']);
});

test('custom is display-only and malformed or duplicated options do not create wrong numbers', async () => {
  const f = fixture();
  f.current('custom');
  f.catalog([{ value: 'custom' }, { value: 'auto' }, { value: 'auto' }]);
  const listed = await f.run('/permissionlist');
  assert.match(listed.message, /当前会话权限：custom/);
  assert.match(listed.message, /1\. auto/);
  assert.doesNotMatch(listed.message, /2\./);
  f.catalog([{ value: 'bad\nID' }]);
  assert.match((await f.run('/permissionlist')).message, /暂时无法获取/);
});

test('a binding changed during a read discards the list', async () => {
  const f = fixture();
  f.session.permissions = async () => {
    f.bind('new-session');
    return { currentValue: 'auto', options: [{ value: 'auto' }] };
  };
  assert.match((await f.run('/permissionlist')).message, /会话已变化/);
  assert.match((await f.run('/permission 1')).message, /先执行/);
  assert.equal(f.calls.length, 0);
});

test('Host rejection, unsupported command and uncertain writes never claim success or retry', async () => {
  const f = fixture();
  for (const outcome of [
    { result: { kind: 'error', text: 'Auto admission denied' } },
    undefined,
    { result: { kind: 'unrecognized' } },
  ]) {
    let calls = 0;
    f.session.executeCommand = async () => { calls++; return outcome; };
    assert.doesNotMatch((await f.run('/permission auto')).message, /已切换为/);
    assert.equal(calls, 1);
  }
  f.session.executeCommand = async () => { throw new Error('token=secret'); };
  const response = await f.run('/permission auto');
  assert.match(response.message, /未能确认/);
  assert.doesNotMatch(response.message, /secret/);
});

test('cancellation before execution prevents changes', async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await f.run('/permission auto', { signal: controller.signal });
  assert.equal(f.calls.length, 0);
});

test('English permission replies and help hints use the existing translator', async () => {
  const f = fixture();
  setImHostLanguage('en');
  try {
    for (const command of ['/permissionlist', '/permission 2', '/permission', '/permission extra args']) {
      assert.doesNotMatch((await f.run(command)).message, /\p{Script=Han}/u);
    }
  } finally { setImHostLanguage('zh'); }
});
