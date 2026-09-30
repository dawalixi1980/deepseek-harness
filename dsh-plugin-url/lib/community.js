/**
 * 社区插件检索：GitHub 搜索 API（只读公开数据，不带任何 token）。
 *
 * 两条重要现实：
 *   1. `topic:dsh-plugin` 下有上万仓库，而且**大量仓库挂着标签却不是 DSH 插件**
 *      （比如各种 resume / memory 项目顺手打了这个 topic）。所以搜索结果只是
 *      「候选仓库」，真正是不是插件必须点开扫一遍才知道 —— 本模块只负责检索，
 *      不做任何"这是插件"的判断。
 *   2. 未认证的搜索 API 只有 **10 次/分钟**。为了不把配额烧在重复请求上，
 *      结果按 `查询|页码` 缓存 10 分钟；搜索只在用户点按钮时触发，不做输入即搜。
 *
 * 安全边界：不读取、不存储、不发送任何凭证（与 discover.js 的承诺一致）。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 固定检索的话题。 */
export const DEFAULT_TOPIC = "dsh-plugin";
/** 单页条数（GitHub 上限 100，这里取 30：够用且省配额）。 */
export const MAX_PAGE_SIZE = 30;
/** 结果缓存时长。 */
export const COMMUNITY_CACHE_TTL_MS = 10 * 60 * 1000;
/** 单次请求超时。 */
export const SEARCH_TIMEOUT_MS = 20_000;
/** 关键词长度上限。 */
const KEYWORD_MAX = 120;

const API = "https://api.github.com/search/repositories";

/**
 * 把用户追加的关键词并进固定 topic 查询。
 * 空关键词 = 纯按话题、按星数排。
 * @param {string} keywords 用户输入（可为空）
 * @returns {string} GitHub 搜索查询串
 */
export function buildCommunityQuery(keywords) {
  const text = String(keywords ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, KEYWORD_MAX);
  return text.length === 0 ? `topic:${DEFAULT_TOPIC}` : `topic:${DEFAULT_TOPIC} ${text}`;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** 把 GitHub 的仓库对象压成面板要的几个字段。 */
function toRepo(item) {
  return {
    fullName: String(item?.full_name ?? ""),
    owner: String(item?.owner?.login ?? ""),
    repo: String(item?.name ?? ""),
    description: String(item?.description ?? ""),
    stars: Number(item?.stargazers_count ?? 0),
    forks: Number(item?.forks_count ?? 0),
    updatedAt: String(item?.pushed_at ?? item?.updated_at ?? ""),
    defaultBranch: String(item?.default_branch ?? ""),
    archived: item?.archived === true,
    topics: Array.isArray(item?.topics) ? item.topics.slice(0, 8).map(String) : [],
  };
}

/**
 * 按话题检索社区仓库。
 * @param {string} keywords 追加关键词（空则只按话题）
 * @param {number} page 页码，从 1 起（上限 10，GitHub 搜索 API 自身限制）
 * @param {{cacheDir?: string}} options cacheDir 为结果缓存根目录，缺省则不缓存
 * @returns {Promise<{query: string, page: number, total: number, items: object[], cached: boolean}>}
 */
export async function searchCommunity(keywords, page, options = {}) {
  const query = buildCommunityQuery(keywords);
  const pageNumber = Math.min(10, Math.max(1, Math.floor(Number(page) || 1)));
  const root = options.cacheDir;
  const file = typeof root === "string" && root.length > 0
    ? join(root, "community", `${Buffer.from(`${query}|${pageNumber}`, "utf8").toString("base64url")}.json`)
    : undefined;

  if (file !== undefined) {
    const cached = await readJson(file);
    if (
      cached !== undefined &&
      typeof cached.at === "number" &&
      Date.now() - cached.at < COMMUNITY_CACHE_TTL_MS &&
      cached.payload !== undefined
    ) {
      return { ...cached.payload, cached: true };
    }
  }

  const url = `${API}?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${MAX_PAGE_SIZE}&page=${pageNumber}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { accept: "application/vnd.github+json", "user-agent": "dsh-plugin-url" },
    });
  } catch (error) {
    const reason = error?.name === "AbortError" ? `超过 ${SEARCH_TIMEOUT_MS / 1000} 秒未响应` : String(error?.message ?? error);
    throw new Error(`搜索失败：${reason}`);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 403 || response.status === 429) {
    const reset = Number(response.headers.get("x-ratelimit-reset") ?? 0);
    const when = reset > 0 ? new Date(reset * 1000).toLocaleTimeString() : "稍后";
    throw new Error(`GitHub 搜索限流了（未认证状态下 10 次/分钟）。请在 ${when} 之后重试，或直接用上面的「粘贴仓库地址」。`);
  }
  if (!response.ok) throw new Error(`GitHub 搜索返回 HTTP ${response.status}`);

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("GitHub 搜索返回了无法解析的内容");
  }

  const payload = {
    query,
    page: pageNumber,
    total: Number(body?.total_count ?? 0),
    items: Array.isArray(body?.items) ? body.items.map(toRepo).filter((repo) => repo.fullName.length > 0) : [],
    cached: false,
  };

  if (file !== undefined) {
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ at: Date.now(), payload }), "utf8");
    } catch {
      // 缓存写不进去不影响检索结果
    }
  }
  return payload;
}
