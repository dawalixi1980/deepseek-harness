/**
 * 轻量发现：用 GitHub 的 git trees API，不下载整包归档。
 *
 * 为什么需要它 —— 实测一个真实仓库（elysia395/dsh-wallpaper-engine，GitHub 报 83 MiB）：
 *
 *   整包归档路线：下载 83 MiB → 解压到磁盘 → 递归遍历        ≈ 5 分钟以上，还没跑完
 *   trees API 路线：一个 48 KiB 的路径清单 + 2 个 package.json ≈ 3.5 秒
 *
 * 那个仓库 83 MiB 全压在某几个巨型媒体文件上，**文件总数只有 169 个** ——
 * 为了找两个 package.json 把 83 MiB 全下下来纯属浪费。
 *
 * 代价与边界：
 *   - 走的是 core API（未认证 60 次/小时），所以结果缓存 10 分钟；每次浏览仓库只花 1 次。
 *   - 路径清单会被 GitHub 截断（超大仓库），`truncated` 时不返回结果，让调用方回退到归档路线。
 *   - 只有**公开仓库**能用（raw.githubusercontent 匿名读取）。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 路径清单缓存时长（core API 配额只有 60 次/小时）。 */
export const TREE_CACHE_TTL_MS = 10 * 60 * 1000;
/** 单次请求超时。 */
export const TREE_REQUEST_TIMEOUT_MS = 20_000;
/** 最多去抓多少个 package.json（防极端仓库打爆配额）。 */
export const MAX_MANIFEST_FETCHES = 40;

const SKIP_DIRS = new Set(["node_modules", ".git", ".github", ".vscode", ".idea", "vendor"]);
const BUILD_SCRIPTS = ["preinstall", "install", "postinstall", "prepare", "prepack", "prepublishOnly"];

/** 路径清单被截断时抛这个，调用方据此回退到归档路线。 */
export class TreeTruncatedError extends Error {
  constructor() {
    super("仓库路径清单被 GitHub 截断（仓库过大），改用归档扫描");
    this.name = "TreeTruncatedError";
  }
}

/**
 * 依次尝试的 ref：显式 ref → HEAD → main → master。
 * HEAD 让 GitHub 自己解析默认分支，省掉一次 /repos 调用。
 */
export function treeRefCandidates(ref) {
  const out = [];
  for (const value of [ref, "HEAD", "main", "master"]) {
    if (typeof value === "string" && value.length > 0 && !out.includes(value)) out.push(value);
  }
  return out;
}

/** 取消时抛这个，调用方据此把任务标成「已取消」而不是「失败」。 */
export class CancelledError extends Error {
  constructor() {
    super("已取消");
    this.name = "CancelledError";
  }
}

/**
 * 一次 GET。超时用内部 controller，外部取消用传入的 signal —— 两者合并。
 */
async function getJson(url, accept, signal) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), TREE_REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([timeout.signal, signal]) : timeout.signal;
  try {
    const response = await fetch(url, {
      signal: combined,
      redirect: "follow",
      headers: { accept, "user-agent": "dsh-plugin-url" },
    });
    if (response.status === 403 || response.status === 429) {
      const reset = Number(response.headers.get("x-ratelimit-reset") ?? 0);
      const when = reset > 0 ? new Date(reset * 1000).toLocaleTimeString() : "稍后";
      throw new Error(`GitHub API 限流（未认证 60 次/小时）。请在 ${when} 之后重试。`);
    }
    if (response.status === 404) return { notFound: true };
    if (!response.ok) throw new Error(`GitHub API 返回 HTTP ${response.status}`);
    return { body: await response.json() };
  } catch (error) {
    // 外部取消要和"超时/网络失败"区分开，否则任务会被标成失败
    if (signal?.aborted === true) throw new CancelledError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readCache(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (typeof parsed?.at === "number" && Date.now() - parsed.at < TREE_CACHE_TTL_MS) return parsed;
  } catch { /* 没缓存 */ }
  return undefined;
}

/**
 * 抓一个 package.json，带重试。
 *
 * 为什么要重试：实测抓 `dsh-lexiang/package.json` 时 raw.githubusercontent 偶发
 * `fetch failed`。而下面的循环原本是 `catch { continue; }` —— 也就是**一次瞬时抖动就会
 * 静默漏掉一个插件**，用户看到的是不完整的列表、还没有任何提示。这个必须重试。
 */
const MANIFEST_RETRIES = 2;

async function getJsonRetry(url, accept, signal) {
  let last;
  for (let attempt = 0; attempt <= MANIFEST_RETRIES; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    try {
      return await getJson(url, accept, signal);
    } catch (error) {
      if (error instanceof CancelledError) throw error;
      if (signal?.aborted === true) throw new CancelledError();
      last = error;
    }
  }
  throw last ?? new Error("请求失败");
}

/**
 * 取一个仓库的**路径清单**（只取 blob，不取目录）。
 * @returns {Promise<{ref: string, truncated: boolean, paths: string[], sizes: Map<string, number>, cached: boolean}>}
 */
export async function fetchRepoTree(owner, repo, ref, options = {}) {
  const signal = options.signal;
  if (signal?.aborted === true) throw new CancelledError();
  const cacheRoot = options.cacheDir;
  const cacheFile = typeof cacheRoot === "string" && cacheRoot.length > 0
    ? join(cacheRoot, "trees", `${owner}__${repo}__${(ref || "HEAD").replace(/[^a-zA-Z0-9._-]/g, "_")}.json`)
    : undefined;

  if (cacheFile !== undefined) {
    const cached = await readCache(cacheFile);
    if (cached !== undefined) {
      return {
        ref: cached.ref,
        truncated: cached.truncated === true,
        paths: cached.paths,
        sizes: new Map(cached.sizes ?? []),
        cached: true,
      };
    }
  }

  let lastError;
  for (const candidate of treeRefCandidates(ref)) {
    const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(candidate)}?recursive=1`;
    const result = await getJson(url, "application/vnd.github+json", signal);
    if (result.notFound === true) continue;
    if (result.body === undefined) continue;
    const blobs = Array.isArray(result.body.tree) ? result.body.tree.filter((node) => node?.type === "blob") : [];
    const payload = {
      ref: candidate,
      truncated: result.body.truncated === true,
      paths: blobs.map((node) => String(node.path ?? "")).filter((path) => path.length > 0),
      sizes: blobs.map((node) => [String(node.path ?? ""), Number(node.size ?? 0)]).filter(([path]) => path.length > 0),
    };
    if (cacheFile !== undefined) {
      try {
        await mkdir(dirname(cacheFile), { recursive: true });
        await writeFile(cacheFile, JSON.stringify({ at: Date.now(), ...payload }), "utf8");
      } catch { /* 缓存写不进去不影响结果 */ }
    }
    return { ...payload, sizes: new Map(payload.sizes), cached: false };
  }
  throw lastError ?? new Error(`在 ${owner}/${repo} 上找不到可用的分支（试过 ${treeRefCandidates(ref).join(", ")}）`);
}

/** 一条路径要不要参与「包发现」。 */
function isCandidateManifest(path) {
  if (path === "package.json") return true;
  if (!path.endsWith("/package.json")) return false;
  const segments = path.split("/");
  // 只看目录段；末段一定是 package.json
  for (const segment of segments.slice(0, -1)) {
    if (SKIP_DIRS.has(segment)) return false;
    if (segment.startsWith(".")) return false;
  }
  return true;
}

function subpathOf(manifestPath) {
  return manifestPath === "package.json" ? "" : manifestPath.slice(0, -"/package.json".length);
}

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

/** 用手上的路径集合判断 ready / needs-build / missing-entry —— 不用再下任何东西。 */
function readinessOf(manifest, entries, dirPrefix, pathSet) {
  const scripts = manifest.scripts !== null && typeof manifest.scripts === "object" ? manifest.scripts : {};
  const buildScripts = BUILD_SCRIPTS.filter((key) => typeof scripts[key] === "string" && scripts[key].trim().length > 0);
  if (buildScripts.length > 0) return { readiness: "needs-build", buildScripts };

  const absolute = (relative) => (dirPrefix.length === 0 ? relative : `${dirPrefix}/${relative}`);
  const candidates = entryCandidates(manifest);
  if (candidates.length === 0) {
    const fallback = pathSet.has(absolute("index.js")) || pathSet.has(absolute("lib/index.js"));
    return { readiness: fallback ? "ready" : "missing-entry", buildScripts };
  }
  for (const candidate of candidates) {
    if (pathSet.has(absolute(candidate.replace(/^\.\//, "")))) return { readiness: "ready", buildScripts };
  }
  return { readiness: "missing-entry", buildScripts };
}

/**
 * 用 trees API 发现插件包（每个条目的字段与 scan.js 的 scanPluginPackages 完全一致）。
 * @returns {Promise<{plugins: object[], ref: string, cached: boolean}>}
 * @throws {TreeTruncatedError} 路径清单被截断，调用方应回退
 */
export async function scanViaTree(owner, repo, ref, options = {}) {
  const signal = options.signal;
  const tree = await fetchRepoTree(owner, repo, ref, { cacheDir: options.cacheDir, signal });
  if (tree.truncated) throw new TreeTruncatedError();

  const pathSet = new Set(tree.paths);
  let manifests = tree.paths.filter(isCandidateManifest);

  // subpath 收窄（与归档路线语义一致）
  const scope = String(options.subpath ?? "").replace(/^\/+|\/+$/g, "");
  if (scope.length > 0) {
    const prefix = `${scope}/`;
    manifests = manifests.filter((path) => path.startsWith(prefix));
  }

  manifests.sort();
  const found = [];
  /** 重试之后仍然读不到的 package.json —— 报出去，别静默吞掉。 */
  const unreadable = [];
  for (const manifestPath of manifests.slice(0, MAX_MANIFEST_FETCHES)) {
    if (signal?.aborted === true) throw new CancelledError();
    const subpath = subpathOf(manifestPath);
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${tree.ref}/${manifestPath}`;
    let manifest;
    try {
      const result = await getJsonRetry(url, "text/plain", signal);
      if (result.notFound === true || result.body === undefined) {
        unreadable.push(manifestPath);
        continue;
      }
      manifest = result.body;
    } catch (error) {
      // 取消要往上抛，不能被当成"这个 package.json 读不到"静默跳过
      if (error instanceof CancelledError) throw error;
      unreadable.push(manifestPath);
      continue;
    }
    if (manifest === null || typeof manifest !== "object") continue;
    const bundle = manifest.dsh?.bundle;
    // 与官方 bundleManifest 同门槛：必须声明 dsh.bundle.patch
    if (bundle === null || typeof bundle !== "object" || typeof bundle.patch !== "string") continue;
    const name = typeof manifest.name === "string" ? manifest.name : "";
    if (name.length === 0) continue;

    const { readiness, buildScripts } = readinessOf(manifest, pathSet, subpath, pathSet);
    const patch = bundle.patch;
    const patchPath = subpath.length === 0 ? patch.replace(/^\.\//, "") : `${subpath}/${patch.replace(/^\.\//, "")}`;

    found.push({
      name,
      version: typeof manifest.version === "string" ? manifest.version : "0.0.0",
      description: typeof manifest.description === "string" ? manifest.description : "",
      subpath,
      patch,
      patchPresent: pathSet.has(patchPath),
      web: manifest.dsh?.client !== undefined && manifest.dsh?.client !== null,
      dependencies: Object.keys(manifest.dependencies ?? {}).sort(),
      buildScripts,
      readiness,
      license: typeof manifest.license === "string" ? manifest.license : "",
    });
  }

  found.sort((a, b) => a.subpath.localeCompare(b.subpath));
  return { plugins: found, ref: tree.ref, cached: tree.cached, unreadable };
}
