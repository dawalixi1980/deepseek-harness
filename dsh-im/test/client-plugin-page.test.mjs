import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { en } from '../plugin-src/client/i18n.js';
import { IM_MAIN_PANEL_ID, installImPluginPage } from '../plugin-src/client/plugin-page.js';

const { act, create } = TestRenderer;
const packageName = '@xmanrui/dsh-im';
const bundle = { kind: 'bundle', pkg: { name: packageName } };
const flush = () => new Promise((resolve) => setImmediate(resolve));

function slotLedger(ready) {
  const declarations = new Set(ready ? ['main', 'plugins.detail.actions'] : []);
  const entries = new Map();
  const waiting = new Set();
  return {
    entries,
    waiting,
    inject(name, install) {
      const item = { name, install, cleanup: undefined };
      waiting.add(item);
      if (declarations.has(name)) item.cleanup = install();
      return () => { waiting.delete(item); item.cleanup?.(); };
    },
    register(options, component) {
      assert.ok(declarations.has(options.name));
      assert.ok(!entries.has(options.name), 'no duplicate registrations');
      entries.set(options.name, { options, component });
      return () => entries.delete(options.name);
    },
    declare(name, available) {
      if (available === declarations.has(name)) return;
      if (available) declarations.add(name);
      else declarations.delete(name);
      for (const item of [...waiting]) {
        if (item.name !== name) continue;
        item.cleanup?.();
        item.cleanup = available ? item.install() : undefined;
      }
    },
  };
}

async function start(t, { ready = true } = {}) {
  const root = new Context();
  const slots = slotLedger(ready);
  const selected = [];
  const opened = [];
  let renders = 0;
  root.provide('slots', slots);
  const plugin = root.plugin({
    name: 'test-plugin-page',
    apply(ctx) {
      installImPluginPage(ctx, {
        packageName,
        renderPanel: () => { renders++; return React.createElement('p', null, 'Shared IM panel'); },
      });
    },
  });
  const providers = [];
  t.after(async () => {
    await plugin.dispose();
    for (const provider of providers) await provider.dispose();
  });
  await plugin.await();
  return {
    slots, selected, opened, plugin,
    get renders() { return renders; },
    async provideNavigation() {
      const provider = root.plugin({
        name: 'test-navigation',
        apply(ctx) {
          ctx.provide('layout', { selectPanel: (id) => selected.push(id) });
          ctx.provide('pluginNavigation', { openBundle: (name) => opened.push(name) });
        },
      });
      providers.push(provider);
      await provider.await();
      await flush();
      return provider;
    },
    element(name, props = {}, language = 'zh') {
      const { options, component } = slots.entries.get(name);
      assert.equal(options.locale, 'dsh-im');
      return React.createElement(component, {
        ...options.inject(), ...props,
        t: (key) => language === 'en' ? en[key] : key,
      });
    },
  };
}

test('detail action opens the shared IM panel and returns to this plugin in both languages', async (t) => {
  const host = await start(t);
  await host.provideNavigation();
  assert.equal(host.renders, 0, 'registration must not mount the management panel');
  assert.equal(host.slots.entries.get('main').options.key, IM_MAIN_PANEL_ID);
  let renderer;
  t.after(() => act(() => renderer?.unmount()));
  act(() => { renderer = create(host.element('plugins.detail.actions', { subject: bundle })); });
  assert.deepEqual(renderer.root.findByType('button').children, ['打开 IM机器人']);
  act(() => renderer.update(host.element('plugins.detail.actions', { subject: bundle }, 'en')));
  const open = renderer.root.findByType('button');
  assert.equal(open.props.type, 'button');
  assert.deepEqual(open.children, ['Open IM bots']);
  act(() => open.props.onClick());
  assert.deepEqual(host.selected, [IM_MAIN_PANEL_ID]);
  act(() => renderer.update(host.element('main', {}, 'en')));
  assert.equal(host.renders, 1);
  assert.deepEqual(renderer.root.findByType('p').children, ['Shared IM panel']);
  const back = renderer.root.findByType('button');
  assert.equal(back.children.at(-1), 'Back to plugin details');
  act(() => back.props.onClick());
  assert.deepEqual(host.opened, [packageName]);
});

test('the action is limited to dsh-im bundle and component details', async (t) => {
  const host = await start(t);
  await host.provideNavigation();
  let renderer;
  t.after(() => act(() => renderer?.unmount()));
  for (const subject of [undefined, { kind: 'item', id: packageName },
    { kind: 'bundle', pkg: { name: '@other/plugin' } },
    { kind: 'row', pkg: bundle.pkg, row: { moduleName: '@other/plugin' } }]) {
    act(() => { renderer = create(host.element('plugins.detail.actions', { subject })); });
    assert.equal(renderer.toJSON(), null);
    act(() => renderer.unmount());
  }
  const subject = { kind: 'row', pkg: bundle.pkg, row: { moduleName: packageName } };
  act(() => { renderer = create(host.element('plugins.detail.actions', { subject })); });
  assert.equal(renderer.root.findAllByType('button').length, 1);
});

test('optional services can arrive late and withdrawing navigation removes both entries', async (t) => {
  const host = await start(t);
  assert.equal(host.slots.entries.size, 0);
  const navigation = await host.provideNavigation();
  assert.equal(host.slots.entries.size, 2);
  await navigation.dispose();
  await flush();
  assert.equal(host.slots.entries.size, 0);
  assert.equal(host.slots.waiting.size, 0);
});

test('slot withdrawal and plugin disposal cancel active registrations and pending waits', async (t) => {
  const host = await start(t, { ready: false });
  await host.provideNavigation();
  assert.equal(host.slots.entries.size, 0);
  host.slots.declare('main', true);
  assert.equal(host.slots.entries.size, 1);
  host.slots.declare('plugins.detail.actions', true);
  assert.equal(host.slots.entries.size, 2);
  host.slots.declare('main', false);
  assert.equal(host.slots.entries.size, 0);
  host.slots.declare('main', true);
  assert.equal(host.slots.entries.size, 2);
  host.slots.declare('plugins.detail.actions', false);
  await host.plugin.dispose();
  host.slots.declare('plugins.detail.actions', true);
  assert.equal(host.slots.entries.size, 0);
  assert.equal(host.slots.waiting.size, 0);
});
