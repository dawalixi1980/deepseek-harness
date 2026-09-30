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
import { searchCommunity } from "./community.js";
import { scanViaTree } from "./tree-scan.js";

export const name = "plugin-url";
/** 没有插件管理器这个插件毫无意义：它同时也是我们安装动作的执行者。 */
export const inject = ["pluginManager", "typert"];

/** 已安装来源记录文件名。 */
const STATE_FILE = "dsh-plugin-url.json";
/** 最多保存多少条仓库网址。 */
const MAX_SAVED_SITES = 12;
/** 后台任务表最多留多少条（进程内，重启即清）。 */
const MAX_BACKGROUND_JOBS = 10;

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
  /** 走的是哪条发现路线：tree = 轻量路径清单，archive = 下载整包归档回退。 */
  method: z.string(),
  /** 重试后仍然读不到的 package.json —— 报出去，别让用户以为"就这些"。 */
  unreadable: z.array(z.string()),
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
 * 社区检索结果里的一条仓库。
 * 注意：这里只描述**仓库本身**，不代表它一定是 DSH 插件 —— topic 不能当证据，
 * 点开扫过 dsh.bundle 才算数。
 */
const communityRepoSchema = z.object({
  fullName: z.string(),
  owner: z.string(),
  repo: z.string(),
  description: z.string(),
  stars: z.number(),
  forks: z.number(),
  updatedAt: z.string(),
  defaultBranch: z.string(),
  archived: z.boolean(),
  topics: z.array(z.string()),
});

const searchCommunityResultSchema = z.object({
  query: z.string(),
  page: z.number(),
  total: z.number(),
  items: z.array(communityRepoSchema),
  cached: z.boolean(),
});

/** 一条后台任务（客户端只读展示）。 */
const backgroundJobSchema = z.object({
  id: z.string(),
  kind: z.string(),
  url: z.string(),
  subpath: z.string(),
  label: z.string(),
  phase: z.string(),
  startedAt: z.number(),
  endedAt: z.number(),
  error: z.string(),
  summary: z.string(),
  cancellable: z.boolean(),
});

/** 取消一个后台任务。 */
const cancelJobResultSchema = z.object({
  id: z.string(),
  cancelled: z.boolean(),
  status: z.string(),
});

const backgroundStatusResultSchema = z.object({
  jobs: z.array(backgroundJobSchema),
  results: z.array(
    z.object({
      url: z.string(),
      label: z.string(),
      at: z.number(),
      result: inspectResultSchema,
    }),
  ),
});

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
    {
      // 社区检索：按 topic:dsh-plugin（可追加关键词）找候选仓库。
      // 只返回仓库元信息，不做"这是不是插件"的判断 —— 那要等点开扫过。
      id: "dsh-plugin-url#pluginUrl/searchCommunity",
      service: "pluginUrl",
      namespace: "pluginUrl",
      method: "searchCommunity",
      invocation: { kind: "direct" },
      parameters: [
        { name: "keywords", wire: "keywords", source: "json", codec: codec("dsh-plugin-url#Keywords", z.string()) },
        { name: "page", wire: "page", source: "json", codec: codec("dsh-plugin-url#Page", z.number()) },
      ],
      result: codec("dsh-plugin-url#SearchCommunityResult", searchCommunityResultSchema),
    },
    {
      // 后台任务状态：面板挂载时先读它，就能「关掉再开、原地续上」。
      id: "dsh-plugin-url#pluginUrl/backgroundStatus",
      service: "pluginUrl",
      namespace: "pluginUrl",
      method: "backgroundStatus",
      invocation: { kind: "direct" },
      parameters: [],
      result: codec("dsh-plugin-url#BackgroundStatusResult", backgroundStatusResultSchema),
    },
    {
      // 取消一个正在跑的后台任务
      id: "dsh-plugin-url#pluginUrl/cancelJob",
      service: "pluginUrl",
      namespace: "pluginUrl",
      method: "cancelJob",
      invocation: { kind: "direct" },
      parameters: [
        { name: "id", wire: "id", source: "json", codec: codec("dsh-plugin-url#JobId", z.string()) },
      ],
      result: codec("dsh-plugin-url#CancelJobResult", cancelJobResultSchema),
    },
  ],
  model: { services: [], events: [], objects: [] },
};

// ── 远程服务 ──────────────────────────────────────────────────────────────

class PluginUrlGateway extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, "pluginUrl");
    this.hostCtx = ctx;
    /**
     * 后台任务表（进程内，重启即清）。
     *
     * 为什么要有它：设置页那个面板是一个 React 组件，用户一退出设置组件就卸载，
     * 它手里的状态全没了 —— 但**真正干活的 host 进程一直在跑**。所以把"正在干什么 /
     * 干完了什么"记录在这里，面板重开时用 backgroundStatus() 原地续上，
     * 而不是让用户从头再扫一遍。
     */
    this.jobs = [];
    /** 「类型|目标」 -> 正在跑的任务，用来去重（同一个仓库不会下两遍）。 */
    this.running = new Map();
    /** 仓库 URL -> 最近一次成功的发现结果（重开面板秒出）。 */
    this.results = new Map();
  }

  /** 每次调用现取，避免持有被替换掉的实例。 */
  manager() {
    const pm = this.hostCtx.get("pluginManager");
    if (pm === undefined || pm === null) throw new Error("pluginManager 服务不可用，无法安装插件");
    return pm;
  }

  /** 一句话状态，客户端直接显示。 */
  static summaryOf(job) {
    if (job.phase === "running") {
      return job.kind === "install" ? `正在安装 ${job.label}` : `正在扫描 ${job.label}`;
    }
    if (job.phase === "cancelled") return `${job.label} 已取消`;
    if (job.phase === "failed") return `${job.label} 失败`;
    return job.kind === "install" ? `${job.label} 已安装` : `${job.label} 扫描完成`;
  }

  /**
   * 跑一个后台任务；同一把 key 已经在跑就直接接上去，不重复下载。
   * 任务本身与客户端在不在无关 —— 这正是"关掉面板也继续"的实现方式。
   *
   * 每个任务带一个 AbortController：取消时把 signal 一路传到下载/扫描，
   * 让网络请求真的停下来，而不是只把界面上的那行字删掉。
   */
  startJob({ kind, key, url, subpath, label }, work) {
    const existing = this.running.get(key);
    if (existing !== undefined) return existing.promise;

    // 同一个目标又跑了一次（用户重开面板后又点了一次「查找」）：把旧的**已完成**记录换掉。
    // 不这么做的话，任务列表里会堆一屏一模一样的「扫描完成」—— 就是那个"太繁杂"。
    this.jobs = this.jobs.filter((job) => job.key !== key || job.phase === "running");

    const controller = new AbortController();
    const job = {
      id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      key,
      kind,
      url,
      subpath,
      label,
      phase: "running",
      startedAt: Date.now(),
      endedAt: 0,
      error: "",
      summary: "",
      controller,
      cancelRequested: false,
      /** 安装用：交给官方插件管理器的 requestId，取消时要用它。 */
      requestId: "",
    };
    this.jobs.unshift(job);
    if (this.jobs.length > MAX_BACKGROUND_JOBS) this.jobs.length = MAX_BACKGROUND_JOBS;

    const promise = (async () => {
      try {
        const result = await work(controller.signal, job);
        job.phase = "done";
        job.endedAt = Date.now();
        if (kind === "inspect") this.results.set(url, { url, label, at: job.endedAt, result });
        return result;
      } catch (error) {
        job.endedAt = Date.now();
        // 用 cancelRequested 判定而不是 signal.aborted：安装那步有自己的取消通道，
        // 偶尔会"太晚了"（官方返回 too-late，安装其实成功了），那种情况不该标成已取消。
        if (job.cancelRequested === true) {
          job.phase = "cancelled";
          job.error = "";
          throw new Error("已取消");
        }
        job.phase = "failed";
        job.error = String(error?.message ?? error);
        throw error;
      } finally {
        this.running.delete(key);
        job.summary = PluginUrlGateway.summaryOf(job);
      }
    })();

    job.promise = promise;
    this.running.set(key, job);
    return promise;
  }

  /**
   * 取消一个正在跑的后台任务。
   * 安装走官方 `cancelInstall`（它会自己回滚 package.json / pnpm-lock.yaml），
   * 扫描走我们自己的 AbortController。
   */
  async cancelJob(id) {
    const job = this.jobs.find((item) => item.id === id);
    if (job === undefined) throw new Error(`没有这个后台任务：${id}`);
    if (job.phase !== "running") return { id, cancelled: false, status: job.phase };

    job.cancelRequested = true;
    if (job.kind === "install" && job.requestId.length > 0) {
      try {
        await this.manager().cancelInstall(job.requestId);
      } catch {
        // 已经结束、或者已经进入应用阶段 —— 下面的 abort 兜底
      }
    }
    job.controller.abort();
    return { id, cancelled: true, status: "cancelling" };
  }

  /** 后台状态：最近的任务 + 最近的发现结果。客户端轮询它。 */
  backgroundStatus() {
    const results = [...this.results.values()].sort((a, b) => b.at - a.at);
    return {
      jobs: this.jobs.map((job) => ({
        id: job.id,
        kind: job.kind,
        url: job.url,
        subpath: job.subpath,
        label: job.label,
        phase: job.phase,
        startedAt: job.startedAt,
        endedAt: job.endedAt,
        error: job.error,
        summary: job.summary ?? PluginUrlGateway.summaryOf(job),
        cancellable: job.phase === "running",
      })),
      results,
    };
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
   * 粘贴网址 → 发现插件清单。
   * 外面包一层后台任务：客户端的 promise 就算因为面板关闭而没人接，host 这边照样跑完，
   * 结果留在 results 里，重开面板用 backgroundStatus() 取回。
   * 同一个 URL 正在扫时直接接上去，不重复下载。
   */
  async inspect(url) {
    const loc = parseRepoUrl(url);
    return this.startJob(
      { kind: "inspect", key: `inspect|${url}`, url, subpath: loc.subpath, label: `${loc.owner}/${loc.repo}` },
      (signal) => this.runInspect(url, signal),
    );
  }

  /**
   * 发现的实际实现。两条路线，快的那条优先：
   *   1. tree 路线（默认）：git trees API 拿路径清单 → 只抓几个 package.json。实测大仓库
   *      3.5 秒 vs 归档路线 5 分钟以上（仓库 83 MiB 但只有 169 个文件，全压在媒体文件上）。
   *   2. 归档路线（回退）：路径清单被截断、core API 限流、或 raw 读不到时，退回原来的
   *      「下载整包 → 解压 → 遍历」，慢但一定能扫全。
   * `signal` 是后台任务的取消信号，一路传到 fetch，让"取消"真的停下网络请求。
   */
  async runInspect(url, signal) {
    const loc = parseRepoUrl(url);
    const installed = await this.installedNames();

    let found;
    let ref;
    let cached;
    let method;
    /** 重试之后仍然读不到的 package.json —— 一路带到界面上，避免"静默少几个"。 */
    let unreadable = [];
    try {
      const tree = await scanViaTree(loc.owner, loc.repo, loc.ref, { cacheDir: cacheDir(), subpath: loc.subpath, signal });
      found = tree.plugins;
      ref = tree.ref;
      cached = tree.cached;
      method = "tree";
      unreadable = tree.unreadable ?? [];
    } catch (error) {
      // 取消不是失败：绝不能掉进归档回退，否则用户点了"取消"反而开始下整包
      if (signal?.aborted === true) throw new Error("已取消");
      // 截断/限流/网络问题都走回退，不让用户卡在"太久了"
      const { buffer, ref: archiveRef, cached: archiveCached } = await fetchArchive(loc.owner, loc.repo, loc.ref, {
        cacheDir: cacheDir(),
        signal,
      });
      ref = archiveRef;
      cached = archiveCached;
      method = "archive";
      const tempDir = await makeTempDir();
      try {
        if (signal?.aborted === true) throw new Error("已取消");
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
        found = (await scanPluginPackages(scanDir)).map((plugin) => ({
          ...plugin,
          subpath: prefix.length === 0 ? plugin.subpath : `${prefix}/${plugin.subpath}`,
        }));
      } finally {
        await removeDir(tempDir);
      }
      void error;
    }

    return {
      owner: loc.owner,
      repo: loc.repo,
      ref,
      subpath: loc.subpath,
      totalScanned: found.length,
      cached,
      method,
      unreadable,
      plugins: found.map((plugin) => ({ ...plugin, installed: installed.has(plugin.name) })),
    };
  }

  /**
   * 从网址安装一个插件。
   * 同样包一层后台任务：安装要下整包 + 打 tarball + 让插件管理器重载 profile，
   * 慢是正常的 —— 关掉面板不该让它白跑。同一个 (url, subpath) 连点两次也只会跑一次。
   * 方法名不能叫 install（撞客户端 RemoteNamespaceService 原型），故为 installPlugin。
   */
  async installPlugin(url, subpath) {
    // subpath 允许为空串：那表示「仓库根本身就是插件包」（很常见，比如
    // elysia395/dsh-wallpaper-engine）。此时 join(tempDir, "") === tempDir，
    // 下面按包目录校验即可，不能在这里当成"缺参数"拒掉。
    const target = String(subpath ?? "").trim();
    const loc = parseRepoUrl(url);
    const label = target.length === 0 ? `${loc.owner}/${loc.repo}` : `${loc.owner}/${loc.repo}:${target}`;
    return this.startJob(
      { kind: "install", key: `install|${url}|${target}`, url, subpath: target, label },
      (signal, job) => this.runInstall(url, target, signal, job),
    );
  }

  /** 安装的实际实现。`job` 用来登记 requestId —— 取消安装要靠它。 */
  async runInstall(url, target, signal, job) {
    const loc = parseRepoUrl(url);
    const { buffer, ref } = await fetchArchive(loc.owner, loc.repo, loc.ref, { cacheDir: cacheDir(), signal });

    const tempDir = await makeTempDir();
    try {
      if (signal?.aborted === true) throw new Error("已取消");
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
      // 交给官方插件管理器时带一个 requestId：取消安装要用它调 cancelInstall，
      // 由管理器自己回滚 package.json / pnpm-lock.yaml（比我们自己收拾干净）。
      const requestId = `dsh-plugin-url-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      job.requestId = requestId;
      if (signal?.aborted === true) throw new Error("已取消");
      try {
        outcome = await this.manager().installBundle(file, { enabled: true, requestId });
      } catch (error) {
        if (previous === undefined) delete state.installed[pkgName];
        else state.installed[pkgName] = previous;
        await saveState(state);
        throw new Error(String(error?.message ?? error));
      } finally {
        job.requestId = "";
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

  // ── 社区检索 ───────────────────────────────────────────────────────────

  /**
   * 按 topic:dsh-plugin 检索社区仓库（可追加关键词）。
   * 结果只是候选仓库：是不是插件，要等用户点开、走 inspect 扫过 dsh.bundle 才知道。
   */
  async searchCommunity(keywords, page) {
    return searchCommunity(keywords, page, { cacheDir: cacheDir() });
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
