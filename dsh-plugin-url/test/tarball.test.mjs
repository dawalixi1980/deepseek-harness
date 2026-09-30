/**
 * tarball.js 回归测试：手写 npm tarball 打包器。
 *
 * 这里刻意**不复用**被测代码的解析逻辑 —— 用一个独立的 tar 读取器把产物拆回来，
 * 否则读写两边一起错就测不出来了。覆盖三类最容易写错的地方：
 *   - 条目前缀必须是 package/（npm 约定，pnpm 靠它认包根）
 *   - 超过 100 字节的路径（ustar prefix 拆分 / GNU longname 两条分支）
 *   - 必须排除 node_modules / .git / 嵌套 tgz / 符号链接
 */
import { gunzipSync } from "node:zlib";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNpmTarball } from "../lib/tarball.js";

let pass = 0;
let fail = 0;
function check(label, condition, detail) {
  if (condition) {
    pass += 1;
    console.log("  PASS  " + label);
  } else {
    fail += 1;
    console.log("  FAIL  " + label + (detail === undefined ? "" : "  -> " + detail));
  }
}

/** 独立的 tar 读取器（不认识 GNU longname 就不算独立，所以这里实现了）。 */
function readTar(buffer) {
  const entries = [];
  let offset = 0;
  let pendingLongName = null;
  while (offset + 512 <= buffer.length) {
    const block = buffer.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const rawName = block.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeText = block.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeText.length === 0 ? "0" : sizeText, 8);
    const typeflag = String.fromCharCode(block[156]);
    const prefix = block.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const content = buffer.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;

    if (typeflag === "L") {
      pendingLongName = content.toString("utf8").replace(/\0.*$/, "");
      continue;
    }
    const name = pendingLongName ?? (prefix.length > 0 ? `${prefix}/${rawName}` : rawName);
    pendingLongName = null;
    entries.push({ name, typeflag, size, content });
  }
  return entries;
}

const root = await mkdtemp(join(tmpdir(), "dsh-plugin-url-tar-"));
const pkg = join(root, "pkg");
async function put(rel, body) {
  const file = join(pkg, rel);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, body, "utf8");
}

try {
  const LONG_SEGMENT = "y".repeat(60);
  const USTAR_PATH = `lib/${"x".repeat(60)}/${LONG_SEGMENT}.js`; // prefix 可拆，走 ustar
  const GNU_PATH = `lib/${"z".repeat(130)}.js`; // 单段超 100，只能走 GNU longname

  await put("package.json", JSON.stringify({ name: "fixture", version: "1.0.0", main: "lib/index.js" }));
  await put("cordis.patch.yml", "- insert:\n    - id: fixture\n      name: fixture\n");
  await put("lib/index.js", "export const marker = \"alpha\";\n");
  await put(USTAR_PATH, "export const ustar = 1;\n");
  await put(GNU_PATH, "export const gnu = 1;\n");
  // 必须被排除的东西
  await put("node_modules/dep/package.json", "{}");
  await put(".git/config", "[core]\n");
  await put("bundled.tgz", "not-really-a-tarball");
  let symlinkMade = false;
  try {
    await symlink(join(pkg, "lib/index.js"), join(pkg, "lib", "link.js"));
    symlinkMade = true;
  } catch { /* Windows 无权限时跳过这条断言 */ }

  console.log("\n[1] 产物是合法 gzip");
  const tgz = await buildNpmTarball(pkg);
  check("gzip 魔数正确", tgz[0] === 0x1f && tgz[1] === 0x8b);
  const raw = gunzipSync(tgz);
  check("解压后长度是 512 的整数倍", raw.length % 512 === 0, `长度 ${raw.length}`);
  check("结尾有两个全零块", raw.subarray(raw.length - 1024).every((b) => b === 0));

  console.log("\n[2] 结构与内容");
  const entries = readTar(raw);
  const names = entries.map((e) => e.name);
  check("所有条目都以 package/ 开头", names.every((n) => n.startsWith("package/")), names.join(", "));
  check("含 package/package.json", names.includes("package/package.json"));
  check("含 package/lib/index.js", names.includes("package/lib/index.js"));
  check("含补丁层 cordis.patch.yml", names.includes("package/cordis.patch.yml"));

  const readBack = (name) => entries.find((e) => e.name === name)?.content.toString("utf8");
  const original = await import("node:fs/promises").then((fs) => fs.readFile(join(pkg, "lib", "index.js"), "utf8"));
  check("文件内容逐字一致", readBack("package/lib/index.js") === original);
  check("package.json 内容一致", JSON.parse(readBack("package/package.json")).name === "fixture");

  console.log("\n[3] 长路径两条分支");
  check("ustar prefix 拆分路径可还原", names.includes(`package/${USTAR_PATH}`), names.filter((n) => n.includes("x")).join(","));
  check("GNU longname 路径可还原", names.includes(`package/${GNU_PATH}`), names.filter((n) => n.includes("z")).join(","));
  check("长路径内容正确", readBack(`package/${GNU_PATH}`) === "export const gnu = 1;\n");

  console.log("\n[4] 排除项");
  check("node_modules 未进包", !names.some((n) => n.includes("node_modules")));
  check(".git 未进包", !names.some((n) => n.includes(".git")));
  check("嵌套 .tgz 未进包", !names.includes("package/bundled.tgz"));
  if (symlinkMade) check("符号链接未进包", !names.includes("package/lib/link.js"));
  else console.log("  SKIP  符号链接（本机无 symlink 权限）");

  console.log("\n[5] 负向");
  let threw = false;
  try {
    await buildNpmTarball(join(root, "does-not-exist"));
  } catch {
    threw = true;
  }
  check("无 package.json 的目录拒绝打包", threw);

  const empty = join(root, "empty");
  await mkdir(empty, { recursive: true });
  await writeFile(join(empty, "a.txt"), "x", "utf8");
  let threw2 = false;
  try {
    await buildNpmTarball(empty);
  } catch {
    threw2 = true;
  }
  check("没有 package.json 时抛出", threw2);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`\n打包测试：${pass} 项 PASS，${fail} 项 FAIL。`);
if (fail > 0) process.exitCode = 1;
