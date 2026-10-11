import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OUTBOUND_ARTIFACT_TOOL,
  OutboundArtifactRegistry,
  installOutboundArtifactTool,
} from '../src/channels/shared/semantic/artifact.mjs';

function fixture(t) {
  const registry = new OutboundArtifactRegistry();
  t.after(() => registry.clear());
  const listeners = new Map();
  let context;
  assert.equal(installOutboundArtifactTool({
    tools: { register() {} },
    systemPrompt: { context(value) { context = value; } },
    on(name, callback, options) { listeners.set(name, { callback, options }); },
  }, { registry }), true);
  const agent = { session: { id: 'session-prompt', events: [] } };
  const append = (type, data) => {
    const event = { type, data };
    agent.session.events.push(event);
    listeners.get('session/event').callback(agent.session, event);
  };
  const claim = (rpcId, turn, claimingAgent = agent) => {
    listeners.get('agent/inbox/claimed').callback({
      agent: claimingAgent,
      message: { source: { rpcId } },
      turn,
    });
  };
  const guidance = (assembly = { agent }) => context.text(assembly);
  return { registry, listeners, agent, append, claim, guidance };
}

test('IM file guidance is ready before the first durable user message', (t) => {
  const fx = fixture(t);
  fx.registry.openConsumer(fx.agent.session.id, 'unprefixed-prompt-id');
  assert.equal(fx.guidance(), '');
  fx.append('turn/start', { turn: 1 });
  assert.equal(fx.guidance(), '');

  // DSH's preStep claims messages, assembles the prompt, then commits the
  // resulting user messages. Waiting for user/message misses the first step.
  fx.claim('unprefixed-prompt-id', 1);
  assert.equal(fx.agent.session.events.some((event) => event.type === 'user/message'), false);
  assert.match(fx.guidance(), new RegExp(OUTBOUND_ARTIFACT_TOOL));
  assert.equal(fx.listeners.get('agent/inbox/claimed').options.global, true);

  fx.append('user/message', { source: { rpcId: 'unprefixed-prompt-id' } });
  assert.match(fx.guidance(), /Existing files can be sent directly/);
  fx.append('turn/end', { turn: 1 });
  assert.equal(fx.guidance(), '');
});

test('a queued IM consumer does not add guidance to the active GUI turn', (t) => {
  const fx = fixture(t);
  fx.registry.openConsumer(fx.agent.session.id, 'im-pending');
  fx.append('turn/start', { turn: 1 });
  fx.claim('web-current', 1);
  assert.equal(fx.guidance(), '');
  fx.append('user/message', { source: { rpcId: 'web-current' } });
  assert.equal(fx.guidance(), '');
  fx.append('turn/end', { turn: 1 });

  fx.append('turn/start', { turn: 2 });
  fx.claim('im-pending', 2);
  assert.match(fx.guidance(), new RegExp(OUTBOUND_ARTIFACT_TOOL));
  fx.append('turn/end', { turn: 2 });
  fx.append('turn/start', { turn: 3 });
  fx.claim('web-next', 3);
  assert.equal(fx.guidance(), '');
});

test('only a live consumer for the claimed session and current turn adds guidance', (t) => {
  const fx = fixture(t);
  const close = fx.registry.openConsumer(fx.agent.session.id, 'im-owner');
  fx.append('turn/start', { turn: 1 });

  fx.claim('im-owner', 2);
  assert.equal(fx.guidance(), '');
  fx.claim('im-owner', 1, { session: { id: 'other-session', events: fx.agent.session.events } });
  assert.equal(fx.guidance(), '');
  fx.claim('im-looking-but-unregistered', 1);
  assert.equal(fx.guidance(), '');
  fx.claim('im-owner', 1);
  assert.match(fx.guidance(), new RegExp(OUTBOUND_ARTIFACT_TOOL));
  assert.equal(fx.guidance({}), '');

  close();
  assert.equal(fx.guidance(), '');
  fx.claim('im-owner', 1);
  assert.equal(fx.guidance(), '');
});

test('ended or disposed sessions cannot restore guidance through a late claim', (t) => {
  const fx = fixture(t);
  fx.registry.openConsumer(fx.agent.session.id, 'im-owner');
  fx.append('turn/start', { turn: 1 });
  fx.claim('im-owner', 1);
  assert.match(fx.guidance(), new RegExp(OUTBOUND_ARTIFACT_TOOL));
  fx.append('turn/end', { turn: 1 });
  fx.claim('im-owner', 1);
  assert.equal(fx.guidance(), '');

  fx.append('turn/start', { turn: 2 });
  fx.claim('im-owner', 2);
  assert.match(fx.guidance(), new RegExp(OUTBOUND_ARTIFACT_TOOL));
  fx.listeners.get('session/disposed').callback(fx.agent.session);
  fx.claim('im-owner', 2);
  assert.equal(fx.guidance(), '');
});
