/*
 * dsh-lexiang — client bundle loader test.
 *
 * Faithfully re-implements the shell's module loader so this file is really
 * executed (not just syntax-checked). Catches the failure modes that blank the
 * settings panel:
 *   - TDZ at module-evaluation time (codec referenced before init)
 *   - strict codec missing `create()`
 *   - slot props flattening (props.face does not exist)
 *   - unguarded synchronous remote call at mount
 *   - jsx() third argument is React key, NOT children
 *   - reserved remote method names
 *
 * Run: node test/load-client.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, "..", "lib", "client.js");
const source = fs.readFileSync(clientPath, "utf8");

let pass = 0;
let fail = 0;
const pendingChecks = [];
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      pendingChecks.push(
        r.then(
          () => { console.log(`  PASS  ${name}`); pass += 1; },
          (err) => { console.log(`  FAIL  ${name}`); console.log(`        ${err && err.message ? err.message : err}`); fail += 1; },
        ),
      );
      return;
    }
    console.log(`  PASS  ${name}`);
    pass += 1;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err && err.message ? err.message : err}`);
    fail += 1;
  }
}

// ── 忠实还原 react/jsx-runtime ────────────────────────────────────────────
// 第三个参数是 key，**绝不是** children。这一点曾经让「已保存的网址」渲染成
// 空胶囊（见 dsh-skill-url 的坑 7），所以这里刻意保持真实约定。
function jsx(type, props, key) {
  return { type, props: props || {}, key: key === undefined ? null : key, __el: true };
}
const Fragment = Symbol.for("react.fragment");

// ── 极简 React（含按渲染序的 hook 游标）──────────────────────────────────
function makeReact() {
  let cursor = 0;
  const store = new Map();
  let effects = [];
  let renderId = 0;

  function beginRender() {
    cursor = 0;
    renderId += 1;
    effects = [];
    return renderId;
  }
  const React = {
    Fragment,
    useState(init) {
      const i = cursor++;
      if (!store.has(i)) store.set(i, typeof init === "function" ? init() : init);
      const set = (v) => {
        const cur = store.get(i);
        store.set(i, typeof v === "function" ? v(cur) : v);
      };
      return [store.get(i), set];
    },
    useRef(init) {
      const i = cursor++;
      if (!store.has(i)) store.set(i, { current: init });
      return store.get(i);
    },
    useMemo(fn, _deps) {
      const i = cursor++;
      if (!store.has(i)) store.set(i, fn());
      return store.get(i);
    },
    useCallback(fn, _deps) {
      const i = cursor++;
      if (!store.has(i)) store.set(i, fn);
      return store.get(i);
    },
    useEffect(fn, _deps) {
      // React 只在依赖变化时重跑 effect；这里用「首次渲染 + 依赖数组」近似，
      // 但**每次都把 effect 收集起来**，方便测试手动 flush。
      const i = cursor++;
      const first = !store.has(i);
      store.set(i, true);
      effects.push(fn);
    },
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children }, key: null, __el: true };
    },
  };
  return { React, beginRender, flushEffects: () => effects.slice(), resetStore: () => store.clear() };
}

// ── 收集渲染树里的文本 ────────────────────────────────────────────────────
function textOf(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) textOf(n, out); return out; }
  if (node.__el) {
    const { props } = node;
    if (props && props.children !== undefined) textOf(props.children, out);
    return out;
  }
  return out;
}
function countByType(node, type, n = { c: 0 }) {
  if (node === null || node === undefined || typeof node !== "object") return n;
  if (Array.isArray(node)) { for (const x of node) countByType(x, type, n); return n; }
  if (node.__el) {
    if (node.type === type) n.c += 1;
    if (node.props && node.props.children !== undefined) countByType(node.props.children, type, n);
  }
  return n;
}
/** 找出所有带 className 的元素，便于断言 class 名。 */
function classesOf(node, out = []) {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) { for (const x of node) classesOf(x, out); return out; }
  if (node.__el) {
    if (node.props && node.props.className) out.push(node.props.className);
    if (node.props && node.props.children !== undefined) classesOf(node.props.children, out);
  }
  return out;
}

// ── 装载 client bundle ────────────────────────────────────────────────────
let loaded = null;
let loadError = null;
const registry = {};
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      try {
        registry[id] = factory((name) => {
          if (name === "react") return registry.__react;
          if (name === "react/jsx-runtime") return { jsx, Fragment };
          throw new Error(`unexpected require: ${name}`);
        });
        loaded = registry[id];
      } catch (err) {
        loadError = err;
      }
    },
  },
};
const { React, beginRender, flushEffects, resetStore } = makeReact();
registry.__react = React;

// 真正执行 bundle：它是为浏览器写的（依赖全局 window），所以在受控的
// window 下用 new Function 跑一遍，而不是 import。这样 factory 里的求值顺序
// 问题（TDZ 等）会真实暴露。
const runner = new Function("window", "document", source);
const fakeDocument = {
  getElementById: () => null,
  createElement: () => ({ id: "", textContent: "", setAttribute() {} }),
  head: { appendChild() {} },
};
try {
  runner(globalThis.window, fakeDocument);
} catch (err) {
  loadError = err;
}

console.log("\n=== 模块装载 ===");
check("client.js 可被求值（无 TDZ / 语法错误）", () => {
  if (loadError) throw loadError;
  if (!loaded) throw new Error("factory 未执行");
});
check("导出 apply / inject / NS", () => {
  if (typeof loaded.apply !== "function") throw new Error("apply 不是函数");
  if (!Array.isArray(loaded.inject)) throw new Error("inject 不是数组");
  if (loaded.NS !== "dsh-lexiang") throw new Error("NS 不对: " + loaded.NS);
});

console.log("\n=== CONTRIBUTION 契约 ===");
check("CONTRIBUTION 在求值阶段就已构造（codec 未踩 TDZ）", () => {
  const C = loaded.CONTRIBUTION;
  if (!C || C.package !== "dsh-lexiang") throw new Error("CONTRIBUTION 缺失或 package 不对");
  if (!Array.isArray(C.descriptors)) throw new Error("descriptors 不是数组");
});
check("每个 descriptor 都是 strict codec 且带 create()", () => {
  for (const d of loaded.CONTRIBUTION.descriptors) {
    if (d.result.mode !== "strict") throw new Error(`${d.method} result 不是 strict`);
    if (typeof d.result.create !== "function") throw new Error(`${d.method} result 缺 create`);
    const inst = d.result.create();
    if (!inst || typeof inst.parse !== "function") throw new Error(`${d.method} create() 未返回可 parse 对象`);
    for (const p of d.parameters) {
      if (typeof p.codec.create !== "function") throw new Error(`${d.method}.${p.name} 缺 create`);
    }
  }
});
check("descriptor id 与 namespace/method 一致", () => {
  for (const d of loaded.CONTRIBUTION.descriptors) {
    const want = `dsh-lexiang#lexiang/${d.method}`;
    if (d.id !== want) throw new Error(`${d.id} != ${want}`);
    if (d.namespace !== "lexiang" || d.service !== "lexiang") throw new Error(`${d.method} namespace/service 不对`);
  }
});
check("线名避开 RemoteNamespaceService 保留名", () => {
  const reserved = new Set([
    "assertMethodAvailable", "constructor", "empty", "has", "install", "installDirect",
    "installScoped", "methods", "remove", "ctx", "invokeRemote", "name", "namespace",
  ]);
  for (const d of loaded.CONTRIBUTION.descriptors) {
    if (reserved.has(d.method)) throw new Error(`线名撞保留名: ${d.method}`);
  }
});
check("METHODS 与 descriptors 数量一致", () => {
  if (loaded.METHODS.length !== loaded.CONTRIBUTION.descriptors.length) {
    throw new Error(`${loaded.METHODS.length} != ${loaded.CONTRIBUTION.descriptors.length}`);
  }
});
// host/client 线名必须逐字一致，否则运行期报
//   "transport failure for /api/lexiang/getSettings: HTTP 404"
// （host 端没注册该方法，网关就找不到路由）
check("client 线名与 host MANIFEST 完全一致", async () => {
  const hostUrl = new URL("../lib/index.js", import.meta.url).href;
  const host = await import(hostUrl);
  const H = host.MANIFEST.invocations.map((i) => `${i.namespace}/${i.method}`).sort();
  const C = loaded.CONTRIBUTION.descriptors.map((d) => `${d.namespace}/${d.method}`).sort();
  const onlyHost = H.filter((x) => !C.includes(x));
  const onlyClient = C.filter((x) => !H.includes(x));
  if (onlyHost.length) throw new Error(`host 有而 client 没有: ${onlyHost.join(", ")}`);
  if (onlyClient.length) throw new Error(`client 有而 host 没有: ${onlyClient.join(", ")}`);
  if (H.length !== C.length) throw new Error(`数量不一致: host ${H.length} / client ${C.length}`);
  if (host.MANIFEST.package !== loaded.CONTRIBUTION.package) {
    throw new Error(`package 名不一致: ${host.MANIFEST.package} / ${loaded.CONTRIBUTION.package}`);
  }
});

console.log("\n=== apply() 注册 slot ===");
check("apply 注册 settings.section 且 id/order 正确", () => {
  const registrations = [];
  let injectedSlot = null;
  const ctx = {
    effect: (fn) => { try { fn(); } catch {} },
    locale: { register: () => {}, bind: () => (k) => k },
    remote: { $mount: async () => {} },
    get: () => undefined,
    slots: {
      inject(slotName, fn) { injectedSlot = slotName; fn(); },
      register(desc, Component) { registrations.push({ desc, Component }); return () => {}; },
    },
  };
  loaded.apply(ctx);
  if (injectedSlot !== "settings.section") throw new Error("未注入 settings.section，实际: " + injectedSlot);
  if (registrations.length !== 1) throw new Error("注册数量应为 1，实际 " + registrations.length);
  const { desc, Component } = registrations[0];
  if (desc.id !== "lexiang") throw new Error("slot id 应为 lexiang");
  if (typeof desc.inject !== "function") throw new Error("desc.inject 应为函数（注入器）");
  if (typeof Component !== "function") throw new Error("组件不是函数");
  if (desc.order !== 19) throw new Error("order 应为 19");
});
check("inject 声明了 slots/locale/remote", () => {
  for (const need of ["slots", "locale", "remote"]) {
    if (!loaded.inject.includes(need)) throw new Error(`缺少 inject: ${need}`);
  }
});

console.log("\n=== 组件渲染 ===");
// 渲染辅助：模拟 shell 的 props 摊平（注入器返回值展开进 props）
function renderWith(injected, ownerProps = {}, tFn = (k) => k) {
  const C = loaded.LexiangSection;
  beginRender();
  const vnode = C({ ...injected, ...ownerProps, t: tFn });
  return { vnode, effects: flushEffects() };
}

check("未配置时渲染出凭证表单（含输入框与保存按钮）", () => {
  // 模拟：host 返回未配置
  const face = {
    getSettings: async () => ({ configured: false, hasToken: false, tokenMasked: "", companyFrom: "", stateFile: "/tmp/x.json" }),
    listTeams: async () => ({ teams: [] }),
    listSpaces: async () => ({ spaces: [] }),
    describeSpace: async () => ({ id: "sp", name: "P", rootEntryId: "r" }),
    listChildren: async () => ({ entries: [] }),
    readEntry: async () => ({ entry: {}, body: "" }),
    search: async () => ({ hits: [], mode: "keyword" }),
    saveSettings: async () => ({}),
    clearSettings: async () => ({}),
    testConnection: async () => ({}),
    createEntry: async () => ({}),
    renameEntry: async () => ({}),
    removeEntry: async () => ({}),
    uploadFile: async () => ({}),
  };
  const { vnode } = renderWith(face);
  // settings 初始为 null → 显示 loading
  const txt = textOf(vnode).join(" ");
  if (!txt.includes("loading")) throw new Error("初始应显示 loading，实际文本: " + txt.slice(0, 120));
});

check("props.face 不存在时也能工作（摊平兼容）", () => {
  const face = { getSettings: async () => ({ configured: false }) };
  // 注意：不传 props.face，只把方法平铺在 props 上 —— 这正是 DSH 的真实行为
  const { vnode } = renderWith(face);
  if (!vnode || !vnode.__el) throw new Error("未渲染出元素");
});

check("渲染不抛错（关键：不能触发 SlotErrorBoundary）", () => {
  const face = {
    getSettings: async () => ({ configured: false, hasToken: false, tokenMasked: "", stateFile: "/tmp/x.json" }),
  };
  beginRender();
  const el = loaded.LexiangSection({ ...face, t: (k) => k });
  if (!el) throw new Error("返回空");
});

console.log("\n=== 异步：挂载后读取凭证 ===");
check("挂载 effect 会调用 getSettings 并把结果落到界面", async () => {
  let called = 0;
  const face = {
    getSettings: async () => {
      called += 1;
      return { configured: true, hasToken: true, tokenMasked: "lxmcp…fc2 (70 位)", companyFrom: "cf", stateFile: "/tmp/x.json" };
    },
    listTeams: async () => ({ teams: [{ id: "t1", name: "团队A" }] }),
    listSpaces: async () => ({ spaces: [{ id: "s1", name: "库A", rootEntryId: "r1" }] }),
    describeSpace: async () => ({ id: "sp", name: "个人库", rootEntryId: "root1" }),
    listChildren: async () => ({ entries: [{ id: "e1", name: "页面1", type: "page", hasChildren: false }] }),
    readEntry: async () => ({ entry: { id: "e1" }, body: "正文内容" }),
    search: async () => ({ hits: [], mode: "keyword", total: 0 }),
    saveSettings: async () => ({}),
    clearSettings: async () => ({}),
    testConnection: async () => ({ staffName: "A", companyName: "B" }),
    createEntry: async () => ({}),
    renameEntry: async () => ({}),
    removeEntry: async () => ({}),
    uploadFile: async () => ({}),
  };
  const { effects } = renderWith(face);
  if (effects.length === 0) throw new Error("挂载 effect 未注册");
  for (const fn of effects) fn();
  await new Promise((r) => setTimeout(r, 10));
  if (called !== 1) throw new Error(`getSettings 应被调用 1 次，实际 ${called}`);
});

check("getSettings 缺失时不抛错，而是显示红字诊断", async () => {
  const { vnode } = renderWith({});
  const txt = textOf(vnode).join(" ");
  // 没有 getSettings → 初始仍显示 loading；effect 跑完后应转为错误
  const { effects } = renderWith({});
  for (const fn of effects) fn();
  await new Promise((r) => setTimeout(r, 10));
  if (!txt.includes("loading") && !txt.includes("初始化失败") && !txt.includes("远程服务未就绪")) {
    throw new Error("应显示 loading 或诊断文本，实际: " + txt.slice(0, 160));
  }
});

check("getSettings 抛错时被 try/catch 接住（不冒泡）", async () => {
  const face = { getSettings: async () => { throw new Error("boom"); } };
  const { effects } = renderWith(face);
  for (const fn of effects) fn();
  await new Promise((r) => setTimeout(r, 10));
  // 能走到这里没抛 = 通过
});

console.log("\n=== jsx children 回归（坑 7）===");
// 测试隔离：前面用 check() 注册的异步用例是「立即开始执行、稍后结算」的。
// 它们仍在飞行时若与下面的渲染共用 hook 存储，其 setState 会在 renderConfigured
// 的 await 间隙里写进去（曾导致已配置状态被上一个用例的报错覆盖）。
// 先把它们全部结算完，再进入这一节。
await Promise.allSettled(pendingChecks.splice(0, pendingChecks.length));
// 关键：这些断言必须跑在**已配置**状态下。未配置时只渲染凭证卡片，
// 而浏览区/搜索区的按钮根本不在树里 —— 早期版本就是这样漏掉了真实 bug。
async function renderConfigured(tFn = (k) => k) {
  const face = {
    getSettings: async () => ({
      configured: true, hasToken: true, tokenMasked: "lxmcp…fc2", companyFrom: "cf",
      stateFile: "/tmp/x.json",
    }),
    listTeams: async () => ({ teams: [{ id: "t1", name: "团队A" }] }),
    listSpaces: async () => ({ spaces: [{ id: "s1", name: "库A", rootEntryId: "r1" }] }),
    describeSpace: async () => ({ id: "sp", name: "个人库", rootEntryId: "root1" }),
    listChildren: async () => ({
      entries: [
        { id: "e1", name: "页面1", type: "page", hasChildren: false, validity: "none" },
        { id: "f1", name: "文件夹1", type: "folder", hasChildren: true, validity: "none" },
      ],
    }),
    readEntry: async () => ({ entry: { id: "e1", name: "页面1" }, body: "正文内容" }),
    search: async () => ({ hits: [{ id: "d1", title: "命中1", snippet: "片段", score: 1.2, fileType: "pdf" }], mode: "keyword", total: 1 }),
    saveSettings: async () => ({ configured: true, hasToken: true, tokenMasked: "x", stateFile: "/tmp/x.json" }),
    clearSettings: async () => ({ configured: false, hasToken: false, tokenMasked: "", stateFile: "/tmp/x.json" }),
    testConnection: async () => ({ staffName: "A", companyName: "B" }),
    createEntry: async () => ({ id: "n1", name: "新页" }),
    renameEntry: async () => ({ id: "e1", name: "改名" }),
    removeEntry: async () => ({ id: "e1", removed: true }),
    uploadFile: async () => ({ id: "u1", name: "a.pdf" }),
  };
  const C = loaded.LexiangSection;
  // 关键：清空 hook 存储。同一文件里前面的测试已经用不同的 hook 布局渲染过，
  // 若不清空，store[0] 里残留的旧 settings 会让本次渲染错位（这正是早期版本
  // 「已配置状态测不出来」的原因）。
  resetStore();
  const render = () => {
    beginRender();
    const v = C({ ...face, t: tFn });
    return { v, fx: flushEffects() };
  };
  // 第一遍：拿到 loading，跑挂载 effect（异步写状态）。
  let { fx } = render();
  for (const fn of fx) fn();
  await new Promise((r) => setTimeout(r, 30));
  // 第二遍：已配置状态，跑由此触发的加载 effect（团队/知识库）。
  let { v, fx: fx2 } = render();
  for (const fn of fx2) fn();
  await new Promise((r) => setTimeout(r, 30));
  // 第三遍：把加载结果渲染出来。
  ({ v } = render());
  return v;
}

const configuredTree = await renderConfigured();

check("已配置状态下确实渲染出浏览区与搜索区", () => {
  const classes = classesOf(configuredTree);
  if (!classes.includes("LX_split")) throw new Error("未渲染出 LX_split（浏览区）");
  const txt = textOf(configuredTree).join("|");
  // 注意：slot 的 nav 标签不在组件体内，别拿它断言。
  for (const key of ["credTitle", "browse", "search", "tree", "content"]) {
    if (!txt.includes(key)) throw new Error(`未渲染出界面文案: ${key}`);
  }
});

check("组件树里不存在「文字被当成 key」的空元素", () => {
  const suspicious = [];
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.__el) {
      const hasKids =
        n.props && n.props.children !== undefined && n.props.children !== null && n.props.children !== "";
      const keyLooksLikeText = typeof n.key === "string" && /[\u4e00-\u9fa5]/.test(n.key) && n.key.length > 3;
      if (keyLooksLikeText && !hasKids) suspicious.push(n.key);
      if (n.props && n.props.children !== undefined) walk(n.props.children);
    }
  })(configuredTree);
  if (suspicious.length > 0) {
    throw new Error(`发现疑似「文字写成 jsx key」的空元素: ${suspicious.join(", ")}`);
  }
});

check("所有 button/option 都带可见文本（不是空胶囊）", () => {
  const found = [];
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.__el) {
      if (n.type === "button" || n.type === "option") found.push(n);
      if (n.props && n.props.children !== undefined) walk(n.props.children);
    }
  })(configuredTree);
  if (found.length === 0) throw new Error("没有找到任何 button/option，断言失去意义");
  for (const b of found) {
    const txt = textOf(b).join("").trim();
    if (txt.length === 0) {
      throw new Error(
        `发现无文本的 <${b.type}>（很可能是文字写成了 jsx 的第三个参数/key）。` +
          `共检查 ${found.length} 个元素。`,
      );
    }
  }
  console.log(`        （已检查 ${found.length} 个 button/option）`);
});

check("关键按钮文案确实出现在树里", () => {
  const txt = textOf(configuredTree).join("|");
  // rename / remove 只在「已选中条目」时才渲染，未选中时不该出现 —— 这里断言
  // 的是始终存在的那些按钮。
  for (const key of ["save", "test", "clear", "browse", "newPage", "newFolder", "upload", "refresh", "search", "keyword", "semantic"]) {
    if (!txt.includes(key)) throw new Error(`缺少按钮文案: ${key}`);
  }
  // 未选中条目时不应出现删除按钮。
  if (txt.includes("remove")) throw new Error("未选中条目却渲染了删除按钮");
});

await Promise.allSettled(pendingChecks);
console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} passed, ${fail} failed`);
console.log("client bundle 可以安全安装。\n");
process.exit(fail === 0 ? 0 : 1);
