/**
 * dsh-browser-persist —— 补丁编排层。
 *
 * ## 修的是什么
 *
 * 官方 app.asar/lib/main.js 的 DesktopBrowserGuests.acquire() 这样建侧栏浏览器的分区：
 *
 *      partition = `dsh-sidebar-browser-${randomUUID()}`;
 *
 * 两个问题叠在一起，"重启就要重新登录"是必然的：
 *
 *   1. 没有 persist: 前缀 —— Electron 用进程内会话，进程一退 cookie 全丢；
 *   2. 名字来自 randomUUID() —— 即使补上 persist:，每次启动也是另一个存储目录，
 *      存下来的登录态根本对不上号。
 *
 * ## 改成什么
 *
 * 用官方自己在同文件里用过的写法（平台分区就是这么写的）：
 *
 *      `persist:dsh-sidebar-browser-${createHash('sha256').update(workspace).digest('hex').slice(0, 32)}`
 *
 * createHash 在 main.js 顶部已经 import 进来了，不需要额外引入任何东西。
 * 客户端传进来的 workspace 对同一个工作区文件夹是稳定的（cwd:<路径>），
 * 于是同一工作区在重启后命中同一个持久分区。
 *
 * ## 支持两种安装形态
 *
 *   asar  —— 正式安装包：main.js 在 app.asar 归档里，走 asar.js 的"追加改写"。
 *   directory —— 解包安装 / 从源码跑：main.js 就是普通文件，原子替换即可。
 *
 * ## 安全边界
 *
 *   - 只在**恰好匹配一次**时动手；匹配到 0 或 2 处一律拒绝。
 *   - 认文件：asar 模式下先核对内容哈希与头部记录一致。
 *   - 改完立即复验；失败即报错。
 */
import * as nodeFs from "node:fs";
import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readEntry, replaceEntryContent, resolveRawFs, verifyEntry } from "./asar.js";

export const ORIGINAL_SNIPPET = "`dsh-sidebar-browser-${randomUUID()}`";
export const PATCHED_SNIPPET = "`persist:dsh-sidebar-browser-${createHash('sha256').update(workspace).digest('hex').slice(0, 32)}`";
export const MAIN_PARTS = ["lib", "main.js"];
export const BACKUP_SUFFIX = ".dsh-browser-persist.bak";

/** 数一数两种表达式各出现几次。 */
export function inspect(source) {
  const text = typeof source === "string" ? source : "";
  return {
    original: text.split(ORIGINAL_SNIPPET).length - 1,
    patched: text.split(PATCHED_SNIPPET).length - 1,
  };
}

/** 纯文本：改成已打补丁（幂等）。 */
export function patchSource(source) {
  const found = inspect(source);
  if (found.patched === 1 && found.original === 0) return { changed: false, source: source };
  if (found.original !== 1) {
    throw new Error("main.js 里没有唯一的分区表达式（匹配到 " + found.original + " 处）——官方代码可能已改，已拒绝改动");
  }
  return { changed: true, source: source.split(ORIGINAL_SNIPPET).join(PATCHED_SNIPPET) };
}

/** 纯文本：撤销补丁。 */
export function revertSource(source) {
  const found = inspect(source);
  if (found.original === 1 && found.patched === 0) return { changed: false, source: source };
  if (found.patched !== 1) {
    throw new Error("main.js 里没有唯一的已打补丁表达式（匹配到 " + found.patched + " 处），无法回退");
  }
  return { changed: true, source: source.split(PATCHED_SNIPPET).join(ORIGINAL_SNIPPET) };
}

/** 候选的 app.asar 路径。 */
export function resolveCandidates(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const argv = opts.argv || process.argv;
  const execPath = opts.execPath === undefined ? process.execPath : opts.execPath;
  const out = [];
  const push = (value) => {
    if (typeof value !== "string" || value.length === 0) return;
    if (out.indexOf(value) !== -1) return;
    out.push(value);
  };
  if (env) push(env.DSH_BROWSER_PERSIST_ASAR);
  if (Array.isArray(argv)) {
    for (const arg of argv) {
      if (typeof arg !== "string") continue;
      const index = arg.toLowerCase().indexOf("app.asar");
      if (index === -1) continue;
      push(arg.slice(0, index + "app.asar".length));
    }
  }
  if (typeof execPath === "string" && execPath.length > 0) {
    push(join(dirname(execPath), "resources", "app.asar"));
  }
  if (typeof process.resourcesPath === "string" && process.resourcesPath.length > 0) {
    push(join(process.resourcesPath, "app.asar"));
  }
  return out;
}

/**
 * 定位目标。
 *   kind = "asar"      -> archivePath 是一个归档文件
 *   kind = "directory" -> archivePath 是解包目录，mainPath 是普通文件
 */
export function locateTarget(options) {
  const opts = options || {};
  // 优先用 original-fs：Electron 里 node:fs 被 asar 补丁接管，会把 app.asar
  // 报成目录、并让 openSync 报 ENOENT；original-fs 才是未打补丁的真实视图。
  const rawFs = opts.rawFs || resolveRawFs() || nodeFs;
  const explicit = opts.archivePath;
  const candidates = explicit ? [explicit] : resolveCandidates(opts);
  for (const candidate of candidates) {
    // 两种视图都试：先原始视图认归档文件，再退回被补丁的视图认解包目录。
    for (const probe of [rawFs, nodeFs]) {
      let stat = null;
      try { stat = probe.statSync(candidate); } catch { continue; }
      if (stat.isFile()) {
        return { kind: "asar", archivePath: candidate, mainPath: "", layout: candidate };
      }
      if (stat.isDirectory()) {
        const mainPath = join(candidate, "lib", "main.js");
        try {
          if (probe.statSync(mainPath).isFile()) {
            return { kind: "directory", archivePath: candidate, mainPath: mainPath, layout: candidate };
          }
        } catch { /* 目录形态但不含 main.js，换下一个候选 */ }
      }
    }
  }
  return null;
}

/** 读出 main.js 的文本。 */
export function readMain(target) {
  if (target.kind === "asar") {
    const read = readEntry(target.archivePath, MAIN_PARTS);
    return read.content.toString("utf8");
  }
  return readFileSync(target.mainPath, "utf8");
}

function readDshVersion(target) {
  try {
    const installRoot = dirname(dirname(target.archivePath));
    const file = join(installRoot, "version");
    if (existsSync(file)) return readFileSync(file, "utf8").trim();
  } catch { /* 读不到就不显示 */ }
  return "";
}

/** 当前状态：clean / applied / unknown。 */
export function patchStatus(options) {
  const opts = options || {};
  let target = null;
  try {
    target = locateTarget(opts);
  } catch (error) {
    return { supported: false, reason: String(error && error.message ? error.message : error), layout: "", kind: "", main: "", version: "", state: "unknown", backup: "" };
  }
  if (target === null) {
    return { supported: false, reason: "找不到 DSH 安装目录里的 app.asar / lib/main.js", layout: "", kind: "", main: "", version: "", state: "unknown", backup: "" };
  }
  let source = "";
  try {
    source = readMain(target);
  } catch (error) {
    return { supported: false, reason: "读不到 main.js：" + String(error && error.message ? error.message : error), layout: target.layout, kind: target.kind, main: target.mainPath || target.archivePath, version: "", state: "unknown", backup: "" };
  }
  const found = inspect(source);
  let state = "unknown";
  if (found.patched === 1 && found.original === 0) state = "applied";
  else if (found.original === 1 && found.patched === 0) state = "clean";
  const backup = backupPathFor(target);
  return {
    supported: true,
    reason: state === "unknown" ? "main.js 的分区表达式与已知形态都不匹配，可能是新版本，未做任何改动" : "",
    layout: target.layout,
    kind: target.kind,
    main: target.mainPath || target.archivePath,
    version: readDshVersion(target),
    state: state,
    backup: existsSync(backup) ? backup : "",
  };
}

function backupPathFor(target) {
  return (target.kind === "asar" ? target.archivePath : target.mainPath) + BACKUP_SUFFIX;
}

/** 解包目录形态：备份 + 临时文件 + 原子替换 + 复验。 */
function writeFileAtomic(mainPath, nextText, expectPatched) {
  const before = readFileSync(mainPath, "utf8");
  const result = expectPatched === 1 ? patchSource(before) : revertSource(before);
  const backup = mainPath + BACKUP_SUFFIX;
  if (!result.changed) {
    return { changed: false, backup: existsSync(backup) ? backup : "", message: "已经是目标状态，无需改动" };
  }
  copyFileSync(mainPath, backup);
  const temp = mainPath + ".dsh-browser-persist.tmp";
  writeFileSync(temp, result.source, "utf8");
  if (inspect(readFileSync(temp, "utf8")).patched !== expectPatched) {
    try { unlinkSync(temp); } catch { /* 忽略 */ }
    throw new Error("写入校验未通过，已放弃替换");
  }
  renameSync(temp, mainPath);
  if (inspect(readFileSync(mainPath, "utf8")).patched !== expectPatched) {
    throw new Error("替换后校验未通过");
  }
  return { changed: true, backup: backup, message: expectPatched === 1 ? "补丁已应用，重启 DSH 后生效" : "补丁已撤销，重启 DSH 后生效" };
}

/** 打补丁。 */
export function applyPatch(options) {
  const opts = options || {};
  const target = opts.target || locateTarget(opts);
  if (target === null) throw new Error("找不到 DSH 安装目录里的 app.asar / lib/main.js，无法打补丁");
  const before = readMain(target);
  const result = patchSource(before);
  if (target.kind === "directory") return writeFileAtomic(target.mainPath, result.source, 1);
  if (!result.changed) {
    return { changed: false, backup: existsSync(backupPathFor(target)) ? backupPathFor(target) : "", message: "补丁已经是应用状态，无需改动" };
  }
  const written = replaceEntryContent(target.archivePath, MAIN_PARTS, Buffer.from(result.source, "utf8"));
  const check = verifyEntry(target.archivePath, MAIN_PARTS, written.hash);
  if (!check.ok) throw new Error(check.reason);
  return { changed: true, backup: written.backup, message: "补丁已应用，重启 DSH 后生效", growth: written.growth };
}

/** 撤销补丁。 */
export function revertPatch(options) {
  const opts = options || {};
  const target = opts.target || locateTarget(opts);
  if (target === null) throw new Error("找不到 DSH 安装目录里的 app.asar / lib/main.js，无法回退");
  const before = readMain(target);
  const result = revertSource(before);
  if (target.kind === "directory") return writeFileAtomic(target.mainPath, result.source, 0);
  if (!result.changed) {
    return { changed: false, backup: "", message: "补丁本来就没有应用，无需回退" };
  }
  const written = replaceEntryContent(target.archivePath, MAIN_PARTS, Buffer.from(result.source, "utf8"));
  const check = verifyEntry(target.archivePath, MAIN_PARTS, written.hash);
  if (!check.ok) throw new Error(check.reason);
  return { changed: true, backup: written.backup, message: "补丁已撤销，重启 DSH 后生效", growth: written.growth };
}
