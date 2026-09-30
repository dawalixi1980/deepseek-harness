/**
 * dsh-plugin-url —— client 半加载测试。
 *
 * 为什么必须有这个测试：
 *   `node --check lib/client.js` 只验证**语法**，查不出模块求值期的
 *   暂时性死区（TDZ）错误。真实发生的事故是：CONTRIBUTION 在求值时调用
 *   codec()，而 codec 引用了用 `const` 声明在其后方的 identity，于是抛
 *   "Cannot access 'identity' before initialization"，web boot 该项无法
 *   激活，整个桌面端「无法启动或已意外停止」。
 *
 *   本测试**真实构造** bundle（执行 factory 与组件首屏），因此能兜住它。
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

console.log('bundle: ' + bundlePath);

// ── 1. 真实执行模块体（这一步捕获 TDZ）───────────────────────────────────
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
check('id 为 dsh-plugin-url', () => {
  if (captured?.id !== 'dsh-plugin-url') throw new Error('id = ' + captured?.id);
});

// ── 2. 构造 bundle（提供 fake react）─────────────────────────────────────
// 本 bundle 的 CONTRIBUTION / codec / identity 都位于 factory 内部，因此 TDZ 在
// 「构造」这一步才暴露。DSH 启动时正是这样调用 factory，所以它报的是 "import failed"。
console.log('\n[2] factory 构造与导出（TDZ 在此暴露）');

/** 可预置初值的 fake hooks：单次渲染即可驱动任意分支。
 *  runEffects=true 时**真正执行** useEffect 回调，等价于真实挂载
 *  —— 组件挂在 effect 里的取数逻辑（如 face.listInstalled()）才会暴露错误。
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
 * 事故记录（坑 7）：曾经把文字写成 `jsx("button", {...}, "文字")`，
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
check('factory 可构造', () => {
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
check('client 半 inject 恰为 slots / locale / remote / sessions', () => {
  const expected = ['slots', 'locale', 'remote', 'sessions'];
  if (JSON.stringify(mod.inject) !== JSON.stringify(expected)) throw new Error('inject = ' + JSON.stringify(mod.inject));
});
check('导出 PluginUrlSection', () => {
  if (typeof mod.PluginUrlSection !== 'function') throw new Error('PluginUrlSection 缺失');
});

// ── 3. apply()：注册远程贡献与设置分区 ───────────────────────────────────
console.log('\n[3] apply() 注册');

let registeredSection;
let registeredComponent;
let mounted;
let localeRegistered;
let localeBound;
const ctx = {
  effect: (fn) => {
    fn();
    return () => {};
  },
  locale: {
    register: (ns, dict) => { localeRegistered = { ns, dict }; },
    bind: (ns) => { localeBound = ns; return (key) => key; },
  },
  remote: {
    $mount: (contribution) => {
      mounted = contribution;
      return Promise.resolve();
    },
  },
  get: (name) =>
    name === 'sessions'
      ? { currentProvideInfo: { getSnapshot: () => ({ sessionId: 'test-session' }) } }
      : name === 'remote.pluginUrl'
        ? { inspect: async () => ({ ok: true, value: {} }) }
        : undefined,
  slots: {
    inject: (name, fn) => fn(),
    register: (desc, component) => {
      registeredSection = desc;
      registeredComponent = component;
    },
  },
};

check('apply() 不抛异常', () => {
  mod.apply(ctx);
});
check('挂载了远程贡献', () => {
  if (mounted === undefined) throw new Error('$mount 未被调用');
});
check('远程贡献 package 为 dsh-plugin-url', () => {
  if (mounted?.package !== 'dsh-plugin-url') throw new Error('package = ' + mounted?.package);
});
check('远程描述符线名齐全且含 installPlugin / uninstallPlugin', () => {
  if (!Array.isArray(mounted?.descriptors)) throw new Error('descriptors 不是数组');
  const methods = mounted.descriptors.map((d) => d.method).sort();
  const expected = ['backgroundStatus', 'cancelJob', 'forgetUrl', 'inspect', 'installPlugin', 'listInstalled', 'recentUrls', 'rememberUrl', 'searchCommunity', 'uninstallPlugin'];
  if (JSON.stringify(methods) !== JSON.stringify(expected)) throw new Error('method = ' + JSON.stringify(methods));
});
check('注册了 settings.section 分区', () => {
  if (registeredSection === undefined) throw new Error('未注册分区');
  if (registeredSection.name !== 'settings.section') throw new Error('name = ' + registeredSection.name);
});
check('分区 id 为 plugin-url', () => {
  if (registeredSection.id !== 'plugin-url') throw new Error('id = ' + registeredSection.id);
});
check('注册的组件就是导出的 PluginUrlSection', () => {
  if (registeredComponent !== mod.PluginUrlSection) throw new Error('注册的组件与导出不一致');
});
check('分区 face 暴露 installPlugin / uninstallPlugin 而不是 install / uninstall', () => {
  if (typeof registeredSection.inject !== 'function') throw new Error('分区没有 inject（face 工厂）');
  const face = registeredSection.inject();
  for (const name of ['installPlugin', 'uninstallPlugin', 'inspect', 'listInstalled', 'rememberUrl', 'recentUrls', 'forgetUrl', 'searchCommunity', 'backgroundStatus', 'cancelJob']) {
    if (typeof face?.[name] !== 'function') throw new Error('face.' + name + ' 缺失');
  }
  if (face.install !== undefined) throw new Error('face 上还有旧线名 install');
  if (face.uninstall !== undefined) throw new Error('face 上还有旧线名 uninstall');
});
/**
 * TDZ 的第二道防线（光靠「构造 factory」查不出来）：
 * codec 写成 `create: () => ({ parse: identity })` 时，构造 CONTRIBUTION 只是
 * **捕获** identity，并不读取它 —— 所以把 `const identity` 挪到 CONTRIBUTION
 * 之后，模块求值照样成功，直到 shell 按 `codec.create().parse(value)` 走一遍
 * 描述符才真的读 identity，那时才炸。这里把那一刻提前到测试里。
 */
check('每个远程描述符的 codec.create() 都能真的取到 identity（client 侧 TDZ 回归）', () => {
  if (!Array.isArray(mounted?.descriptors)) throw new Error('descriptors 不是数组');
  for (const descriptor of mounted.descriptors) {
    const created = descriptor.result.create();
    if (typeof created?.parse !== 'function') throw new Error(descriptor.id + ' result.create() 没返回带 parse() 的 schema');
    created.parse({ probe: true });
    for (const parameter of descriptor.parameters) {
      const value = parameter.codec.create().parse('probe');
      if (value !== 'probe') throw new Error(descriptor.id + ' parameter ' + parameter.name + ' 的 parse 没有透传');
    }
  }
});
check('注册了 settings.pluginUrl 文案命名空间', () => {
  if (localeRegistered === undefined) throw new Error('locale.register 未被调用');
  if (localeRegistered.ns !== 'settings.pluginUrl') throw new Error('namespace = ' + localeRegistered.ns);
  if (typeof localeRegistered.dict?.zh?.nav !== 'string') throw new Error('zh 字典缺 nav');
  if (typeof localeRegistered.dict?.en?.nav !== 'string') throw new Error('en 字典缺 nav');
});
check('bind 用的也是 settings.pluginUrl', () => {
  if (localeBound !== 'settings.pluginUrl') throw new Error('bind = ' + localeBound);
});

// ── 4. 组件渲染：驱动"已发现插件 / 已安装列表 / 已保存网址"各分支 ────────
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

/** 找到唯一一张文本里含 needle 的 <li> 卡片（多张即报错，避免断言认错卡）。 */
function cardWithText(tree, needle) {
  const hits = findNodes(tree, (node) => node.type === 'li' && collectText(node, []).join(' | ').includes(needle));
  if (hits.length === 0) throw new Error('找不到含 "' + needle + '" 的卡片');
  if (hits.length > 1) throw new Error('含 "' + needle + '" 的卡片有 ' + hits.length + ' 张，断言会认错卡');
  return hits[0];
}
/** 卡片内的全部按钮（按渲染顺序）。 */
function buttonsIn(node) {
  return findNodes(node, (item) => item.type === 'button');
}

/**
 * 文案替身：只映射本测试要断言的 key，其余回落到 key 本身。
 * 映射值取自 lib/client.js 的 zh 字典（readiness 三态标签），
 * 改文案会让断言失败 —— 这是契约，不是脆弱。
 */
const ZH = {
  ready: '可直接装', needsBuild: '需要构建', missingEntry: '缺入口产物',
  communitySearch: '搜索社区插件', communityView: '查看插件', communityTitle: '社区插件',
  communityStars: '{n} 星', communityFound: '共 {n} 个仓库（第 {page} 页）',
  bgTitle: '后台任务', bgRunning: '进行中', bgDone: '已完成', bgFailed: '失败', bgElapsed: '{n} 秒',
  bgCancel: '取消', bgCancelling: '取消中…', bgCancelled: '已取消', bgIdle: '空闲',
  bgRunningCount: '{n} 个进行中', bgFinished: '最近完成 {n} 条', bgShow: '展开', bgHide: '收起',
  unreadable: '有 {n} 个 package.json 重试后仍然读不到，列表可能不全：{list}',
  opFailed: '操作失败',
};
const t = (key) => (key in ZH ? ZH[key] : key);

const seedUrl = 'https://github.com/dawalixi1980/deepseek-harness';

const fakeResult = {
  owner: 'dawalixi1980',
  repo: 'deepseek-harness',
  ref: 'main',
  subpath: '',
  cached: false,
  method: 'tree',
  unreadable: [],
  totalScanned: 3,
  plugins: [
    {
      name: 'dsh-skill-url', version: '0.2.0', description: '从网址装技能',
      subpath: 'dsh-skill-url', patch: 'cordis.patch.yml', patchPresent: true, web: true,
      license: 'MIT', dependencies: ['zod'], buildScripts: [], readiness: 'ready', installed: true,
    },
    {
      name: 'dsh-docx', version: '0.1.3', description: 'Word 文档处理',
      subpath: 'pkgs/dsh-docx', patch: 'cordis.patch.yml', patchPresent: true, web: false,
      license: 'MIT', dependencies: [], buildScripts: ['prepare', 'build'], readiness: 'needs-build', installed: false,
    },
    {
      name: 'dsh-broken', version: '0.0.1', description: '',
      subpath: 'pkgs/dsh-broken', patch: 'cordis.patch.yml', patchPresent: false, web: false,
      license: '', dependencies: [], buildScripts: [], readiness: 'missing-entry', installed: false,
    },
  ],
};

// 已装列表：名字刻意不与发现结果重叠，卡片定位才唯一。
const fakeLocal = [
  {
    name: 'dsh-scanner', version: '1.2.0', description: '可卸载的第三方插件',
    enabled: true, removable: true, errorCode: '',
    owner: 'dawalixi1980', repo: 'deepseek-harness', ref: 'main', subpath: 'dsh-scanner',
  },
  {
    name: 'dsh-core-pack', version: '1.0.0', description: '受管理保护的内置包',
    enabled: false, removable: false, errorCode: 'managed',
  },
];

// 社区检索结果（topic:dsh-plugin）。名字刻意不与被发现插件/已装列表重叠。
const fakeCommunity = {
  query: 'topic:dsh-plugin',
  page: 1,
  total: 16732,
  cached: false,
  items: [
    {
      fullName: 'awesome-dsh-plugin/awesome-dsh-plugin', owner: 'awesome-dsh-plugin', repo: 'awesome-dsh-plugin',
      description: '精选插件列表', stars: 17379, forks: 3434, updatedAt: '2026-09-29T16:28:58Z',
      defaultBranch: 'main', archived: false, topics: ['dsh-plugin'],
    },
    {
      fullName: 'tt-a1i/archify', owner: 'tt-a1i', repo: 'archify',
      description: '架构图技能', stars: 74618, forks: 5011, updatedAt: '2026-09-30T07:53:50Z',
      defaultBranch: 'main', archived: true, topics: ['dsh-plugin'],
    },
  ],
};

// 后台任务快照（host 侧任务表）。用来验证「关掉设置再回来能续上」。
const fakeBackground = {
  jobs: [
    {
      id: 'job-1', kind: 'inspect', url: seedUrl, subpath: '', label: 'dawalixi1980/deepseek-harness',
      phase: 'running', startedAt: Date.now() - 4000, endedAt: 0, error: '',
      summary: '正在扫描 dawalixi1980/deepseek-harness',
    },
    {
      id: 'job-2', kind: 'install', url: 'https://github.com/x/y', subpath: 'pkgs/a', label: 'x/y:pkgs/a',
      phase: 'failed', startedAt: Date.now() - 9000, endedAt: Date.now() - 8000, error: '装不上：boom',
      summary: 'x/y:pkgs/a 失败',
    },
  ],
  results: [{ url: seedUrl, label: 'dawalixi1980/deepseek-harness', at: 1, result: fakeResult }],
};

// 按组件内 useState 的声明顺序预置初值：
// url, busy, result, error, notice, pending, local, sites
const seeds = [seedUrl, false, fakeResult, '', '', {}, fakeLocal, []];

// 社区块要额外预置后 4 个 hook：communityKeywords, communityPage, community, communityBusy
const communitySeeds = [...seeds, 'diagram', 2, fakeCommunity, false];

// 再往后是 jobs（后台任务快照）
const backgroundSeeds = [...communitySeeds, fakeBackground.jobs];

// 收窄后的后台任务：1 个进行中 + 2 个已完成。用来验证「完成的不占卡片」和「取消」。
const fakeJobs = {
  running: {
    id: 'job-running', kind: 'inspect', url: seedUrl, subpath: '', label: 'dawalixi1980/deepseek-harness',
    phase: 'running', startedAt: Date.now() - 5000, endedAt: 0, error: '',
    summary: '正在扫描 dawalixi1980/deepseek-harness', cancellable: true,
  },
  finished: {
    id: 'job-finished', kind: 'inspect', url: 'https://github.com/a/b', subpath: '', label: 'a/b',
    phase: 'done', startedAt: Date.now() - 20000, endedAt: Date.now() - 18000, error: '',
    summary: 'a/b 扫描完成', cancellable: false,
  },
  failed: {
    id: 'job-failed', kind: 'install', url: 'https://github.com/c/d', subpath: 'p', label: 'c/d:p',
    phase: 'failed', startedAt: Date.now() - 30000, endedAt: Date.now() - 29000, error: '装不上：boom',
    summary: 'c/d:p 失败', cancellable: false,
  },
};
const mixedJobs = [fakeJobs.running, fakeJobs.finished, fakeJobs.failed];

// jobsExpanded 是 jobs 之后的最后一个 hook（默认 false）
const runningSeeds = [...communitySeeds, mixedJobs, false];
const expandedSeeds = [...communitySeeds, mixedJobs, true];

// 「刚打开面板」的形态：本地还没有结果，全靠后台快照恢复
const coldSeeds = [seedUrl, false, null, '', '', {}, fakeLocal, [], '', 1, null, false];

/** 记录 face 被调用情况；同时挂上旧线名 install / uninstall 以证明没人再调它们。 */
const calls = { inspect: [], installPlugin: [], uninstallPlugin: [], listInstalled: 0, install: [], uninstall: [], searchCommunity: [], backgroundStatus: 0, cancelJob: [] };
function makeFace(overrides = {}) {
  return {
    inspect: async (url) => { calls.inspect.push(url); return fakeResult; },
    installPlugin: async (url, subpath) => {
      calls.installPlugin.push([url, subpath]);
      return { name: 'dsh-docx', version: '0.1.3', subpath, application: 'applied', changed: true, bytes: 128, warnings: [] };
    },
    uninstallPlugin: async (name) => {
      calls.uninstallPlugin.push(name);
      return { name, removed: true, application: 'applied' };
    },
    listInstalled: async () => { calls.listInstalled += 1; return { plugins: fakeLocal }; },
    recentUrls: async () => ({ sites: [] }),
    rememberUrl: async () => ({ sites: [] }),
    forgetUrl: async () => ({ sites: [] }),
    searchCommunity: async (keywords, page) => { calls.searchCommunity.push([keywords, page]); return fakeCommunity; },
    backgroundStatus: async () => { calls.backgroundStatus += 1; return fakeBackground; },
    cancelJob: async (id) => { calls.cancelJob.push(id); return { id, cancelled: true, status: 'cancelling' }; },
    currentSessionId: () => 'test-session',
    // 改名前的线名：留在 face 上，一旦面板还在调它，下面的断言就会响。
    install: async () => { calls.install.push('install'); return { ok: true }; },
    uninstall: async () => { calls.uninstall.push('uninstall'); return { ok: true }; },
    ...overrides,
  };
}
function resetCalls() {
  calls.inspect.length = 0;
  calls.installPlugin.length = 0;
  calls.uninstallPlugin.length = 0;
  calls.install.length = 0;
  calls.uninstall.length = 0;
  calls.searchCommunity.length = 0;
  calls.backgroundStatus = 0;
  calls.cancelJob.length = 0;
  calls.listInstalled = 0;
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
  build();
  if (a.mod.PluginUrlSection === undefined) throw new Error('PluginUrlSection 缺失');
});

/**
 * DSH 的真实契约：slot 宿主把 inject() 的返回值**摊平**成 props
 * （内置组件写法：function AgentPresetSection({ load, view, makeDefault, t })），
 * 不存在 props.face。事故记录：组件曾读 props.face → undefined →
 * 挂载 effect 里 face.listInstalled() 抛错 → slot 整块白屏。
 * 这里用**会真正执行 effect** 的 fake react（等于真实挂载），旧写法必炸。
 */
check('按 DSH 真实 props 形态可渲染（API 摊平在顶层，无 props.face）', () => {
  resetCalls();
  const { mod: seeded } = build(seeds, { runEffects: true });
  const rendered = seeded.PluginUrlSection({ ...makeFace(), t });
  if (rendered === null || rendered === undefined) throw new Error('渲染返回空');
});

/** 兼容形态（props.face 包装）也不该崩。 */
check('兼容 props.face 形态', () => {
  resetCalls();
  const { mod: seeded } = build(seeds, { runEffects: true });
  const rendered = seeded.PluginUrlSection({ face: makeFace(), t });
  if (rendered === null || rendered === undefined) throw new Error('渲染返回空');
});

/** 完全没有注入时，要给出可见提示而不是白屏/抛错。 */
check('注入缺失时渲染出错误提示（不白屏、不抛错）', () => {
  resetCalls();
  const { mod: seeded } = build(seeds, { runEffects: true });
  const rendered = seeded.PluginUrlSection({ t });
  if (rendered === null || rendered === undefined) throw new Error('渲染返回空');
  const text = collectText(rendered, []).join(' | ');
  if (!text.includes('pluginUrl 服务不可用')) throw new Error('未出现诊断提示：' + text.slice(0, 120));
});

/** 渲染树必须真的含文字（空树 = 白屏，collectText 会给出空串）。 */
check('渲染树真的含可见文字（不是白屏）', () => {
  resetCalls();
  const { mod: seeded } = build(seeds, { runEffects: true });
  const rendered = seeded.PluginUrlSection({ ...makeFace(), t });
  const text = collectText(rendered, []).join(' | ');
  if (text.trim().length === 0) throw new Error('渲染树里一个文字节点都没有');
});

/**
 * 坑 7 回归：已保存的仓库网址必须**显示出文字**。
 * 挂载 effect 会异步拉 recentUrls；这里用同一个 react 实例渲染两次，
 * 中间的微任务让 promise 落定，第二次渲染就能看到 chip。
 */
check('已保存的网址 chip 显示出 label 文字（坑 7 回归）', async () => {
  resetCalls();
  const saved = [{ url: 'https://github.com/dawalixi1980/Dawalixi-skill', label: 'dawalixi1980/Dawalixi-skill', at: 1 }];
  const { reactApi, mod: seeded } = build(seeds, { runEffects: true });
  const api = makeFace({ recentUrls: async () => ({ sites: saved }), rememberUrl: async () => ({ sites: saved }) });
  renderWith(reactApi, seeded.PluginUrlSection, { ...api, t }); // 首次渲染 + effect 发起取数
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const rendered = renderWith(reactApi, seeded.PluginUrlSection, { ...api, t }); // 重渲染
  const text = collectText(rendered, []).join(' | ');
  if (!text.includes('dawalixi1980/Dawalixi-skill')) {
    throw new Error('chip 没有显示出 label（很可能又把文字当成了 jsx 的第三个参数/key）：' + text.slice(0, 200));
  }
});

/** 发现结果列表：name / version / subpath / readiness 标签都必须出现。 */
let tree;
check('组件可渲染（含已发现插件列表）', () => {
  resetCalls();
  const { mod: seeded } = build(seeds);
  tree = seeded.PluginUrlSection({ ...makeFace(), t });
  if (tree === null || tree === undefined) throw new Error('渲染返回空');
});

if (tree !== undefined && tree !== null) {
  const text = collectText(tree, []).join('\u0001');
  check('渲染结果含插件名 dsh-docx', () => {
    if (!text.includes('dsh-docx')) throw new Error('未出现 dsh-docx');
  });
  check('渲染结果含版本号 v0.1.3', () => {
    if (!text.includes('v0.1.3')) throw new Error('未出现 v0.1.3');
  });
  check('渲染结果含插件目录 pkgs/dsh-docx', () => {
    if (!text.includes('pkgs/dsh-docx')) throw new Error('未出现 pkgs/dsh-docx');
  });
  check('渲染结果含 readiness 标签「可直接装」', () => {
    if (!text.includes(ZH.ready)) throw new Error('未出现 ' + ZH.ready);
  });
  check('渲染结果含 readiness 标签「需要构建」与构建脚本名', () => {
    if (!text.includes(ZH.needsBuild)) throw new Error('未出现 ' + ZH.needsBuild);
    if (!text.includes('prepare')) throw new Error('needs-build 标签没有列出 buildScripts');
  });
  check('渲染结果含 readiness 标签「缺入口产物」', () => {
    if (!text.includes(ZH.missingEntry)) throw new Error('未出现 ' + ZH.missingEntry);
  });
  check('渲染结果含仓库坐标', () => {
    if (!text.includes('dawalixi1980/deepseek-harness')) throw new Error('未出现仓库坐标');
  });
}

/** 安装按钮：必须调用 face.installPlugin(url, subpath)，不是旧的 install。 */
check('安装按钮调用 face.installPlugin(url, subpath)', () => {
  resetCalls();
  const { mod: seeded } = build(seeds);
  const rendered = seeded.PluginUrlSection({ ...makeFace(), t });
  const card = cardWithText(rendered, 'pkgs/dsh-docx');
  const [button] = buttonsIn(card);
  if (button === undefined) throw new Error('卡片里找不到安装按钮');
  if (typeof button.props.onClick !== 'function') throw new Error('安装按钮没有 onClick');
  button.props.onClick();
  if (calls.installPlugin.length !== 1) throw new Error('installPlugin 调用次数 = ' + calls.installPlugin.length);
  const [url, subpath] = calls.installPlugin[0];
  if (url !== seedUrl) throw new Error('url = ' + url);
  if (subpath !== 'pkgs/dsh-docx') throw new Error('subpath = ' + subpath);
  if (calls.install.length !== 0) throw new Error('面板调用了已废弃的 face.install');
});

/** 已装项 removable === true：卸载按钮可用，点击调用 face.uninstallPlugin(name)。 */
check('已装项 removable===true 时卸载按钮可用，点击调用 face.uninstallPlugin(name)', () => {
  resetCalls();
  const { mod: seeded } = build(seeds);
  const rendered = seeded.PluginUrlSection({ ...makeFace(), t });
  const card = cardWithText(rendered, 'dsh-scanner');
  const [button] = buttonsIn(card);
  if (button === undefined) throw new Error('卡片里找不到卸载按钮');
  if (button.props.disabled !== false) throw new Error('removable 为 true 却被禁用：disabled = ' + button.props.disabled);
  button.props.onClick();
  if (calls.uninstallPlugin.length !== 1) throw new Error('uninstallPlugin 调用次数 = ' + calls.uninstallPlugin.length);
  if (calls.uninstallPlugin[0] !== 'dsh-scanner') throw new Error('卸载参数 = ' + calls.uninstallPlugin[0]);
  if (calls.uninstall.length !== 0) throw new Error('面板调用了已废弃的 face.uninstall');
});

/** 已装项 removable !== true：卸载按钮必须 disabled。 */
check('已装项 removable!==true 时卸载按钮 disabled', () => {
  resetCalls();
  const { mod: seeded } = build(seeds);
  const rendered = seeded.PluginUrlSection({ ...makeFace(), t });
  const card = cardWithText(rendered, 'dsh-core-pack');
  const [button] = buttonsIn(card);
  if (button === undefined) throw new Error('卡片里找不到卸载按钮');
  if (button.props.disabled !== true) throw new Error('removable 为 false 却没被禁用：disabled = ' + button.props.disabled);
});

// ── 社区插件检索 ─────────────────────────────────────────────────────────
/** 社区结果列表：仓库全名 / 星数 / 总数都要真的渲染出来。 */
check('社区检索结果可渲染（仓库名 / 星数 / 总数）', () => {
  const { mod: seeded } = build(communitySeeds);
  const rendered = seeded.PluginUrlSection({ ...makeFace(), t });
  const text = collectText(rendered, []).join(' | ');
  if (!text.includes('awesome-dsh-plugin/awesome-dsh-plugin')) throw new Error('没渲染出仓库全名：' + text.slice(0, 200));
  if (!text.includes('tt-a1i/archify')) throw new Error('没渲染出第二个仓库');
  if (!text.includes('74618')) throw new Error('没渲染出星数');
  if (!text.includes('16732')) throw new Error('没渲染出总数');
  if (!text.includes(ZH.communityTitle)) throw new Error('没渲染出社区标题');
});

/** 搜索按钮：必须调 face.searchCommunity(关键词, 1) —— 从第 1 页开始。 */
check('搜索按钮调用 face.searchCommunity(关键词, 1)', () => {
  resetCalls();
  // 社区状态留空（null），只保留关键词，验证「点按钮才请求」
  const { mod: seeded } = build([...seeds, 'mermaid', 1, null, false]);
  const rendered = seeded.PluginUrlSection({ ...makeFace(), t });
  const buttons = buttonsIn(rendered).filter((b) => collectText(b, []).join('') === ZH.communitySearch);
  if (buttons.length !== 1) throw new Error('找不到「' + ZH.communitySearch + '」按钮（命中 ' + buttons.length + ' 个）');
  if (calls.searchCommunity.length !== 0) throw new Error('还没点按钮就发起了检索（输入即搜会烧光配额）');
  buttons[0].props.onClick();
  if (calls.searchCommunity.length !== 1) throw new Error('searchCommunity 调用次数 = ' + calls.searchCommunity.length);
  if (calls.searchCommunity[0][0] !== 'mermaid') throw new Error('关键词 = ' + calls.searchCommunity[0][0]);
  if (calls.searchCommunity[0][1] !== 1) throw new Error('页码 = ' + calls.searchCommunity[0][1]);
});

/**
 * 「查看插件」必须把仓库地址填进输入框并直接触发 inspect（复用同一条发现流程），
 * 而不是另起一套下载逻辑。
 */
check('社区结果「查看插件」填地址并触发 inspect', () => {
  resetCalls();
  const { mod: seeded } = build(communitySeeds);
  const rendered = seeded.PluginUrlSection({ ...makeFace(), t });
  const card = cardWithText(rendered, 'tt-a1i/archify');
  const [button] = buttonsIn(card);
  if (button === undefined) throw new Error('社区卡片里找不到按钮');
  if (collectText(button, []).join('') !== ZH.communityView) throw new Error('按钮文字 = ' + collectText(button, []).join(''));
  button.props.onClick();
  if (calls.inspect.length !== 1) throw new Error('inspect 调用次数 = ' + calls.inspect.length);
  if (!String(calls.inspect[0]).includes('github.com/tt-a1i/archify')) throw new Error('inspect 地址 = ' + calls.inspect[0]);
});

// ── 后台任务（关掉设置再回来能续上）─────────────────────────────────────
/** 挂载时必须读一次 host 的后台状态，否则"续上"无从谈起。 */
check('挂载时读一次后台状态', () => {
  resetCalls();
  const { mod: seeded } = build(seeds, { runEffects: true });
  seeded.PluginUrlSection({ ...makeFace(), t });
  if (calls.backgroundStatus < 1) throw new Error('挂载没有调用 face.backgroundStatus');
});

/**
 * 任务条：进行中的那张卡片要有状态标签和耗时。
 * （已完成的默认收起，所以失败状态/原因在下面「展开后才显示」那条里断言。）
 */
check('后台任务条：进行中的卡片有状态与耗时', () => {
  const { mod: seeded } = build(backgroundSeeds);
  const rendered = seeded.PluginUrlSection({ ...makeFace(), t });
  const text = collectText(rendered, []).join(' | ');
  if (!text.includes(ZH.bgTitle)) throw new Error('没有后台任务标题：' + text.slice(0, 200));
  if (!text.includes('正在扫描 dawalixi1980/deepseek-harness')) throw new Error('没有显示进行中的任务');
  if (!/\d+ 秒/.test(text)) throw new Error('没有显示耗时：' + text.slice(0, 300));
});

/**
 * 最关键的一条：**冷启动（本地没有结果）时，必须从后台快照把上次的发现结果捞回来，
 * 而且不能重新扫一遍**。这正是用户抱怨的"一退出设置就得重来"。
 */
check('重开面板能续上后台结果且不重新扫描', async () => {
  resetCalls();
  const { reactApi, mod: seeded } = build(coldSeeds, { runEffects: true });
  renderWith(reactApi, seeded.PluginUrlSection, { ...makeFace(), t });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const rendered = renderWith(reactApi, seeded.PluginUrlSection, { ...makeFace(), t });
  const text = collectText(rendered, []).join(' | ');
  if (!text.includes('dsh-docx')) throw new Error('没有从后台快照恢复出插件列表：' + text.slice(0, 250));
  if (calls.inspect.length !== 0) throw new Error('恢复过程不该重新扫描，但 inspect 被调了 ' + calls.inspect.length + ' 次');
});

/**
 * 收窄后的后台任务：**已完成的默认只占一行，不占卡片**。
 * 之前每次重开面板扫同一个仓库都会多一条一模一样的「扫描完成」卡片堆在界面上，
 * 这条断言就是钉住「不再堆」。
 */
check('后台任务：完成的默认收起，只留一行摘要', () => {
  const { mod: seeded } = build(runningSeeds);
  const rendered = seeded.PluginUrlSection({ ...makeFace(), t });
  const text = collectText(rendered, []).join(' | ');
  if (!text.includes(fakeJobs.running.summary)) throw new Error('没有显示进行中的任务');
  if (text.includes(fakeJobs.finished.summary)) throw new Error('已完成的任务默认不该展开成卡片：' + fakeJobs.finished.summary);
  if (!text.includes(t('bgFinished').replace('{n}', '2'))) throw new Error('没有显示已完成条数：' + text.slice(0, 300));
});

/** 展开之后才看得到已完成的明细 —— 包括失败的状态和原因。 */
check('后台任务：展开后才显示已完成明细', () => {
  const { mod: seeded } = build(expandedSeeds);
  const rendered = seeded.PluginUrlSection({ ...makeFace(), t });
  const text = collectText(rendered, []).join(' | ');
  if (!text.includes(fakeJobs.finished.summary)) throw new Error('展开后应显示已完成明细');
  if (!text.includes(ZH.bgFailed)) throw new Error('展开后应显示失败状态');
  if (!text.includes('装不上：boom')) throw new Error('展开后应显示失败原因（不能只藏在 tooltip 里）');
  if (!text.includes(t('bgHide'))) throw new Error('展开后按钮应变成「收起」');
});

/** 进行中的任务才有取消按钮，点了要真的调 face.cancelJob(id)。 */
check('后台任务：进行中才有取消按钮，点击调用 face.cancelJob(id)', () => {
  resetCalls();
  const { mod: seeded } = build(runningSeeds);
  const rendered = seeded.PluginUrlSection({ ...makeFace(), t });
  const card = cardWithText(rendered, fakeJobs.running.summary);
  const [button] = buttonsIn(card);
  if (button === undefined) throw new Error('进行中的卡片里没有取消按钮');
  if (collectText(button, []).join('') !== ZH.bgCancel) throw new Error('按钮文字 = ' + collectText(button, []).join(''));
  if (button.props.disabled !== false) throw new Error('cancellable=true 却被禁用');
  button.props.onClick();
  if (calls.cancelJob.length !== 1) throw new Error('cancelJob 调用次数 = ' + calls.cancelJob.length);
  if (calls.cancelJob[0] !== fakeJobs.running.id) throw new Error('取消的 id = ' + calls.cancelJob[0]);
});

/** 已完成的任务没有取消按钮（不该让用户去取消一个已经结束的东西）。 */
check('后台任务：已完成的不给取消按钮', () => {
  const { mod: seeded } = build(expandedSeeds);
  const rendered = seeded.PluginUrlSection({ ...makeFace(), t });
  const line = cardWithText(rendered, fakeJobs.finished.summary);
  if (buttonsIn(line).length !== 0) throw new Error('已完成的记录里不该有按钮');
});

/**
 * 取消不是失败：RPC 因为取消而 reject 时必须走提示，不能显示成红色报错。
 */
check('取消不算失败：不显示成「操作失败」', async () => {
  const { reactApi, mod: seeded } = build(runningSeeds, { runEffects: true });
  const api = makeFace({
    backgroundStatus: async () => ({ jobs: mixedJobs, results: [] }),
    cancelJob: async () => { throw new Error('已取消'); },
  });
  renderWith(reactApi, seeded.PluginUrlSection, { ...api, t });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const rendered = renderWith(reactApi, seeded.PluginUrlSection, { ...api, t });
  const card = cardWithText(rendered, fakeJobs.running.summary);
  buttonsIn(card)[0].props.onClick();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const after = renderWith(reactApi, seeded.PluginUrlSection, { ...api, t });
  const text = collectText(after, []).join(' | ');
  if (text.includes(ZH.opFailed)) throw new Error('取消被显示成了操作失败：' + text.slice(0, 300));
  if (!text.includes(ZH.bgCancelled)) throw new Error('取消后应显示「已取消」提示：' + text.slice(0, 300));
});

/**
 * 轻量路线里某个 package.json 重试后仍读不到时，**必须报出来**。
 * 之前的实现是 `catch { continue; }` —— 一次瞬时网络抖动就静默少一个插件，
 * 用户看到的是不完整的列表却毫不知情。
 */
check('发现结果里 unreadable 非空时给出警告', () => {
  const unreadableSeeds = [seedUrl, false, { ...fakeResult, unreadable: ['dsh-lexiang/package.json'] }, '', '', {}, fakeLocal, []];
  const { mod: seeded } = build(unreadableSeeds);
  const rendered = seeded.PluginUrlSection({ ...makeFace(), t });
  const text = collectText(rendered, []).join(' | ');
  if (!text.includes('dsh-lexiang/package.json')) throw new Error('没有报出读不到的 package.json：' + text.slice(0, 300));
  if (!/读不到|可能不全/.test(text)) throw new Error('没有给出"列表可能不全"的提示');
});

// ── 汇总 ─────────────────────────────────────────────────────────────────
// 先等所有 async 断言（如「chip 显示 label」）落定，再判定结果。
await Promise.allSettled(pendingChecks);

console.log('');
if (failures.length === 0) {
  console.log('全部通过（' + total + ' 条断言）。client bundle 可以安全安装。');
  process.exit(0);
}
console.log(failures.length + ' / ' + total + ' 项失败：');
for (const f of failures) console.log('  - ' + f);
process.exit(1);
