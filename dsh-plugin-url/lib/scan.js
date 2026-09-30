/**
 * 在解压出来的仓库树里找「插件包」。
 *
 * 判定标准只有一条：目录里有 `package.json`，且它声明了 `dsh.bundle`。
 * 这正是 DSH 插件管理器自己认插件的条件（bundleManifest 读的就是 dsh.bundle.patch，
 * 没有它就是 `not-bundle`），所以这里的识别结果和装完之后的结果必然一致 ——
 * 不会出现「面板里显示了但装不上」。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** 扫描深度上限（与 discover.js 的 MAX_SCAN_DEPTH 一致）。 */
export const MAX_PLUGIN_SCAN_DEPTH = 6;
/** 单仓库最多认多少个插件包。 */
export const MAX_PLUGIN_PACKAGES = 100;

/** 不进扫描的目录。 */
const SKIP_DIRS = new Set(["node_modules", ".git", ".github", ".vscode", ".idea", "vendor"]);

/** 会让安装需要 build 授权（allowBuilds）的生命周期脚本。 */
const BUILD_SCRIPTS = ["preinstall", "install", "postinstall", "prepare", "prepack", "prepublishOnly"];

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 把 main / exports 里的入口点还原成一个相对路径，用于判断产物是否已随包分发。 */
function entryCandidates(manifest) {
  const out = [];
  const push = (value) => {
    if (typeof value === "string") out.push(value);
    else if (value !== null && typeof value === "object") for (const nested of Object.values(value)) push(nested);
  };
  push(manifest.main);
  push(manifest.module);
  push(manifest.exports);
  return out.filter((item) => typeof item === "string" && item.length > 0 && !item.includes("*"));
}

/**
 * 判断一个包现在能不能直接装。
 *   ready          —— 无构建脚本，入口文件真的存在，打包即可用
 *   needs-build    —— 声明了 prepare/postinstall 等：源码包，装的时候要 build 授权，多半会失败
 *   missing-entry  —— 入口文件不在（典型：只发 src/、产物要现场编译）
 */
async function readinessOf(dir, manifest) {
  const scripts = manifest.scripts !== null && typeof manifest.scripts === "object" ? manifest.scripts : {};
  const buildScripts = BUILD_SCRIPTS.filter((key) => typeof scripts[key] === "string" && scripts[key].trim().length > 0);
  if (buildScripts.length > 0) return { readiness: "needs-build", buildScripts };

  const candidates = entryCandidates(manifest);
  if (candidates.length === 0) {
    // 没有入口声明：DSH 的 bundle 补丁行按包名 import，Node 默认找 index.js
    const fallback = (await exists(join(dir, "index.js"))) || (await exists(join(dir, "lib", "index.js")));
    return { readiness: fallback ? "ready" : "missing-entry", buildScripts };
  }
  for (const candidate of candidates) {
    if (await exists(join(dir, candidate.replace(/^\.\//, "")))) return { readiness: "ready", buildScripts };
  }
  return { readiness: "missing-entry", buildScripts };
}

/**
 * 读一个目录下的插件包描述（不是插件包则返回 undefined）。
 * @param {string} dir 目录绝对路径
 * @param {string} subpath 相对仓库根的路径（正斜杠）
 */
async function readPackage(dir, subpath) {
  let raw;
  try {
    raw = await readFile(join(dir, "package.json"), "utf8");
  } catch {
    return undefined;
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (manifest === null || typeof manifest !== "object") return undefined;

  const bundle = manifest.dsh?.bundle;
  // 只有声明了 dsh.bundle 的才算插件：这正是 DSH 自己认插件的门槛
  if (bundle === null || typeof bundle !== "object" || typeof bundle.patch !== "string") return undefined;

  const name = typeof manifest.name === "string" ? manifest.name : "";
  if (name.length === 0) return undefined;

  const patch = bundle.patch;
  const { readiness, buildScripts } = await readinessOf(dir, manifest);
  const dependencies = Object.keys(manifest.dependencies ?? {}).sort();

  return {
    name,
    version: typeof manifest.version === "string" ? manifest.version : "0.0.0",
    description: typeof manifest.description === "string" ? manifest.description : "",
    subpath,
    patch,
    patchPresent: await exists(join(dir, patch.replace(/^\.\//, ""))),
    web: manifest.dsh?.client !== undefined && manifest.dsh?.client !== null,
    dependencies,
    buildScripts,
    readiness,
    license: typeof manifest.license === "string" ? manifest.license : "",
  };
}

/**
 * 递归发现仓库里的插件包。
 * @param {string} rootDir 解压后的仓库根
 * @returns {Promise<Array<object>>} 按 subpath 排序
 */
export async function scanPluginPackages(rootDir) {
  const found = [];

  async function walk(dir, subpath, depth) {
    if (depth > MAX_PLUGIN_SCAN_DEPTH || found.length >= MAX_PLUGIN_PACKAGES) return;

    const pkg = await readPackage(dir, subpath);
    if (pkg !== undefined) found.push(pkg);

    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      if (SKIP_DIRS.has(dirent.name)) continue;
      // 点开头的目录一律跳过（.git/.agents/... ），与 discover.js 的技能扫描一致
      if (dirent.name.startsWith(".")) continue;
      await walk(join(dir, dirent.name), subpath.length === 0 ? dirent.name : `${subpath}/${dirent.name}`, depth + 1);
    }
  }

  await walk(rootDir, "", 0);
  found.sort((a, b) => a.subpath.localeCompare(b.subpath));
  return found;
}
