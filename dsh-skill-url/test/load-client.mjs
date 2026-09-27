/**
 * dsh-skill-url —— client 半加载测试。
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
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = resolve(process.argv[2] ?? join(here, '..', 'lib', 'client.js'));

const failures = [];
function record(ok, label, detail) {
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
check('id 为 dsh-skill-url', () => {
  if (captured?.id !== 'dsh-skill-url') throw new Error('id = ' + captured?.id);
});

// ── 2. 构造 bundle（提供 fake react）─────────────────────────────────────
// 本 bundle 的 CONTRIBUTION 位于 factory 内部，因此 TDZ 在「构造」这一步才
// 暴露。DSH 启动时正是这样调用 factory，所以它报的是 "import failed"。
console.log('\n[2] factory 构造与导出（TDZ 在此暴露）');

/** 可预置初值的 fake hooks：单次渲染即可驱动任意分支。
 *  runEffects=true 时**真正执行** useEffect 回调，等价于真实挂载
 *  —— 组件挂在 effect 里的取数逻辑（如 face.listInstalled()）才会暴露错误。
 *
 *  keepState=true 时 useState 的 setter 会**真的写回**状态，因此连续渲染两次
 *  就能看到 effect 里异步取回的数据（模拟真实 React 的重渲染）。 */
function makeReact(seed = [], options = {}) {
  // 每次渲染都是新的一轮：hook 游标归零，状态按「hook 序号」存，
  // 这样才能像真实 React 那样在多次渲染间保持状态。
  const store = [];
  let cursor = 0;
  const next = (fallback) => (cursor < seed.length ? seed[cursor++] : fallback);
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

let mod;
check('factory 可构造', () => {
  mod = captured.factory((spec) => {
    if (spec === 'react') return makeReact();
    if (spec === 'react/jsx-runtime') return makeJsxRuntime();
    throw new Error('意料之外的 require：' + spec);
  });
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
check('导出 SkillUrlSection', () => {
  if (typeof mod.SkillUrlSection !== 'function') throw new Error('SkillUrlSection 缺失');
});

// ── 3. apply()：注册远程贡献与设置分区 ───────────────────────────────────
console.log('\n[3] apply() 注册');

let registeredSection;
let mountCalled = false;
const ctx = {
  effect: (fn) => {
    fn();
    return () => {};
  },
  locale: {
    register: () => {},
    bind: () => (key) => key,
  },
  remote: {
    $mount: () => {
      mountCalled = true;
      return Promise.resolve();
    },
  },
  get: (name) =>
    name === 'sessions'
      ? { currentProvideInfo: { getSnapshot: () => ({ sessionId: 'test-session' }) } }
      : name === 'remote.skillUrl'
        ? { inspect: async () => ({ ok: true, value: {} }) }
        : undefined,
  slots: {
    inject: (name, fn) => fn(),
    register: (desc) => {
      registeredSection = desc;
    },
  },
};

check('apply() 不抛异常', () => {
  mod.apply(ctx);
});
check('挂载了远程贡献', () => {
  if (!mountCalled) throw new Error('$mount 未被调用');
});
check('注册了 settings.section 分区', () => {
  if (registeredSection === undefined) throw new Error('未注册分区');
  if (registeredSection.name !== 'settings.section') throw new Error('name = ' + registeredSection.name);
  if (registeredSection.id !== 'skill-url') throw new Error('id = ' + registeredSection.id);
});

// ── 4. 组件渲染：驱动"已发现技能"分支 ───────────────────────────────────
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

const fakeResult = {
  owner: 'anthropics',
  repo: 'skills',
  ref: 'main',
  subpath: '',
  cached: false,
  totalScanned: 2,
  skills: [
    { name: 'docx', description: 'Word 文档处理', directory: 'skills/docx', subpath: 'skills/docx', installed: true, enabled: true },
    { name: 'pdf', description: 'PDF 处理', directory: 'skills/pdf', subpath: 'skills/pdf', installed: false, enabled: false },
  ],
};
const fakeLocal = [{ name: 'docx', description: 'Word 文档处理', enabled: true, dirBundle: true, path: 'X:/skills/docx' }];

// 按组件内 useState 的声明顺序预置初值：
// url, busy, result, error, notice, pending, local
const seeds = ['https://github.com/anthropics/skills', false, fakeResult, '', '', {}, fakeLocal];

const faceApi = {
  inspect: async () => fakeResult,
  install: async () => ({ ok: true }),
  uninstall: async () => ({ ok: true }),
  listInstalled: async () => ({ skills: fakeLocal }),
  currentSessionId: () => 'test-session',
};

/**
 * DSH 的真实契约：slot 宿主把 inject() 的返回值**摊平**成 props
 * （内置组件写法：function AgentPresetSection({ load, view, makeDefault, t })），
 * 不存在 props.face。事故记录：组件曾读 props.face → undefined →
 * 挂载 effect 里 face.listInstalled() 抛错 → slot 整块白屏。
 * 这里用**会真正执行 effect** 的 fake react（等于真实挂载），旧写法必炸。
 */
check('按 DSH 真实 props 形态可渲染（API 摊平在顶层，无 props.face）', () => {
  const seeded = captured.factory((spec) => {
    if (spec === 'react') return makeReact(seeds, { runEffects: true });
    if (spec === 'react/jsx-runtime') return makeJsxRuntime();
    throw new Error('意料之外的 require：' + spec);
  });
  const rendered = seeded.SkillUrlSection({ ...faceApi, t: (key) => key });
  if (rendered === null || rendered === undefined) throw new Error('渲染返回空');
});

/** 兼容形态（老写法）也不该崩。 */
check('兼容 props.face 形态', () => {
  const seeded = captured.factory((spec) => {
    if (spec === 'react') return makeReact(seeds, { runEffects: true });
    if (spec === 'react/jsx-runtime') return makeJsxRuntime();
    throw new Error('意料之外的 require：' + spec);
  });
  const rendered = seeded.SkillUrlSection({ face: faceApi, t: (key) => key });
  if (rendered === null || rendered === undefined) throw new Error('渲染返回空');
});

/** 完全没有注入时，要给出可见提示而不是白屏/抛错。 */
check('注入缺失时渲染出错误提示（不白屏、不抛错）', () => {
  const seeded = captured.factory((spec) => {
    if (spec === 'react') return makeReact(seeds, { runEffects: true });
    if (spec === 'react/jsx-runtime') return makeJsxRuntime();
    throw new Error('意料之外的 require：' + spec);
  });
  const rendered = seeded.SkillUrlSection({ t: (key) => key });
  const text = collectText(rendered, []).join(' | ');
  if (!text.includes('skillUrl 服务不可用')) throw new Error('未出现诊断提示：' + text.slice(0, 120));
});

/**
 * 坑 7 回归：已保存的仓库网址必须**显示出文字**。
 * 挂载 effect 会异步拉 recentUrls；这里用同一个 react 实例渲染两次，
 * 中间的微任务让 promise 落定，第二次渲染就能看到 chip。
 */
check('已保存的网址 chip 显示出 label 文字（坑 7 回归）', async () => {
  const saved = [{ url: 'https://github.com/dawalixi1980/Dawalixi-skill', label: 'dawalixi1980/Dawalixi-skill', at: 1 }];
  let reactApi;
  const seeded = captured.factory((spec) => {
    if (spec === 'react') { reactApi = makeReact(seeds, { runEffects: true }); return reactApi; }
    if (spec === 'react/jsx-runtime') return makeJsxRuntime();
    throw new Error('意料之外的 require：' + spec);
  });
  const api = {
    ...faceApi,
    recentUrls: async () => ({ sites: saved }),
    rememberUrl: async () => ({ sites: saved }),
    forgetUrl: async () => ({ sites: [] }),
  };
  renderWith(reactApi, seeded.SkillUrlSection, { ...api, t: (key) => key });   // 首次渲染 + effect 发起取数
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const rendered = renderWith(reactApi, seeded.SkillUrlSection, { ...api, t: (key) => key });   // 重渲染
  const text = collectText(rendered, []).join(' | ');
  if (!text.includes('dawalixi1980/Dawalixi-skill')) {
    throw new Error('chip 没有显示出 label（很可能又把文字当成了 jsx 的第三个参数/key）：' + text.slice(0, 200));
  }
});

let tree;
check('组件可渲染（含已发现技能列表）', () => {
  const section = mod.SkillUrlSection;
  // 用预置初值的 fake react 重新构造一次，使组件闭包内的 react 带种子
  const seeded = captured.factory((spec) => {
    if (spec === 'react') return makeReact(seeds);
    if (spec === 'react/jsx-runtime') return makeJsxRuntime();
    throw new Error('意料之外的 require：' + spec);
  });
  tree = section === undefined ? undefined : seeded.SkillUrlSection;
  if (tree === undefined) throw new Error('SkillUrlSection 不可用');
  // 直接以函数方式调用单次渲染（hooks 已预置）
  tree = seeded.SkillUrlSection({
    face: {
      inspect: async () => fakeResult,
      install: async () => ({ ok: true }),
      uninstall: async () => ({ ok: true }),
      listInstalled: async () => ({ skills: fakeLocal }),
      currentSessionId: () => 'test-session',
    },
    t: (key) => key,
  });
  if (tree === null || tree === undefined) throw new Error('渲染返回空');
});

if (tree !== undefined && tree !== null) {
  const text = collectText(tree, []).join('\u0001');
  check('渲染结果含 docx', () => {
    if (!text.includes('docx')) throw new Error('未出现 docx');
  });
  check('渲染结果含 pdf', () => {
    if (!text.includes('pdf')) throw new Error('未出现 pdf');
  });
  check('渲染结果含仓库名', () => {
    if (!text.includes('anthropics/skills')) throw new Error('未出现仓库名');
  });
}

// ── 汇总 ─────────────────────────────────────────────────────────────────
// 先等所有 async 断言（如「chip 显示 label」）落定，再判定结果。
await Promise.allSettled(pendingChecks);

console.log('');
if (failures.length === 0) {
  console.log('全部通过。client bundle 可以安全安装。');
  process.exit(0);
}
console.log(failures.length + ' 项失败：');
for (const f of failures) console.log('  - ' + f);
process.exit(1);
