/**
 * 渲染自检：用真实 React 把面板渲染一遍。
 *
 * 为什么需要它：组件里任何**同步**抛错（TDZ、undefined 属性访问）都会让整个面板
 * 静默渲染不出来 —— 界面上没有报错、没有边框、什么都没有。这种"一片空白"
 * 在浏览器控制台之外无从察觉，所以在这里用 renderToStaticMarkup 抓一遍。
 *
 * 用法：node scripts/render-check.mjs   （需在装有依赖的目录下跑，见 package.json 的 scripts）
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, "..", "lib");

let failed = 0;
const check = (name, ok, detail) => {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok || !detail ? "" : "\n        " + detail));
  if (!ok) failed += 1;
};

const req = createRequire(join(LIB, "client.js"));
const react = req("react");
const jsxRt = req("react/jsx-runtime");
let renderToStaticMarkup = null;
try { renderToStaticMarkup = req("react-dom/server").renderToStaticMarkup; } catch { /* 没有 dom 就跳过渲染 */ }

let captured = null;
globalThis.window = { __ModuleLoader__: { load: (d) => { captured = d; } } };
globalThis.document = { getElementById: () => null, createElement: () => ({ id: "", set textContent(_v) {} }), head: { appendChild: () => {} } };

const requireShim = (n) => {
  if (n === "react") return react;
  if (n === "react/jsx-runtime") return jsxRt;
  throw new Error("unexpected require: " + n);
};

console.log("=== 模块求值 ===");
try {
  const src = readFileSync(join(LIB, "client.js"), "utf8");
  new Function("window", "require", "document", src)(globalThis.window, requireShim, globalThis.document);
  check("client.js 求值不抛错", true);
} catch (error) {
  check("client.js 求值不抛错", false, String(error && error.message ? error.message : error));
}

if (captured === null) { check("注册到 __ModuleLoader__", false); process.exit(1); }
let mod = null;
try { mod = captured.factory(requireShim); check("factory 执行不抛错", true); }
catch (error) { check("factory 执行不抛错", false, String(error && error.message ? error.message : error)); }

if (mod === null) process.exit(1);
check("导出 apply/inject", typeof mod.apply === "function" && Array.isArray(mod.inject));

if (renderToStaticMarkup === null) { console.log("  SKIP  渲染（react-dom/server 不可用）"); process.exit(failed === 0 ? 0 : 1); }

console.log("\n=== 真实渲染（status 已知）===");
const face = {
  status: async () => ({ available: true, reason: "", dshHandle: 1, obHandle: 2, workArea: { x: 0, y: 0, width: 1920, height: 1032 }, ratio: 0.62, gap: 8, presets: [0.5, 0.62, 0.7, 0.38], snapped: false }),
  snap: async () => ({}), drag: async () => ({}), unsnap: async () => ({}), focus: async () => ({}), openVault: async () => ({})
};
const props = { face, t: (k) => k, workspacePath: "G:\\学习\\learn-高等数学" };

/* React 会为 key 走 spread 打 warning —— 静音掉，它不影响渲染结果。 */
const origError = console.error;
console.error = () => {};
let html = "";
try { html = renderToStaticMarkup(react.createElement(mod.ObsidianSplitPanel, props)); }
catch (error) { check("面板渲染不抛错", false, String(error && error.message ? error.message : error)); }
console.error = origError;

if (html.length > 0) {
  check("面板渲染不抛错", true);
  check("渲染出根容器", html.includes("OS_root"));
  check("渲染出拖动轨道", html.includes("OS_track"));
  check("渲染出分隔条", html.includes("OS_split"));
  check("渲染出预设按钮", html.includes("50 : 50"));
  check("识别出工作区库名", html.includes("learn-高等数学"));
  /*
   * 注意：renderToStaticMarkup **不执行 useEffect**，所以组件里的 status 永远是初始的
   * null，屏幕尺寸与句柄都拿不到。这一条不是断言 bug，是测试方式的边界 ——
   * 所以只报告"屏幕尺寸"取决于异步状态，不把它算作失败。
   */
  console.log("  NOTE  屏幕尺寸/句柄来自 useEffect 中的 status()，静态渲染拿不到（预期）");
}

/* 无 workspacePath 时不能崩 —— DSH 不保证总会传下来。 */
console.error = () => {};
let html2 = "";
try { html2 = renderToStaticMarkup(react.createElement(mod.ObsidianSplitPanel, { face, t: (k) => k })); }
catch (error) { check("没有 workspacePath 时也不崩", false, String(error && error.message ? error.message : error)); }
console.error = origError;
check("没有 workspacePath 时也不崩", html2.length > 0);

console.log("\n" + (failed === 0 ? "全部通过" : "有失败") + "：" + (failed === 0 ? "渲染正常" : failed + " 项失败"));
process.exit(failed === 0 ? 0 : 1);
