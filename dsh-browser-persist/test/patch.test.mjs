/**
 * dsh-browser-persist 测试。
 *
 * 全部用**自造的 asar 夹具**跑，不碰真实安装目录：夹具覆盖归档布局、
 * 条目偏移语义、哈希一致性、原地复用、幂等与拒绝条件。
 * 另外再对**真实** app.asar 做一次只读状态检查（不写入）。
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readHeader, readEntry, sha256, replaceEntryContent, verifyEntry } from "../lib/asar.js";
import { inspect, patchSource, revertSource, applyPatch, revertPatch, patchStatus, ORIGINAL_SNIPPET, PATCHED_SNIPPET } from "../lib/patch.js";

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log("  PASS  " + name); }
  else { failed += 1; console.log("  FAIL  " + name + (detail ? "\n        " + detail : "")); }
}
function section(title) { console.log("\n=== " + title + " ==="); }

const FIX = join(import.meta.dirname, "fixtures");
const ASAR = "app.asar";

/** 造一个最小但结构真实的 asar 归档。 */
function buildAsar(filePath, entries) {
  // entries: [{ parts: ["lib","main.js"], content: Buffer }]
  const header = { files: {} };
  const blobs = [];
  // 先按顺序排布数据区，offset 相对 dataOffset
  let cursor = 0;
  const placed = [];
  for (const it of entries) {
    const buf = Buffer.isBuffer(it.content) ? it.content : Buffer.from(it.content, "utf8");
    placed.push({ parts: it.parts, buf, offset: cursor });
    cursor += buf.length;
  }
  for (const p of placed) {
    let node = header;
    for (let i = 0; i < p.parts.length - 1; i += 1) {
      const key = p.parts[i];
      node.files[key] = node.files[key] || { files: {} };
      node = node.files[key];
    }
    const hash = sha256(p.buf);
    node.files[p.parts[p.parts.length - 1]] = {
      size: p.buf.length,
      offset: String(p.offset),
      integrity: { algorithm: "SHA256", hash, blockSize: 4194304, blocks: [hash] },
    };
  }
  let json = JSON.stringify(header);
  const jsonBuf = Buffer.from(json, "utf8");
  const strLen = jsonBuf.length;
  // 实测出的真实关系（对 app.asar 逐字节核对）：
  //   headerBufLen = strLen + 8   ->  dataOffset = 8 + headerBufLen = 16 + strLen
  //   四个 uint32 依次是 4 / headerBufLen / headerBufLen-4 / strLen
  const headerBufLen = strLen + 8;
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(headerBufLen, 4);
  prefix.writeUInt32LE(headerBufLen - 4, 8);
  prefix.writeUInt32LE(strLen, 12);
  const data = Buffer.concat(placed.map((p) => p.buf));
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, Buffer.concat([prefix, jsonBuf, data]));
  return { dataOffset: 8 + headerBufLen };
}

// 让夹具里的 main.js 足够长，使"打补丁后更长"与"回退可原地复用"两条路径都被走到
const PADDING = "// padding line to push offsets past six digits\n".repeat(4000);
const FAKE_MAIN = PADDING + "import { randomUUID } from \"node:crypto\";\n" +
  "const OTHER = \"filler\".repeat(30);\n" +
  "class G { acquire(workspace) {\n" +
  "  let partition = \"placeholder\";\n" +
  "  if (partition === void 0) {\n" +
  "    partition = " + ORIGINAL_SNIPPET + ";\n" +
  "  }\n" +
  "  return partition;\n}\n}\n" +
  "export { G };\n" + "// padding\n".repeat(40);

try {
  rmSync(FIX, { recursive: true, force: true });
  mkdirSync(FIX, { recursive: true });

  section("纯文本：识别与改写");
  check("空串识别为 0/0", inspect("").original === 0 && inspect("").patched === 0);
  check("原始源码识别为 1 处", inspect(FAKE_MAIN).original === 1);
  check("改写后识别为 patched 1 处", inspect(patchSource(FAKE_MAIN).source).patched === 1);
  check("改写后不再含原始表达式", patchSource(FAKE_MAIN).source.indexOf(ORIGINAL_SNIPPET) === -1);
  check("改写是幂等的", patchSource(patchSource(FAKE_MAIN).source).changed === false);
  check("回退可还原", revertSource(patchSource(FAKE_MAIN).source).source === FAKE_MAIN);
  check("回退是幂等的", revertSource(FAKE_MAIN).changed === false);
  let threw = false;
  try { patchSource("no snippet here"); } catch { threw = true; }
  check("找不到表达式时拒绝改写", threw);
  threw = false;
  try { patchSource(ORIGINAL_SNIPPET + " and " + ORIGINAL_SNIPPET); } catch { threw = true; }
  check("表达式出现两次时拒绝改写", threw);

  section("归档读写：布局与偏移语义");
  const p = join(FIX, ASAR);
  buildAsar(p, [
    // 先放一个大占位文件，把 main.js 的 offset 顶到 6 位数（模拟真实归档的规模），
    // 这样才能覆盖"追加时新旧偏移位数必须一致"这条保护。
    { parts: ["lib", "big.js"], content: "// big filler\n".repeat(9000) },
    { parts: ["lib", "main.js"], content: FAKE_MAIN },
    { parts: ["package.json"], content: JSON.stringify({ name: "fixture" }) },
    { parts: ["lib", "other.js"], content: "export const x = 1;\n" },
  ]);
  const h = readHeader(p);
  const entry = JSON.parse(h.json).files.lib.files["main.js"];
  check("头部 JSON 可解析", typeof h.json === "string" && h.json.length > 0);
  check("dataOffset = 8 + headerBufLen", h.dataOffset === 8 + h.headerBufLen);
  const readBack = readEntry(p, ["lib", "main.js"]);
  check("按 dataOffset+offset 读回内容哈希一致", sha256(readBack.content) === entry.integrity.hash);
  check("读回内容正确", readBack.content.toString("utf8") === FAKE_MAIN);

  section("写回：追加与原地复用");
  const next = patchSource(FAKE_MAIN).source;
  const sizeBefore = statSync(p).size;
  const w = replaceEntryContent(p, ["lib", "main.js"], Buffer.from(next, "utf8"));
  const sizeAfter = statSync(p).size;
  check("写入报告 changed", w.changed === true);
  check("新内容更长时归档增长", sizeAfter > sizeBefore);
  check("增长量等于新内容长度", sizeAfter - sizeBefore === Buffer.byteLength(next));
  check("复验通过", verifyEntry(p, ["lib", "main.js"]).ok);
  check("读回的是新内容", readEntry(p, ["lib", "main.js"]).content.toString("utf8") === next);
  check("其它条目未被改动", readEntry(p, ["lib", "other.js"]).content.toString("utf8") === "export const x = 1;\n");

  // 回退：新内容更短，应当原地复用
  const sizeMid = statSync(p).size;
  const rb = replaceEntryContent(p, ["lib", "main.js"], Buffer.from(FAKE_MAIN, "utf8"));
  const sizeRevert = statSync(p).size;
  check("回退走原地复用（归档不增长）", sizeRevert === sizeMid);
  check("回退后内容正确", readEntry(p, ["lib", "main.js"]).content.toString("utf8") === FAKE_MAIN);
  check("回退后复验通过", verifyEntry(p, ["lib", "main.js"]).ok);

  section("状态判定与端到端");
  check("回退后状态为 clean", patchStatus({ archivePath: p }).state === "clean");
  const ap = applyPatch({ archivePath: p });
  check("applyPatch 报告 changed", ap.changed === true);
  check("applyPatch 后状态为 applied", patchStatus({ archivePath: p }).state === "applied");
  check("applyPatch 后内容正确", readEntry(p, ["lib", "main.js"]).content.toString("utf8") === next);
  check("applyPatch 生成备份", ap.backup.length > 0 && existsSync(ap.backup));
  const rp = revertPatch({ archivePath: p });
  check("revertPatch 报告 changed", rp.changed === true);
  check("revertPatch 后状态为 clean", patchStatus({ archivePath: p }).state === "clean");
  check("revertPatch 后内容与原始一致", readEntry(p, ["lib", "main.js"]).content.toString("utf8") === FAKE_MAIN);

  section("拒绝条件");
  const p2 = join(FIX, "no-snippet.asar");
  buildAsar(p2, [{ parts: ["lib", "main.js"], content: "const x = 1;\n" }]);
  check("不认识的内容判为 unknown", patchStatus({ archivePath: p2 }).state === "unknown");
  threw = false;
  try { applyPatch({ archivePath: p2 }); } catch { threw = true; }
  check("unknown 时拒绝打补丁", threw);

  section("真实安装目录：只读检查");
  const real = patchStatus({});
  console.log("  状态: " + real.state + " | 布局: " + real.kind + " | 版本: " + (real.version || "—"));
  console.log("  位置: " + (real.main || "—"));
  if (real.supported) {
    check("真实 main.js 能识别出唯一分区表达式", real.state === "applied" || real.state === "clean", "状态=" + real.state + " reason=" + real.reason);
  } else {
    console.log("  SKIP  当前环境找不到安装目录（" + real.reason + "）");
  }
} finally {
  rmSync(FIX, { recursive: true, force: true });
}

console.log("\n" + (failed === 0 ? "全部通过" : "有失败") + "：" + passed + " passed, " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
