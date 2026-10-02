/**
 * 契约校验：client 与 host 的远程描述符必须逐字对齐。
 *
 * 这类不一致在运行时才炸，而且报错是 "Cannot read properties of undefined (reading 'mode')"
 * 这种看不出源头的信息（api-gateway 逐个读 parameter.codec）。所以在这里静态拦住。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, "..", "lib");

let failed = 0;
const check = (name, ok, detail) => {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok || !detail ? "" : "\n        " + detail));
  if (!ok) failed += 1;
};

const clientSrc = readFileSync(join(LIB, "client.js"), "utf8");
const hostSrc = readFileSync(join(LIB, "index.js"), "utf8");

const methodsOf = (src, key) => {
  const i = src.indexOf(key);
  if (i < 0) return [];
  const seg = src.slice(i, src.indexOf("];", i));
  return [...seg.matchAll(/id:\s*P\s*\+\s*"#obsidianSplit\/(\w+)"/g)].map((m) => m[1]);
};

console.log("=== 描述符对齐 ===");
const cm = methodsOf(clientSrc, "descriptors: [");
const hm = methodsOf(hostSrc, "invocations: [");
check("client 找到 " + cm.length + " 个方法", cm.length > 0);
check("host 找到 " + hm.length + " 个方法", hm.length > 0);
check("方法集完全一致", JSON.stringify(cm) === JSON.stringify(hm), "client=" + cm.join(",") + " host=" + hm.join(","));

console.log("\n=== 参数形状（踩过的坑）===");
/**
 * 把注释剥掉再检查 —— 否则文档里写的反例（"别写成 parameters: [codec(...)]"）
 * 会被自己的检查当成违规。这是踩过的一次误报。
 */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const bare = /parameters:\s*\[\s*codec\(/;
check("client 没有裸 codec 参数", !bare.test(stripComments(clientSrc)), "裸 codec 会让 requireStrictInputs 读到 undefined 然后炸");
check("host 没有裸 codec 参数", !bare.test(stripComments(hostSrc)), "同上");
const shape = /name:\s*"args",\s*wire:\s*"args",\s*source:\s*"json"/;
check("client 用 { name, wire, source, codec } 对象", shape.test(clientSrc));
check("host 用 { name, wire, source, codec } 对象", shape.test(hostSrc));

console.log("\n=== codec 工厂 ===");
check("client codec 带 create() 工厂", /create:\s*\(\)\s*=>/.test(clientSrc));
check("host codec 带 create() 工厂", /create:\s*\(\)\s*=>/.test(hostSrc));
check("client codec.mode 为 strict", /mode:\s*"strict"/.test(clientSrc));
check("host codec.mode 为 strict", /mode:\s*"strict"/.test(hostSrc));

console.log("\n=== dsh.client.inject 白名单 ===");
/*
 * 踩过的坑：我一度把 "@deepseek-ai/dsh-client-ui-sidebar" 写进 inject，
 * 以为"要用侧栏就得声明它"。但那个包只在 app.asar 与 profiles/node_modules 里，
 * profile 的 node_modules 解析不到 —— boot 图找不到这个依赖，插件静默加载失败，
 * 表现为"引导页里没有条目、标签页也不出现"，而**没有任何报错信息**。
 *
 * 已装的 5 个能跑的插件，inject 全都是下面这三个。所以锁死白名单。
 */
const ALLOWED_INJECT = [
  "@deepseek-ai/dsh-client-runtime",
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-api-gateway"
];
const pkg = JSON.parse(readFileSync(join(LIB, "..", "package.json"), "utf8"));
const inject = pkg.dsh?.client?.inject ?? [];
for (const dep of inject) {
  check("inject 允许 " + dep, ALLOWED_INJECT.includes(dep), "不在白名单里，profile 可能解析不到 -> 插件静默不加载");
}
check("inject 声明了 runtime", inject.includes("@deepseek-ai/dsh-client-runtime"));

console.log("\n=== host 模块能否真正 import ===");
/*
 * 踩过的坑：我用脚本生成 host 的 MANIFEST 时，把生成脚本里的临时函数
 * name(m) 写进了产物，于是 host 端在模块求值期就抛 ReferenceError。
 *
 * 后果特别隐蔽：host 挂掉 -> 整个插件不加载 -> 引导页没有条目、标签页不出现，
 * 而**界面上一个字都不报**。所以这里直接真的 import 一次。
 *
 * 注意：这一步要求依赖可解析（zod / typert-protocol），所以在源码目录跑会失败、
 * 在 profile 的 node_modules 里跑才通过。解析不到就跳过，避免误报。
 */
{
  let hostLoaded = "skip";
  let detail = "";
  try {
    const mod = await import(pathToFileURL(join(LIB, "index.js")).href);
    hostLoaded = typeof mod.apply === "function" && Array.isArray(mod.inject) ? "ok" : "bad";
    detail = "name=" + mod.name + " inject=" + JSON.stringify(mod.inject);
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    // 依赖解析不到（源码目录）不算失败
    if (/Cannot find package '(zod|@deepseek-ai)/.test(message)) hostLoaded = "skip";
    else { hostLoaded = "fail"; detail = message; }
  }
  if (hostLoaded === "skip") console.log("  SKIP  host 模块 import（依赖不可解析，通常是在源码目录跑）");
  else check("host 模块可以 import 且导出 apply/inject", hostLoaded === "ok", detail);
}

console.log("\n=== host 方法签名收 args ===");
for (const m of hm) {
  check("host " + m + " 签名存在", new RegExp("async " + m + "\\(").test(hostSrc));
}

console.log("\n" + (failed === 0 ? "全部通过" : "有失败") + "：" + (failed === 0 ? "契约一致" : failed + " 项失败"));
process.exit(failed === 0 ? 0 : 1);
