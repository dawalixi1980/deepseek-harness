/*
 * Effect-lifecycle regression test.
 *
 * This models React's dependency-array semantics and, crucially, gives every
 * scenario a **fresh module instance with its own hook store**. The other client
 * test shares one store across cases, which is exactly how the dropped-response
 * bug and the async loading gate both slipped through.
 *
 * Two failure modes are covered:
 *
 *  1. `face = props.face ?? props`, and DSH hands the component a fresh props
 *     object on every render. With `[face]` in the mount effect's dependency
 *     array the effect re-ran on every render, and its cleanup flipped the
 *     `alive` flag, so the in-flight getSettings response was discarded.
 *
 *  2. The panel used to gate all of its content behind `settings === null`,
 *     so a getSettings response that never arrived left the section permanently
 *     blank - indistinguishable from a component crash.
 *
 * The fix is that the credentials form renders on the very first frame and the
 * async result only fills in values.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(here, "..", "lib", "client.js");
const src = fs.readFileSync(CLIENT, "utf8");

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err && err.message ? err.message : err}`);
  }
}

function jsx(type, props, key) {
  return { type, props: props || {}, key: key ?? null, __el: true };
}

function flatten(node, out = []) {
  if (node == null || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const c of node) flatten(c, out); return out; }
  if (node.__el && node.props && node.props.children !== undefined) flatten(node.props.children, out);
  return out;
}

/** Fresh mini-React with its own hook store, dependency arrays and cleanups. */
function makeReact() {
  const state = new Map();
  const deps = new Map();
  const cleanups = new Map();
  let cursor = 0;
  let effects = [];
  return {
    Fragment: Symbol.for("fragment"),
    useState(init) {
      const n = cursor++;
      if (!state.has(n)) state.set(n, typeof init === "function" ? init() : init);
      return [state.get(n), (v) => state.set(n, typeof v === "function" ? v(state.get(n)) : v)];
    },
    useRef(init) {
      const n = cursor++;
      if (!state.has(n)) state.set(n, { current: init });
      return state.get(n);
    },
    useMemo(fn) {
      const n = cursor++;
      if (!state.has(n)) state.set(n, fn());
      return state.get(n);
    },
    useCallback(fn, d) {
      const n = cursor++;
      const prev = deps.get(n);
      const same = prev !== undefined && d !== undefined && prev.length === d.length && prev.every((x, i) => Object.is(x, d[i]));
      if (!same) { deps.set(n, d); state.set(n, fn); }
      return state.get(n);
    },
    useEffect(fn, d) {
      const n = cursor++;
      effects.push({ n, fn, d });
    },
    render(component, props) {
      cursor = 0;
      effects = [];
      const vnode = component(props);
      return { vnode, commit: () => this.commit() };
    },
    commit() {
      const pending = effects;
      effects = [];
      for (const e of pending) {
        const prev = deps.get(e.n);
        const same = prev !== undefined && e.d !== undefined && prev.length === e.d.length && prev.every((x, i) => Object.is(x, e.d[i]));
        if (same) continue;
        const old = cleanups.get(e.n);
        if (typeof old === "function") { try { old(); } catch {} }
        deps.set(e.n, e.d);
        const c = e.fn();
        cleanups.set(e.n, typeof c === "function" ? c : undefined);
      }
    },
  };
}

/** Load a fresh module instance bound to the given React. */
function loadClient(React) {
  const registry = {};
  globalThis.window = {
    __ModuleLoader__: {
      load(o) {
        registry[o.id] = o.factory((n) => {
          if (n === "react") return React;
          if (n === "react/jsx-runtime") return { jsx, Fragment: React.Fragment };
          throw new Error(n);
        });
      },
    },
  };
  new Function("window", "document", src)(globalThis.window, {
    getElementById: () => null,
    createElement: () => ({ id: "", textContent: "" }),
    head: { appendChild() {} },
  });
  return registry["dsh-lexiang"];
}

const noop = async () => ({});
function makeFace(getSettingsImpl) {
  return {
    getSettings: getSettingsImpl,
    debugLog: noop,
    listTeams: async () => ({ teams: [] }),
    listSpaces: async () => ({ spaces: [] }),
    describeSpace: async () => ({}),
    listChildren: async () => ({ entries: [] }),
    readEntry: async () => ({ body: "" }),
    search: async () => ({ hits: [], mode: "keyword" }),
    saveSettings: noop, clearSettings: noop, testConnection: noop,
    createEntry: noop, renameEntry: noop, moveEntry: noop, removeEntry: noop, uploadFile: noop,
  };
}

const SETTINGS = {
  companyFrom: "acme", hasToken: false, tokenMasked: "", endpoint: "",
  activeSpaceId: "", recent: [], configured: false, stateFile: "C:\\x\\dsh-lexiang.json",
};

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// ---------------------------------------------------------------- scenario 1

/** 首帧必须直接渲染表单，不依赖任何请求。 */
t("首帧就渲染凭证表单（getSettings 永不返回）", () => {
  const React = makeReact();
  const L = loadClient(React);
  const face = makeFace(() => new Promise(() => {}));
  const { vnode } = React.render(L.LexiangSection, { ...face, t: (k) => k });
  const text = flatten(vnode).join("|");
  if (!text.includes("credTitle")) throw new Error(`首帧没渲染表单: ${JSON.stringify(text.slice(0, 160))}`);
  for (const key of ["companyFrom", "token", "save", "test", "clear"]) {
    if (!text.includes(key)) throw new Error(`缺少表单元素: ${key}`);
  }
});

t("getSettings 永不返回时，重渲染后表单依然在（不依赖异步门槛）", async () => {
  const React = makeReact();
  const L = loadClient(React);
  const face = makeFace(() => new Promise(() => {}));
  React.render(L.LexiangSection, { ...face, t: (k) => k });
  React.commit();
  await new Promise((r) => setTimeout(r, 10));
  const { vnode } = React.render(L.LexiangSection, { ...face, t: (k) => k });
  const text = flatten(vnode).join("|");
  if (!text.includes("credTitle")) throw new Error(`面板没有渲染表单: ${JSON.stringify(text.slice(0, 160))}`);
});

// ---------------------------------------------------------------- scenario 2

/** 请求飞行中父组件反复重渲染，响应回来后表单要带上真实值。 */
t("请求飞行中父组件重渲染，响应回来后表单填上真实值", async () => {
  const React = makeReact();
  const L = loadClient(React);
  const d = deferred();
  const face = makeFace(() => d.promise);

  React.render(L.LexiangSection, { ...face, t: (k) => k });
  React.commit();
  // 每次都是全新的 props 对象 —— face 身份随之变化
  for (let i = 0; i < 3; i += 1) {
    React.render(L.LexiangSection, { ...face, t: (k) => k });
    React.commit();
  }

  d.resolve(SETTINGS);
  await new Promise((r) => setTimeout(r, 20));

  const { vnode } = React.render(L.LexiangSection, { ...face, t: (k) => k });
  const text = flatten(vnode).join("|");
  if (!text.includes("credTitle")) throw new Error(`表单消失了: ${JSON.stringify(text.slice(0, 160))}`);
  if (!text.includes(SETTINGS.stateFile)) {
    throw new Error(`响应没有落到界面（stateFile 缺失）: ${JSON.stringify(text.slice(0, 200))}`);
  }
});

// ---------------------------------------------------------------- scenario 3

/** 组件卸载后再收到响应，也不能抛错（dsh-skill-url 同样不设 alive 门槛）。 */
t("卸载后到达的响应不会抛错", async () => {
  const React = makeReact();
  const L = loadClient(React);
  const d = deferred();
  const face = makeFace(() => d.promise);
  React.render(L.LexiangSection, { ...face, t: (k) => k });
  React.commit();
  // 触发清理（模拟卸载）
  React.render(L.LexiangSection, { ...face, t: (k) => k });
  React.commit();
  d.resolve(SETTINGS);
  await new Promise((r) => setTimeout(r, 20));
});

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
