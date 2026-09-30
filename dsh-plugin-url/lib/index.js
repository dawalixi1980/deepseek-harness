/**
 * dsh-plugin-url —— host 半。
 *
 * 一个 Typert Remote 服务（"pluginUrl"），暴露：
 *   - inspect(url)              粘贴网址 → 解析 + 下载 + 递归发现插件包（不落盘）
 *   - installPlugin(url, sub)   把指定插件打成 npm tarball 并交给插件管理器安装
 *   - uninstallPlugin(name)     卸载
 *   - listInstalled()           已装的可管理插件（含来源仓库）
 *   - rememberUrl/recentUrls/forgetUrl  常用仓库网址
 *
 * 与 dsh-skill-url 的关系：那个管技能（SKILL.md），这个管插件（dsh.bundle）。
 * 两者共用同一套「网址 → 归档 → 递归扫描」实现（discover.js 逐字复用）。
 *
 * 安装为什么走「自己打 tarball」而不是把仓库子目录路径丢给 pnpm：
 *   1. DSH 的 git 安装只认仓库根 = 包根，不支持子目录；
 *   2. 本地目录是 link 安装，不递归装 dependencies，且会把临时解压目录变成永久依赖；
 *   3. tarball 是插件管理器实测唯一开箱即用的形式（install-spec.js 里 .tgz 走 kind:'tarball'）。
 */
import { z } from "zod";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  extractArchive,
  fetchArchive,
  makeTempDir,
  parseRepoUrl,
  removeDir,
} from "./discover.js";
import { scanPluginPackages } from "./scan.js";
import { buildNpmTarball } from "./tarball.js";

export const name = "plugin-url";
/** 没有插件管理器这个插件毫无意义：它同时也是我们安装动作的执行者。 */
export const inject = ["pluginManager", "typert"];

/** 已安装来源记录文件名。 */
const STATE_FILE = "dsh-plugin-url.json";
/** 最多保存多少条仓库网址。 */
const MAX_SAVED_SITES = 12;

function resolveDshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === "string" && env.trim().length > 0) return env.trim();
  return join(homedir(), ".dsh");
}

function stateFilePath() {
  return join(resolveDshHome(), STATE_FILE);
}

/** 归档缓存目录（与 discover.js 的 fetchArchive 约定一致）。 */
function cacheDir() {
  return join(resolveDshHome(), "cache", "dsh-plugin-url");
}

/** 自产 tarball 的落点：这个目录必须长期存在，profile 的 dependencies 指向它。 */
function tarballDir() {
  return join(cacheDir(), "tarballs");
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** 来源记录：{ installed: {<包名>: {...}}, recent: [{url,label,at}] }。 */
async function loadState() {
  const parsed = await readJson(stateFilePath());
  const installed =
    parsed !== null && typeof parsed === "object" && parsed.installed !== null && typeof parsed?.installed === "object"
      ? parsed.installed
      : {};
  const recent = Array.isArray(parsed?.recent)
    ? parsed.recent.filter((entry) => entry !== null && typeof entry === "object" && typeof entry.url === "string")
    : [];
  return { installed, recent };
}

async function saveState(state) {
  await mkdir(resolveDshHome(), { recursive: true });
  await writeFile(
    stateFilePath(),
    JSON.stringify({ installed: state.installed ?? {}, recent: state.recent ?? [] }, null, 2),
    "utf8",
  );
}

/** 把用户输入归一化成一条可保存的记录（能解析成仓库坐标就存 GitHub 首页，去重更狠）。 */
function savedSiteOf(raw) {
  const text = String(raw ?? "").trim();
  if (text.length === 0) return undefined;
  try {
    const loc = parseRepoUrl(text);
    return { url: `https://github.com/${loc.owner}/${loc.repo}`, label: `${loc.owner}/${loc.repo}`, at: Date.now() };
  } catch {
    return { url: text, label: text, at: Date.now() };
  }
}

/** 把一个插件目录打成 tarball 写到磁盘，返回路径与字节数。 */
async function packPlugin(pkgDir, pkgName, version) {
  const buffer = await buildNpmTarball(pkgDir);
  const safe = `${pkgName.replace(/[^a-zA-Z0-9._-]/g, "_")}-${version.replace(/[^a-zA-Z0-9._-]/g, "_")}.tgz`;
  const dir = tarballDir();
  await mkdir(dir, { recursive: true });
  const file = join(dir, safe);
  await writeFile(file, buffer);
  return { file, bytes: buffer.length };
}

/** 判断一个目录是不是插件包（有 package.json 且声明 dsh.bundle）。 */
async function isPluginDir(dir) {
  const manifest = await readJson(join(dir, "package.json"));
  return manifest?.dsh?.bundle !== null && typeof manifest?.dsh?.bundle === "object" && typeof manifest.dsh.bundle.patch === "string";
}

/** 按目录名递归找一个插件包目录（深度 ≤4）。 */
async function findPluginDirByName(dir, target, depth = 0) {
  if (depth > 4 || typeof target !== "string" || target.length === 0) return undefined;
  let dirents;
  try {
    const { readdir } = await import("node:fs/promises");
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const dirent of dirents) {
    if (!dirent.isDirectory() || dirent.name.startsWith(".") || dirent.name === "node_modules") continue;
    const path = join(dir, dirent.name);
    if (dirent.name.toLowerCase() === target.toLowerCase() && (await isPluginDir(path))) return path;
    const found = await findPluginDirByName(path, target, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** 把插件管理器的失败结果/异常压成一句人能读的话。 */
function describeOutcome(outcome) {
  const code = outcome?.error?.code ?? "unknown";
  const parts = [`插件管理器拒绝了这个安装（${code}）`];
  if (outcome?.error?.diagnostic !== undefined) parts.push(String(outcome.error.diagnostic));
  const output = outcome?.packageResult?.output;
  if (typeof output === "string" && output.trim().length > 0) {
    const tail = output.trim().split("\n").slice(-4).join("\n");
    parts.push(tail);
  }
  if (Array.isArray(outcome?.pendingBuilds) && outcome.pendingBuilds.length > 0) {
    parts.push(`这些包需要构建授权（allowBuilds）：${outcome.pendingBuilds.join(", ")}`);
  }
  return parts.join(" —— ");
}

// ── wire schemas ──────────────────────────────────────────────────────────

const discoveredPluginSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string(),
  subpath: z.string(),
  patch: z.string(),
  patchPresent: z.boolean(),
  web: z.boolean(),
  license: z.string(),
  dependencies: z.array(z.string()),
  buildScripts: z.array(z.string()),
  readiness: z.string(),
  installed: z.boolean(),
});

const inspectResultSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  ref: z.string(),
  subpath: z.string(),
  plugins: z.array(discoveredPluginSchema),
  totalScanned: z.number(),
  cached: z.boolean(),
});

const installResultSchema = z.object({
  name: z.string(),
  version: z.string(),
  subpath: z.string(),
  application: z.string(),
  changed: z.boolean(),
  bytes: z.number(),
  warnings: z.array(z.string()),
});

const installedPluginSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  removable: z.boolean(),
  errorCode: z.string(),
  owner: z.string().optional(),
  repo: z.string().optional(),
  ref: z.string().optional(),
  subpath: z.string().optional(),
});

const listInstalledResultSchema = z.object({ plugins: z.array(installedPluginSchema) });

const uninstallResultSchema = z.object({
  name: z.string(),
  removed: z.boolean(),
  application: z.string(),
});

const savedSiteSchema = z.object({
  url: z.string(),
  label: z.string(),
  at: z.number(),
});

const savedSitesResultSchema = z.object({ sites: z.array(savedSiteSchema) });

/**
 * 远程 schema codec 工厂。
 *
 * DSH 的 typert 注册表只认这一种形状：strict codec 必须带 `create()` 工厂，
 * 运行期按 `codec.create().parse(value)` 做边界校验。
 * 写成 `{ mode, typeSymbol, schema }` 会在 ctx.typert.register() 时直接抛
 *   "typert: <id> result strict codec has no create() factory"
 * 于是整条插件项激活失败。注意声明顺序：这个 const 必须在 MANIFEST 之前，
 * 否则模块求值期就会踩 TDZ（`Cannot access 'codec' before initialization`）。
 */
const codec = (typeSymbol, schema) => ({ mode: "strict", typeSymbol, create: () => schema });

/** 注册到 API 网关的远程描述符。 */
const MANIFEST = {
  package: "dsh-plugin-url",
  face: "host",
  schemas: [],
  invocations: [
    {
      id: "dsh-plugin-url#pluginUrl/inspect",
      service: "pluginUrl",
      namespace: "pluginUrl",
      method: "inspect",
      invocation: { kind: "direct" },
      parameters: [
        { name: "url", wire: "url", source: "json", codec: codec("dsh-plugin-url#UrlText", z.string()) },
      ],
      result: codec("dsh-plugin-url#InspectPluginsResult", inspectResultSchema),
    },
    {
      // 线名不能叫 install：客户端 api 的 RemoteNamespaceService 原型上已有 install()，
      // assertMethodAvailable 会直接抛 "conflicts with its namespace service"。
      id: "dsh-plugin-url#pluginUrl/installPlugin",
      service: "pluginUrl",
      namespace: "pluginUrl",
      method: "installPlugin",
      invocation: { kind: "direct" },
      parameters: [
        { name: "url", wire: "url", source: "json", codec: codec("dsh-plugin-url#UrlText", z.string()) },
        { name: "subpath", wire: "subpath", source: "json", codec: codec("dsh-plugin-url#Subpath", z.string()) },
      ],
      result: codec("dsh-plugin-url#InstallPluginResult", installResultSchema),
    },
    {
      id: "dsh-plugin-url#pluginUrl/uninstallPlugin",
      service: "pluginUrl",
      namespace: "pluginUrl",
      method: "uninstallPlugin",
      invocation: { kind: "direct" },
      parameters: [
        { name: "name", wire: "name", source: "json", codec: codec("dsh-plugin-url#PackageName", z.string()) },
      ],
      result: codec("dsh-plugin-url#UninstallPluginResult", uninstallResultSchema),
    },
    {
      id: "dsh-plugin-url#pluginUrl/listInstalled",
      service: "pluginUrl",
      namespace: "pluginUrl",
      method: "listInstalled",
      invocation: { kind: "direct" },
      parameters: [],
      result: codec("dsh-plugin-url#ListInstalledPluginsResult", listInstalledResultSchema),
    },
    {
      id: "dsh-plugin-url#pluginUrl/rememberUrl",
      service: "pluginUrl",
      namespace: "pluginUrl",
      method: "rememberUrl",
      invocation: { kind: "direct" },
      parameters: [
        { name: "url", wire: "url", source: "json", codec: codec("dsh-plugin-url#UrlText", z.string()) },
      ],
      result: codec("dsh-plugin-url#SavedSitesResult", savedSitesResultSchema),
    },
    {
      id: "dsh-plugin-url#pluginUrl/recentUrls",
      service: "pluginUrl",
      namespace: "pluginUrl",
      method: "recentUrls",
      invocation: { kind: "direct" },
      parameters: [],
      result: codec("dsh-plugin-url#SavedSitesResult", savedSitesResultSchema),
    },
    {
      id: "dsh-plugin-url#pluginUrl/forgetUrl",
      service: "pluginUrl",
      namespace: "pluginUrl",
      method: "forgetUrl",
      invocation: { kind: "direct" },
      parameters: [
        { name: "url", wire: "url", source: "json", codec: codec("dsh-plugin-url#UrlText", z.string()) },
      ],
      result: codec("dsh-plugin-url#SavedSitesResult", savedSitesResultSchema),
    },
  ],
  model: { services: [], events: [], objects: [] },
};

// ── 远程服务 ──────────────────────────────────────────────────────────────

class PluginUrlGateway extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, "pluginUrl");
    this.hostCtx = ctx;
  }

  /** 每次调用现取，避免持有被替换掉的实例。 */
  manager() {
    const pm = this.hostCtx.get("pluginManager");
    if (pm === undefined || pm === null) throw new Error("pluginManager 服务不可用，无法安装插件");
    return pm;
  }

  /** 当前已装 bundle 名集合（用于在发现列表里标「已安装」）。 */
  async installedNames() {
    try {
      const bundles = await this.manager().listBundles();
      return new Set(bundles.filter((item) => item.installed).map((item) => item.name));
    } catch {
      return new Set();
    }
  }

  /**
   * 粘贴网址 → 发现插件清单（只读，不落盘）。
   * 下载与解压都在临时目录，结束后清理。
   */
  async inspect(url) {
    const loc = parseRepoUrl(url);
    const { buffer, ref, cached } = await fetchArchive(loc.owner, loc.repo, loc.ref, { cacheDir: cacheDir() });

    const tempDir = await makeTempDir();
    try {
      await extractArchive(buffer, tempDir);
      let scanDir = tempDir;
      // subpath 收窄扫描范围时，结果里的 subpath 必须**补回前缀**，
      // 否则面板显示的是相对子目录的路径，而 installPlugin 是按相对仓库根找的，两边对不上。
      let prefix = "";
      if (loc.subpath.length > 0) {
        const candidate = join(tempDir, loc.subpath);
        // subpath 不存在时不报错：回退扫全仓库，用户仍能看到能装的东西
        if (await exists(candidate)) {
          scanDir = candidate;
          prefix = loc.subpath;
        }
      }
      const found = await scanPluginPackages(scanDir);
      const installed = await this.installedNames();
      return {
        owner: loc.owner,
        repo: loc.repo,
        ref,
        subpath: loc.subpath,
        totalScanned: found.length,
        cached,
        plugins: found.map((plugin) => ({
          ...plugin,
          subpath: prefix.length === 0 ? plugin.subpath : `${prefix}/${plugin.subpath}`,
          installed: installed.has(plugin.name),
        })),
      };
    } finally {
      await removeDir(tempDir);
    }
  }

  /**
   * 从网址安装一个插件。
   * 流程：解压 → 定位包目录 → 纯 Node 打 npm tarball → 交给插件管理器安装。
   * 方法名不能叫 install（撞客户端 RemoteNamespaceService 原型），故为 installPlugin。
   */
  async installPlugin(url, subpath) {
    const target = String(subpath ?? "").trim();
    if (target.length === 0) throw new Error("缺少插件目录（subpath）");

    const loc = parseRepoUrl(url);
    const { buffer, ref } = await fetchArchive(loc.owner, loc.repo, loc.ref, { cacheDir: cacheDir() });

    const tempDir = await makeTempDir();
    try {
      await extractArchive(buffer, tempDir);

      let pkgDir;
      const direct = join(tempDir, target);
      if (await isPluginDir(direct)) {
        pkgDir = direct;
      } else {
        pkgDir = await findPluginDirByName(tempDir, target.split("/").pop());
      }
      if (pkgDir === undefined) throw new Error(`仓库里找不到这个插件目录：${target}`);

      const manifest = await readJson(join(pkgDir, "package.json"));
      if (manifest?.dsh?.bundle === undefined) throw new Error(`该目录没有声明 dsh.bundle，不是 DSH 插件：${target}`);
      const pkgName = String(manifest.name ?? "");
      if (pkgName.length === 0) throw new Error("该插件的 package.json 没有 name");
      const version = String(manifest.version ?? "0.0.0");

      const { file, bytes } = await packPlugin(pkgDir, pkgName, version);

      // 先把来源记上：安装成功会触发 profile 重载，本进程可能在 RPC 返回前就被卸载，
      // 那时再去写 state 已经来不及了。失败则回滚。
      const state = await loadState();
      const previous = state.installed[pkgName];
      state.installed[pkgName] = { owner: loc.owner, repo: loc.repo, ref, subpath: target, version, at: Date.now() };
      await saveState(state);

      let outcome;
      try {
        outcome = await this.manager().installBundle(file, { enabled: true });
      } catch (error) {
        if (previous === undefined) delete state.installed[pkgName];
        else state.installed[pkgName] = previous;
        await saveState(state);
        throw new Error(String(error?.message ?? error));
      }

      if (outcome?.application === "failed" || outcome?.error !== undefined) {
        if (previous === undefined) delete state.installed[pkgName];
        else state.installed[pkgName] = previous;
        await saveState(state);
        throw new Error(describeOutcome(outcome));
      }

      return {
        name: pkgName,
        version,
        subpath: target,
        application: String(outcome?.application ?? "applied"),
        changed: outcome?.changed === true,
        bytes,
        warnings: Array.isArray(outcome?.warnings) ? outcome.warnings.map(String) : [],
      };
    } finally {
      await removeDir(tempDir);
    }
  }

  /** 卸载一个由本面板装上去的插件。 */
  async uninstallPlugin(name) {
    const pkgName = String(name ?? "").trim();
    if (pkgName.length === 0) throw new Error("插件名为空");

    const pm = this.manager();
    const bundles = await pm.listBundles();
    const info = bundles.find((item) => item.name === pkgName);
    if (info === undefined || info.installed !== true) throw new Error(`未安装这个插件：${pkgName}`);
    if (info.removable !== true) {
      throw new Error(`这个插件不能从面板卸载（${info.readOnlyReason ?? info.error?.code ?? "受管理保护"}）`);
    }

    const outcome = await pm.removeBundle(pkgName);
    if (outcome?.application === "failed" || outcome?.error !== undefined) throw new Error(describeOutcome(outcome));

    const state = await loadState();
    delete state.installed[pkgName];
    await saveState(state);

    return { name: pkgName, removed: true, application: String(outcome?.application ?? "applied") };
  }

  /** 已安装的可管理插件列表（含来源仓库标注）。 */
  async listInstalled() {
    const pm = this.manager();
    const bundles = await pm.listBundles();
    const { installed } = await loadState();

    const plugins = bundles
      .filter((item) => item.installed === true)
      .map((item) => {
        const src = installed[item.name];
        return {
          name: item.name,
          version: String(item.version ?? ""),
          description: String(item.description ?? ""),
          enabled: item.enabled === true,
          removable: item.removable === true,
          errorCode: String(item.error?.code ?? ""),
          ...(src === undefined
            ? {}
            : { owner: src.owner, repo: src.repo, ref: src.ref, subpath: src.subpath }),
        };
      });

    plugins.sort((a, b) => a.name.localeCompare(b.name));
    return { plugins };
  }

  // ── 已保存的仓库网址 ───────────────────────────────────────────────────

  async rememberUrl(url) {
    const site = savedSiteOf(url);
    if (site === undefined) throw new Error("网址为空，无法保存");
    const state = await loadState();
    const recent = [site, ...state.recent.filter((entry) => entry.url !== site.url)].slice(0, MAX_SAVED_SITES);
    state.recent = recent;
    await saveState(state);
    return { sites: recent };
  }

  async recentUrls() {
    const { recent } = await loadState();
    return { sites: recent };
  }

  async forgetUrl(url) {
    const site = savedSiteOf(url);
    const target = site === undefined ? String(url ?? "").trim() : site.url;
    const state = await loadState();
    const recent = state.recent.filter((entry) => entry.url !== target);
    state.recent = recent;
    await saveState(state);
    return { sites: recent };
  }
}

export function apply(ctx) {
  const gateway = new PluginUrlGateway(ctx);
  ctx.effect(() => ctx.typert.register(MANIFEST), "plugin-url: typert manifest");
  return gateway;
}
