/**
 * dsh-restart —— client 半加载测试。
 *
 * 为什么必须有这个测试：
 *   `node --check lib/client.js` 只验证**语法**，查不出模块求值期的
 *   暂时性死区（TDZ）错误。师兄插件 dsh-plugin-url 真出过事故：CONTRIBUTION
 *   在求值时调用 codec()，而 codec 引用了用 `const` 声明在其后方的 identity，
 *   于是抛 "Cannot access 'identity' before initialization"，web boot 该项无法
 *   激活，整个桌面端「无法启动或已意外停止」。
 *
 *   本测试**真实构造** bundle（执行 factory）并**真实渲染**组件（含 effect 重渲染），
 *   因此能兜住 TDZ、codec 形状、jsx 第三参数、禁用态与文案。
 *
 *   注意：这里**绝不**执行真的 restart —— face 是替身，host 半在
 *   test/host.test.mjs 与 test/validate-typert-contract.mjs 里钉。
 *
 * 用法：
 *   node test/load-client.mjs [bundle 路径]
 * 默认测试 ../lib/client.js；也可指向已安装副本做交叉验证。
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = resolve(process.argv[2] ?? join(here, '..', 'lib', 'client.js'));

const failures = [];
let total = 0;
function record(ok, label, detail) {
  total += 1;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail === undefined ? '' : ' -> ' + detail));
  if (!ok) failures.push(label + (detail === undefined ? '' : ': ' + detail));
}
function check(label, fn) {
  try {
    const out = fn();
    // 允许 async 断言：把 promise 的失败也计入结果，而不是静默通过
    if (out !== null && typeof out === 'object' && typeof out.then === 'function') {
      pendingChecks.push(out.then(() => record(true, label), (err) => record(false, label, err?.message ?? String(err))));
      return;
    }
    record(true, label);
  } catch (err) {
    record(false, label, err?.message ?? String(err));
  }
}
/** async 断言的收尾队列（在汇总前 await）。 */
const pendingChecks = [];
/** 让 effect 里发起的 promise 落定（模拟真实 React 的重渲染前等待）。 */
async function flush() {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

console.log('bundle: ' + bundlePath);

// ── 1. 真实执行模块体（这一步捕获模块求值期错误）─────────────────────────
console.log('\n[1] 模块求值 / load() 注册');

let captured;
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      captured = entry;
    },
  },
};

// 样式注入所需的 DOM 垫片（本 bundle 会 document.getElementById）
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ set textContent(v) {}, id: '' }),
  head: { appendChild() {} },
};

let evalError;
try {
  await import(pathToFileURL(bundlePath).href);
} catch (err) {
  evalError = err;
}

if (evalError !== undefined) {
  record(false, '模块求值', evalError.message);
  console.log('\n结果：client bundle 求值失败，禁止安装。');
  process.exit(1);
}
record(true, '模块求值');

check('已注册到 __ModuleLoader__', () => {
  if (captured === undefined) throw new Error('factory 未被调用 / load() 未执行');
});
check('id 为 dsh-restart', () => {
  if (captured?.id !== 'dsh-restart') throw new Error('id = ' + captured?.id);
});

// ── 2. 构造 bundle（提供 fake react）─────────────────────────────────────
// 本 bundle 的 CONTRIBUTION / codec / identity 都位于 factory 内部，因此 TDZ 在
// 「构造」这一步才暴露。DSH 启动时正是这样调用 factory，所以它报的是 "import failed"。
console.log('\n[2] factory 构造与导出（TDZ 在此暴露）');

/** 可预置初值的 fake hooks：单次渲染即可驱动任意分支。
 *  runEffects=true 时**真正执行** useEffect 回调，等价于真实挂载
 *  —— 组件挂在 effect 里的取数逻辑（如 face.restartSupport()）才会暴露错误。
 *
 *  keepState/连续渲染：状态按「hook 序号」存，setter 会**真的写回**，
 *  因此连续渲染两次就能看到 effect 里异步取回的数据（模拟真实 React 的重渲染）。 */
function makeReact(seed = [], options = {}) {
  // 每次渲染都是新的一轮：hook 游标归零，状态按「hook 序号」存，
  // 这样才能像真实 React 那样在多次渲染间保持状态。
  const store = [];
  let cursor = 0;
  const api = {
    useState: (init) => {
      const at = cursor++;
      if (store[at] === undefined) store[at] = at < seed.length ? seed[at] : init;
      const setter = (value) => {
        store[at] = typeof value === 'function' ? value(store[at]) : value;
      };
      return [store[at], setter];
    },
    useCallback: (fn) => fn,
    useEffect: (fn) => { if (options.runEffects === true) fn(); },
    useMemo: (fn) => fn(),
    createElement: (type, props, ...kids) => ({ type, props, children: kids }),
    /** 开始新一次渲染：hook 游标归零（状态仍按 hook 序号保留）。 */
    __beginRender: () => { cursor = 0; },
  };
  return api;
}

/** 用同一实例连续渲染组件（模拟真实 React 的重渲染，状态跨渲染保留）。 */
function renderWith(reactApi, Component, props) {
  if (typeof reactApi?.__beginRender === 'function') reactApi.__beginRender();
  return Component(props);
}

/**
 * 忠实还原 react/jsx-runtime 的调用约定：jsx(type, props, key)，
 * **第三个参数是 key，不是 children**。
 *
 * 事故记录（师兄插件的坑 7）：曾经把文字写成 `jsx("button", {...}, "文字")`，
 * 于是文字被当成 key 吞掉，渲染出一个**空胶囊**（数据完好、只是不显示）。
 * 早期的假 jsx 忽略第三个参数、children 又取自 props.children，恰好"帮忙掩盖"
 * 了这个错误，所以这里必须让假 runtime 与真实行为一致：把第三个参数当 key，
 * 且**不接受**第三个参数作为子节点。
 */
function makeJsxRuntime() {
  const jsx = (type, props, key) => ({
    type,
    key: key === undefined ? (props ?? {}).key : key,
    props: props ?? {},
    children: (props ?? {}).children,
  });
  return { jsx, jsxs: jsx, Fragment: Symbol.for('react.fragment') };
}

/** 用固定 require 表构造一份 module exports（每次调用都真实执行模块体）。 */
function build(seed = [], options = {}) {
  let reactApi;
  const mod = captured.factory((spec) => {
    if (spec === 'react') { reactApi = makeReact(seed, options); return reactApi; }
    if (spec === 'react/jsx-runtime') return makeJsxRuntime();
    throw new Error('意料之外的 require：' + spec);
  });
  return { reactApi, mod };
}

let mod;
check('factory 可构造（模块求值期不踩 TDZ）', () => {
  mod = build().mod;
});
if (mod === undefined) {
  console.log('\n结果：构造失败。');
  process.exit(1);
}

check('导出 apply', () => {
  if (typeof mod.apply !== 'function') throw new Error('apply 缺失');
});
check('导出 inject 数组', () => {
  if (!Array.isArray(mod.inject)) throw new Error('inject 不是数组');
});
check('client 半 inject 恰为 slots / locale / remote（不再需要 sessions）', () => {
  const expected = ['slots', 'locale', 'remote'];
  if (JSON.stringify(mod.inject) !== JSON.stringify(expected)) throw new Error('inject = ' + JSON.stringify(mod.inject));
  if (mod.inject.includes('sessions')) throw new Error('还挂着用不到的 sessions');
});
check('导出 RestartAction', () => {
  if (typeof mod.RestartAction !== 'function') throw new Error('RestartAction 缺失');
});

// ── 3. apply()：注册远程贡献、文案与侧边栏插槽 ───────────────────────────
console.log('\n[3] apply() 注册');

/**
 * 造一份隔离的 fake ctx：每次 apply() 都拿到自己的捕获箱，
 * 这样「有 remote 服务」与「没有 remote 服务」两组断言不会互相踩。
 */
function buildCtx(getImpl) {
  const captured = { mounted: undefined, locale: undefined, bound: undefined, slot: undefined, component: undefined };
  const ctx = {
    effect: (fn) => {
      fn();
      return () => {};
    },
    locale: {
      register: (ns, dict) => { captured.locale = { ns, dict }; },
      bind: (ns) => { captured.bound = ns; return (key) => key; },
    },
    remote: {
      $mount: (contribution) => {
        captured.mounted = contribution;
        return Promise.resolve();
      },
    },
    get: getImpl,
    slots: {
      inject: (name, fn) => fn(),
      register: (desc, component) => {
        captured.slot = desc;
        captured.component = component;
      },
    },
  };
  return { ctx, captured };
}

/** host 侧的假 remote 服务（只给「有服务」那一组断言用）。 */
let remoteService;
const primary = buildCtx((name) => (name === 'remote.appRestart' ? remoteService : undefined));

check('apply() 不抛异常', () => {
  mod.apply(primary.ctx);
});
check('挂载了远程贡献', () => {
  if (primary.captured.mounted === undefined) throw new Error('$mount 未被调用');
});
check('远程贡献 package 为 dsh-restart', () => {
  if (primary.captured.mounted?.package !== 'dsh-restart') throw new Error('package = ' + primary.captured.mounted?.package);
});
check('远程描述符线名恰为 [restart, restartSupport]', () => {
  const mounted = primary.captured.mounted;
  if (!Array.isArray(mounted?.descriptors)) throw new Error('descriptors 不是数组');
  const methods = mounted.descriptors.map((d) => d.method).sort();
  const expected = ['restart', 'restartSupport'];
  if (JSON.stringify(methods) !== JSON.stringify(expected)) throw new Error('method = ' + JSON.stringify(methods));
  for (const descriptor of mounted.descriptors) {
    if (descriptor.namespace !== 'appRestart') throw new Error(descriptor.id + ' 的 namespace = ' + descriptor.namespace);
  }
});
/**
 * TDZ 的第二道防线（光靠「构造 factory」查不出来）：
 * codec 写成 `create: () => ({ parse: identity })` 时，构造 CONTRIBUTION 只是
 * **捕获** identity，并不读取它 —— 所以把 `const identity` 挪到 CONTRIBUTION
 * 之后，模块求值照样成功，直到 shell 按 `codec.create().parse(value)` 走一遍
 * 描述符才真的读 identity，那时才炸。这里把那一刻提前到测试里。
 */
check('每个远程描述符的 codec.create() 都能真的取到 identity（client 侧 TDZ 回归）', () => {
  const descriptors = primary.captured.mounted?.descriptors;
  if (!Array.isArray(descriptors)) throw new Error('descriptors 不是数组');
  for (const descriptor of descriptors) {
    if (descriptor.result?.mode !== 'strict') throw new Error(descriptor.id + ' 的 codec.mode = ' + descriptor.result?.mode);
    if (typeof descriptor.result?.typeSymbol !== 'string' || descriptor.result.typeSymbol.length === 0) {
      throw new Error(descriptor.id + ' 的 codec 缺 typeSymbol');
    }
    const created = descriptor.result.create();
    if (typeof created?.parse !== 'function') throw new Error(descriptor.id + ' result.create() 没返回带 parse() 的 schema');
    const probe = { supported: true, reason: '' };
    if (created.parse(probe) !== probe) throw new Error(descriptor.id + ' 的 parse 没有透传（identity 丢了）');
    for (const parameter of descriptor.parameters) {
      const value = parameter.codec.create().parse('probe');
      if (value !== 'probe') throw new Error(descriptor.id + ' parameter ' + parameter.name + ' 的 parse 没有透传');
    }
  }
});
check('注册的插槽是 sidebar.footer.action', () => {
  if (primary.captured.slot === undefined) throw new Error('未注册插槽');
  if (primary.captured.slot.name !== 'sidebar.footer.action') throw new Error('name = ' + primary.captured.slot.name);
});
check('插槽 id 为 app-restart', () => {
  if (primary.captured.slot?.id !== 'app-restart') throw new Error('id = ' + primary.captured.slot?.id);
});
check('注册的组件就是导出的 RestartAction', () => {
  if (primary.captured.component !== mod.RestartAction) throw new Error('注册的组件与导出不一致');
});
check('插槽 face 只暴露 restartSupport / restart', () => {
  if (typeof primary.captured.slot?.inject !== 'function') throw new Error('插槽没有 inject（face 工厂）');
  const face = primary.captured.slot.inject();
  if (typeof face?.restartSupport !== 'function') throw new Error('face.restartSupport 缺失');
  if (typeof face?.restart !== 'function') throw new Error('face.restart 缺失');
  const extra = Object.keys(face).filter((key) => key !== 'restartSupport' && key !== 'restart');
  if (extra.length > 0) throw new Error('face 上多了线名：' + JSON.stringify(extra));
});
check('注册了 appRestart 文案命名空间（重启 / 正在重启…）', () => {
  const localeRegistered = primary.captured.locale;
  if (localeRegistered === undefined) throw new Error('locale.register 未被调用');
  if (localeRegistered.ns !== 'appRestart') throw new Error('namespace = ' + localeRegistered.ns);
  const zh = localeRegistered.dict?.zh;
  const en = localeRegistered.dict?.en;
  if (zh?.restart !== '重启') throw new Error('zh.restart = ' + zh?.restart);
  if (typeof zh?.restarting !== 'string' || zh.restarting.length === 0) throw new Error('zh 字典缺 restarting');
  if (typeof zh?.title !== 'string' || zh.title.length === 0) throw new Error('zh 字典缺 title');
  if (typeof zh?.unavailable !== 'string' || zh.unavailable.length === 0) throw new Error('zh 字典缺 unavailable');
  if (typeof en?.restart !== 'string' || en.restart.length === 0) throw new Error('en 字典缺 restart');
});
check('bind 用的也是 appRestart', () => {
  if (primary.captured.bound !== 'appRestart') throw new Error('bind = ' + primary.captured.bound);
});
check('face 会把 { ok, value } 信封解开（拿到的就是线格式）', async () => {
  remoteService = {
    restartSupport: async () => ({ ok: true, value: { supported: false, reason: '不是桌面版' } }),
    restart: async () => ({ ok: true, value: { started: true } }),
  };
  const face = primary.captured.slot.inject();
  const support = await face.restartSupport();
  if (support?.reason !== '不是桌面版') throw new Error('restartSupport 没有解开信封：' + JSON.stringify(support));
  const restarted = await face.restart();
  if (restarted?.started !== true) throw new Error('restart 没有解开信封：' + JSON.stringify(restarted));
  remoteService = undefined;
});
check('host 半缺席时 face 报出人话（而不是点了没反应）', async () => {
  // 用一份**独立**的 ctx（get 永远返回 undefined），不跟上面那条共享状态。
  const isolated = buildCtx(() => undefined);
  mod.apply(isolated.ctx);
  const face = isolated.captured.slot.inject();
  let message;
  try {
    await face.restartSupport();
  } catch (err) {
    message = err?.message ?? String(err);
  }
  if (message === undefined) throw new Error('缺服务时 restartSupport 竟然成功了');
  if (!message.includes('appRestart 服务不可用')) throw new Error('报错文案不符：' + message);
});

// ── 4. 组件渲染：宽 / 窄、可用 / 不可用、注入缺失 ────────────────────────
console.log('\n[4] 组件渲染');

/** 收集渲染树中的全部文本，用于断言。 */
function collectText(node, out) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (typeof node === 'object' && node.props !== undefined) {
    collectText(node.props.children, out);
  }
  return out;
}

/** 深度优先收集所有满足谓词的节点。 */
function findNodes(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (Array.isArray(node)) {
    for (const child of node) findNodes(child, predicate, out);
    return out;
  }
  if (typeof node === 'object') {
    if (predicate(node)) out.push(node);
    findNodes(node.props?.children, predicate, out);
  }
  return out;
}

function buttonsIn(node) {
  return findNodes(node, (item) => item.type === 'button');
}
/** 组件只应渲染一个按钮；多/少都说明树形变了，断言会认错节点。 */
function buttonOf(tree) {
  const buttons = buttonsIn(tree);
  if (buttons.length !== 1) throw new Error('按钮数量 = ' + buttons.length);
  return buttons[0];
}
function textOf(tree) {
  return collectText(tree, []).join(' | ');
}

/** 文案替身取自**真实注册的 zh 字典**：字典改了，下面的文字断言就会响。 */
const ZH = primary.captured.locale?.dict?.zh ?? {};
const t = (key) => (key in ZH ? ZH[key] : key);
/** 契约字面量：按钮文字必须是「重启」。 */
const RESTART_TEXT = '重启';

/** 记录 face 被调用情况（真 restart 绝不执行，只记次数）。 */
const calls = { restartSupport: 0, restart: 0 };
function makeFace(overrides = {}) {
  return {
    restartSupport: async () => {
      calls.restartSupport += 1;
      return { supported: true, reason: '', exe: 'E:\\dsh\\DeepSeek Harness.exe', mode: 'desktop', parentPid: 27400, selfPid: 15044 };
    },
    restart: async () => {
      calls.restart += 1;
      return { started: true, exe: 'x', helper: 'y', parentPid: 27400, selfPid: 15044 };
    },
    ...overrides,
  };
}
function resetCalls() {
  calls.restartSupport = 0;
  calls.restart = 0;
}

/**
 * 坑 7 的第一道防线：假 jsx runtime 自己必须与真实约定一致。
 * 若这里退化成"第三个参数当 children"，本文件所有文字断言都会集体假绿。
 */
check('假 jsx runtime 忠实于真实约定（第三个参数是 key，不是 children）', () => {
  const runtime = makeJsxRuntime();
  const swallowed = runtime.jsx('button', {}, '会被当成 key 吞掉的文字');
  if (swallowed.key !== '会被当成 key 吞掉的文字') throw new Error('第三个参数没有被记为 key');
  if (swallowed.children !== undefined) throw new Error('第三个参数被当成了 children —— 假 runtime 在帮忙掩盖事故');
  const kept = runtime.jsx('button', { children: '写在 props 里才可见' });
  if (kept.children !== '写在 props 里才可见') throw new Error('props.children 没有被保留');
  if (kept.key !== undefined) throw new Error('props 形态下不该凭空多出 key');
});

/** 每次构造都真实执行模块体：两次构造的 exports 必须是彼此独立的新对象。 */
check('factory 每次调用都真实求值（两份独立的 exports）', () => {
  const a = build();
  const b = build();
  if (a.mod.RestartAction === undefined) throw new Error('RestartAction 缺失');
  if (a.mod.RestartAction === b.mod.RestartAction) throw new Error('两次构造共享了同一个组件 —— 模块体被缓存了');
});

/**
 * DSH 的真实契约：slot 宿主把 inject() 的返回值**摊平**成 props
 * （不存在 props.face），owner 传进来的 wide 也在 props 上。
 * 组件写的是 `props.face ?? props`，所以摊平形态必须能渲染出按钮文字。
 */
check('摊平 props 形态（API 在顶层，无 props.face）：按钮文字是「重启」', () => {
  resetCalls();
  const { mod: seeded } = build();
  const tree = seeded.RestartAction({ ...makeFace(), t, wide: true });
  if (tree === null || tree === undefined) throw new Error('渲染返回空');
  const button = buttonOf(tree);
  const label = collectText(button, []).join('');
  if (label !== RESTART_TEXT) throw new Error('按钮文字 = ' + JSON.stringify(label));
  if (textOf(tree).trim().length === 0) throw new Error('渲染树里一个文字节点都没有（白屏）');
});

/** 宽窄语义：只有显式 false 才算收起。 */
check('wide 缺省（undefined）按展开处理，只有显式 false 才收起', () => {
  const { mod: seeded } = build();
  const wideByDefault = textOf(seeded.RestartAction({ ...makeFace(), t }));
  if (!wideByDefault.includes(RESTART_TEXT)) throw new Error('wide 缺省时没有渲染文字：' + wideByDefault);
  const collapsed = textOf(seeded.RestartAction({ ...makeFace(), t, wide: false }));
  if (collapsed.includes(RESTART_TEXT)) throw new Error('显式 wide:false 仍渲染了文字：' + collapsed);
});

/** 点击 = 直接重启（用户明确不要二次确认），且必须调 face.restart()。 */
check('点击按钮调用 face.restart()（一次，且不调别的线名）', () => {
  resetCalls();
  const face = makeFace();
  const { mod: seeded } = build();
  const tree = seeded.RestartAction({ ...face, t, wide: true });
  const button = buttonOf(tree);
  if (button.props.disabled !== false) throw new Error('可用状态下按钮却被禁用：disabled = ' + button.props.disabled);
  if (typeof button.props.onClick !== 'function') throw new Error('按钮没有 onClick');
  button.props.onClick();
  if (calls.restart !== 1) throw new Error('restart 调用次数 = ' + calls.restart);
  // 点击后立刻切到"正在重启…"，不去等 RPC 回执（host 几秒后就被杀了）
  if (button.props['data-busy'] !== 'false') throw new Error('首屏就标成了 busy');
});

/** 收起形态（侧边栏窄）：只留图标，不能残留文字。 */
check('props.wide === false：不出现「重启」文字，但图标还在', () => {
  resetCalls();
  const { mod: seeded } = build();
  const tree = seeded.RestartAction({ ...makeFace(), t, wide: false });
  if (tree === null || tree === undefined) throw new Error('渲染返回空');
  const text = textOf(tree);
  if (text.includes(RESTART_TEXT)) throw new Error('收起时仍渲染了「重启」文字：' + text);
  const svgs = findNodes(tree, (node) => node.type === 'svg');
  if (svgs.length !== 1) throw new Error('图标（svg）数量 = ' + svgs.length);
  const glyph = svgs[0];
  if (glyph.props.className !== 'RS_glyph') throw new Error('svg 的 className = ' + glyph.props.className);
  const path = glyph.props.children;
  if (path?.type !== 'path') throw new Error('图标里没有 path 子节点');
  if (typeof path.props?.d !== 'string' || path.props.d.length === 0) throw new Error('path 没有 d（图标画不出来）');
});

/**
 * 不支持时：按钮必须 **disabled**，而且**把原因显示出来**
 * ——「灰按钮 + 点了没反应」是这个插件最想避免的体验。
 */
check('restartSupport 返回 {supported:false, reason}：按钮 disabled，且页面上显示 reason', async () => {
  resetCalls();
  const reason = '当前不是 DSH 桌面版（没有检测到 dsh-desktop-host），无法重启进程。从源码跑 dsh web 时请自己重启。';
  const { reactApi, mod: seeded } = build([], { runEffects: true });
  const props = { ...makeFace({ restartSupport: async () => { calls.restartSupport += 1; return { supported: false, reason }; } }), t, wide: true };
  renderWith(reactApi, seeded.RestartAction, props); // 首屏 + effect 发起取数
  await flush();
  const tree = renderWith(reactApi, seeded.RestartAction, props); // 重渲染（状态已落定）
  const button = buttonOf(tree);
  if (button.props.disabled !== true) throw new Error('supported:false 却没禁用：disabled = ' + button.props.disabled);
  if (button.props.title !== reason) throw new Error('title 里没有原因：' + button.props.title);
  const text = textOf(tree);
  if (!text.includes(reason)) throw new Error('页面上没有显示 reason：' + text);
  if (collectText(button, []).join('').includes(reason)) throw new Error('reason 被塞进了按钮文字里');
  // 禁用态下即便有人硬点，也不许真的去重启
  button.props.onClick();
  if (calls.restart !== 0) throw new Error('禁用状态下点击仍然调用了 restart');
});

/** 支持时：按钮必须可点，且点击真的调 face.restart()。 */
check('restartSupport 返回 {supported:true}：按钮可点，点击调 face.restart()', async () => {
  resetCalls();
  const { reactApi, mod: seeded } = build([], { runEffects: true });
  const props = { ...makeFace(), t, wide: true };
  renderWith(reactApi, seeded.RestartAction, props);
  await flush();
  const tree = renderWith(reactApi, seeded.RestartAction, props);
  const button = buttonOf(tree);
  // 假 react 不看 deps，每次渲染都会跑 effect，所以这里只要求"挂载时至少探测过一次"。
  // 真实重启绝不能被触发：整个测试只允许走 face 替身。
  if (calls.restartSupport < 1) throw new Error('挂载时没有调用 restartSupport');
  if (button.props.disabled !== false) throw new Error('supported:true 却仍被禁用：disabled = ' + button.props.disabled);
  if (button.props.title !== t('title')) throw new Error('title = ' + button.props.title);
  button.props.onClick();
  if (calls.restart !== 1) throw new Error('restart 调用次数 = ' + calls.restart);
});

/** 兼容形态（props.face 包装）也不该崩：老宿主/手工挂载会这么传。 */
check('兼容 props.face 形态（渲染 + 点击都能走通）', () => {
  resetCalls();
  const face = makeFace();
  const { mod: seeded } = build();
  const tree = seeded.RestartAction({ face, t, wide: true });
  const button = buttonOf(tree);
  if (collectText(button, []).join('') !== RESTART_TEXT) throw new Error('按钮文字 = ' + collectText(button, []).join(''));
  button.props.onClick();
  if (calls.restart !== 1) throw new Error('props.face 形态下点击没有调用 face.restart()');
});

/** 完全没有注入时，要给出可见提示而不是白屏/抛错。 */
check('注入缺失时首屏不白屏、不抛错', () => {
  resetCalls();
  const { mod: seeded } = build([], { runEffects: true });
  const tree = seeded.RestartAction({ t, wide: true });
  if (tree === null || tree === undefined) throw new Error('渲染返回空');
  const button = buttonOf(tree);
  if (collectText(button, []).join('') !== RESTART_TEXT) throw new Error('按钮文字 = ' + collectText(button, []).join(''));
});

check('注入缺失时页面显示诊断提示，且按钮被禁用', async () => {
  resetCalls();
  const { reactApi, mod: seeded } = build([], { runEffects: true });
  const props = { t, wide: true };
  renderWith(reactApi, seeded.RestartAction, props);
  await flush();
  const tree = renderWith(reactApi, seeded.RestartAction, props);
  const text = textOf(tree);
  if (!text.includes('appRestart 服务不可用')) throw new Error('未出现诊断提示：' + text.slice(0, 160));
  const button = buttonOf(tree);
  if (button.props.disabled !== true) throw new Error('服务不可用时按钮没被禁用');
});

/** restartSupport 抛错（例如 host 半刚被杀）：也要落到"能看见的原因"上。 */
check('restartSupport 抛错时显示错误原因且禁用', async () => {
  resetCalls();
  const { reactApi, mod: seeded } = build([], { runEffects: true });
  const props = { ...makeFace({ restartSupport: async () => { throw new Error('boom-支持探测失败'); } }), t, wide: true };
  renderWith(reactApi, seeded.RestartAction, props);
  await flush();
  const tree = renderWith(reactApi, seeded.RestartAction, props);
  const button = buttonOf(tree);
  if (button.props.disabled !== true) throw new Error('探测失败后按钮仍可点');
  if (!textOf(tree).includes('boom-支持探测失败')) throw new Error('没有显示探测失败原因：' + textOf(tree));
});

// ── 汇总 ─────────────────────────────────────────────────────────────────
// 先等所有 async 断言（如「supported:false 时显示 reason」）落定，再判定结果。
await Promise.allSettled(pendingChecks);

console.log('');
if (failures.length === 0) {
  console.log('全部通过（' + total + ' 条断言）。client bundle 可以安全安装。');
  process.exit(0);
}
console.log(failures.length + ' / ' + total + ' 项失败：');
for (const f of failures) console.log('  - ' + f);
process.exit(1);
