/**
 * 契约校验：client 与 host 的远程描述符必须逐字对齐。
 *
 * 这类不一致在运行时才炸，而且报错是 "Cannot read properties of undefined (reading 'mode')"
 * 这种看不出源头的信息（api-gateway 逐个读 parameter.codec）。所以在这里静态拦住。
 */
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

console.log("\n=== host 方法签名收 args ===");
for (const m of hm) {
  check("host " + m + " 签名存在", new RegExp("async " + m + "\\(").test(hostSrc));
}

console.log("\n" + (failed === 0 ? "全部通过" : "有失败") + "：" + (failed === 0 ? "契约一致" : failed + " 项失败"));
process.exit(failed === 0 ? 0 : 1);
