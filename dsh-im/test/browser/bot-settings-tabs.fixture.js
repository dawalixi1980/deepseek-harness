// Bundle with esbuild and open in a browser with #app and #result containers.
// Add ?en for English. Uses the real settings page with in-memory RPC responses.
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { DeliveryTargetSettingsPage } from '../../plugin-src/client/delivery-settings.js';
import { installImStyles } from '../../plugin-src/client/styles.js';
import { en, setImTranslator } from '../../plugin-src/client/i18n.js';

const english = new URLSearchParams(location.search).has('en');
if (english) setImTranslator((key) => en[key] ?? key);
installImStyles();
const account = { botId: 'tabs-fixture', botName: 'Demo bot', connected: true, voice: null };
const errors = [];
window.addEventListener('error', (event) => errors.push(event.message));
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)));
const app = document.getElementById('app');
const root = createRoot(app);
const render = (channel = 'feishu') => root.render(React.createElement('div', {
  className: 'dim-page dim-panel', style: { padding: 0, border: 0 },
},
  React.createElement(DeliveryTargetSettingsPage, {
    channel, account, onBack() {},
    rpcCall: async () => ({ ok: true, value: { targets: [] } }),
    accessRpcCall: async () => ({ ok: true, value: { bots: [account] } }),
  })));
render();

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
async function until(predicate, message) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await tick();
  }
}
const strip = () => app.querySelector('[role="tablist"]');
const tabs = () => [...(strip()?.querySelectorAll('[role="tab"]') ?? [])];
const arrows = () => [...app.querySelectorAll('.dim-botSettingsScroll')];
const selected = () => strip().querySelector('[aria-selected="true"]');
function fullyVisible(tab = selected()) {
  const bounds = tab.getBoundingClientRect();
  const viewport = strip().getBoundingClientRect();
  return bounds.left >= viewport.left - 1 && bounds.right <= viewport.right + 1;
}
async function resize(width) {
  app.style.width = `${width}px`;
  await tick();
  await until(() => fullyVisible(), `Selected tab was clipped after resize to ${width}px`);
  const bar = app.querySelector('.dim-botSettingsTabsBar').getBoundingClientRect();
  assert(bar.width <= width + 1, 'Tab bar overflowed its container');
}
async function press(key, expectedIndex) {
  const tab = selected();
  tab.focus({ preventScroll: true });
  tab.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  await until(() => selected() === tabs()[expectedIndex] && fullyVisible(), `${key} did not reveal its destination`);
  assert(document.activeElement === selected(), `${key} lost keyboard focus`);
  assert(tabs().filter((entry) => entry.tabIndex === 0).length === 1, 'Tabs have multiple keyboard entry points');
}

async function run() {
  await until(() => tabs().length === 5, 'Settings did not mount');
  await resize(760);
  await until(() => arrows().length === 0, 'Wide layout should not have scroll buttons');
  await resize(280);
  await until(() => arrows().length === 2, 'Narrow layout has no scroll buttons');
  assert(arrows()[0].disabled && !arrows()[1].disabled, 'Initial arrow state is wrong');
  arrows()[1].click();
  await until(() => strip().scrollLeft > 0 && !arrows()[0].disabled, 'Right button did not scroll');
  assert(selected() === tabs()[0], 'Scrolling must not change the settings panel');
  arrows()[0].click();
  await until(() => strip().scrollLeft === 0 && arrows()[0].disabled, 'Left button did not scroll back');
  await press('End', 4);
  await until(() => arrows()[1].disabled, 'Right button did not disable at the end');
  await press('ArrowRight', 0);
  await press('ArrowLeft', 4);
  await press('Home', 0);
  tabs()[4].click();
  await until(() => selected() === tabs()[4] && fullyVisible(), 'Click did not reveal the whole voice tab');
  for (const width of [320, 420, 760, 280]) await resize(width);
  const naturalWidth = app.querySelector('.dim-botSettingsTabsList').scrollWidth;
  await resize(naturalWidth + 2);
  await until(() => arrows().length === 0, 'Arrows stayed visible even though the tabs fit');
  await resize(280);
  await until(() => arrows().length === 2 && fullyVisible(), 'Arrows did not return on shrink');
  if (english) assert(arrows().every((arrow) => arrow.getAttribute('aria-label').startsWith('Scroll settings')), 'Scroll buttons were not translated');
  render('weixin');
  await until(() => tabs().length === 2 && arrows().length === 0, 'Two-tab channel retained overflow controls');
  render();
  await until(() => tabs().length === 5 && arrows().length === 2, 'Feishu tabs did not restore');
  await press('End', 4);
  await resize(320);
  assert(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
  document.body.dataset.result = 'passed';
  document.getElementById('result').textContent = `Passed (${english ? 'English' : 'Chinese'}): scroll buttons, edge states, click reveal, keyboard navigation and focus, container resizing (280–760px), exact fit, channel changes.`;
}
run().catch((error) => {
  document.body.dataset.result = 'failed';
  document.getElementById('result').textContent = error.stack;
});
