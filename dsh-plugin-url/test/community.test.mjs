/**
 * community.js 回归测试：GitHub 社区检索。
 *
 * 分四段，前两段**完全离线、永远跑**（查询串构造 + 缓存读取），后两段需要网络：
 *   [1] 查询串构造   —— 纯函数，确定
 *   [2] 缓存读取     —— 预置一份缓存文件，断言「命中缓存就不打网络」（用假 total 证明）
 *   [3] 真实检索     —— 网络；限流/断网时记 SKIP 而不是 FAIL
 *   [4] 缓存写入     —— 需要一次真实请求
 *
 * 为什么缓存要单独测：未认证的搜索 API 只有 10 次/分钟，缓存是唯一护栏，
 * 它坏了就会在用户手里几秒钟烧光配额，而且现象很难复现。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { buildCommunityQuery, searchCommunity, DEFAULT_TOPIC, MAX_PAGE_SIZE } from "../lib/community.js";

let pass = 0;
let fail = 0;
let skip = 0;
function check(label, condition, detail) {
  if (condition) {
    pass += 1;
    console.log("  PASS  " + label);
  } else {
    fail += 1;
    console.log("  FAIL  " + label + (detail === undefined ? "" : "  -> " + detail));
  }
}
function skipped(label, why) {
  skip += 1;
  console.log("  SKIP  " + label + (why === undefined ? "" : "  (" + why + ")"));
}

/** 复现模块内部的缓存路径规则，用于预置/检查缓存文件。 */
function cachePath(cacheDir, query, page) {
  return join(cacheDir, "community", `${Buffer.from(`${query}|${page}`, "utf8").toString("base64url")}.json`);
}
function payloadOf(total) {
  return {
    query: `topic:${DEFAULT_TOPIC}`,
    page: 1,
    total,
    items: [{
      fullName: "fake/repo", owner: "fake", repo: "repo", description: "seeded", stars: 1,
      forks: 0, updatedAt: "2026-01-01T00:00:00Z", defaultBranch: "main", archived: false, topics: [],
    }],
    cached: false,
  };
}

console.log("\n[1] 查询串构造（固定 topic + 可追加关键词）");
check("空关键词 = 只按话题", buildCommunityQuery("") === `topic:${DEFAULT_TOPIC}`, buildCommunityQuery(""));
check("undefined 也当空", buildCommunityQuery(undefined) === `topic:${DEFAULT_TOPIC}`);
check("只有空格也算空", buildCommunityQuery("   \t\n ") === `topic:${DEFAULT_TOPIC}`);
check("追加关键词", buildCommunityQuery("markdown") === `topic:${DEFAULT_TOPIC} markdown`, buildCommunityQuery("markdown"));
check("多个关键词保留顺序", buildCommunityQuery("diagram  mermaid") === `topic:${DEFAULT_TOPIC} diagram mermaid`, buildCommunityQuery("diagram  mermaid"));
check("换行/制表符被压成空格", buildCommunityQuery("a\nb\tc") === `topic:${DEFAULT_TOPIC} a b c`, buildCommunityQuery("a\nb\tc"));
check("首尾空白被裁掉", buildCommunityQuery("  x  ") === `topic:${DEFAULT_TOPIC} x`);
check("超长关键词被截断", buildCommunityQuery("z".repeat(500)).length <= `topic:${DEFAULT_TOPIC} `.length + 120);
check("话题名是 dsh-plugin", DEFAULT_TOPIC === "dsh-plugin");
check("单页条数不超过 100", MAX_PAGE_SIZE <= 100, String(MAX_PAGE_SIZE));

console.log("\n[2] 缓存读取（离线：预置假数据，若打网络就会得到真 total，断言即失败）");
const offlineDir = await mkdtemp(join(tmpdir(), "dsh-plugin-url-cache-offline-"));
try {
  const query = `topic:${DEFAULT_TOPIC}`;
  const file = cachePath(offlineDir, query, 1);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ at: Date.now(), payload: payloadOf(424242) }), "utf8");

  const hit = await searchCommunity("", 1, { cacheDir: offlineDir });
  check("新鲜缓存被命中（cached=true）", hit.cached === true);
  check("返回的是缓存里的假 total（证明没打网络）", hit.total === 424242, String(hit.total));
  check("缓存命中保留 query/page", hit.query === query && hit.page === 1);

  const otherPage = cachePath(offlineDir, query, 2);
  check("不同页码的缓存路径不同", otherPage !== file);

  // 过期缓存必须被忽略 —— 用超过 TTL 的 at
  await writeFile(file, JSON.stringify({ at: Date.now() - 11 * 60 * 1000, payload: payloadOf(999999) }), "utf8");
  try {
    const stale = await searchCommunity("", 1, { cacheDir: offlineDir });
    check("过期缓存被忽略（不能返回假 total 999999）", stale.total !== 999999, String(stale.total));
  } catch (error) {
    skipped("过期缓存被忽略", String(error?.message ?? error).slice(0, 60));
  }
} finally {
  await rm(offlineDir, { recursive: true, force: true });
}

console.log("\n[3] 真实检索（网络；限流或断网则 SKIP）");
try {
  const first = await searchCommunity("", 1, {});
  check("返回结构完整", typeof first.query === "string" && typeof first.total === "number" && Array.isArray(first.items));
  check("query 是 topic 查询", first.query === `topic:${DEFAULT_TOPIC}`, first.query);
  check("确实有结果", first.items.length > 0, `items=${first.items.length}`);
  check("总数很大（这个话题下仓库很多）", first.total > 100, String(first.total));

  const repo = first.items[0];
  check("仓库字段齐全", typeof repo.fullName === "string" && repo.fullName.includes("/") && typeof repo.stars === "number");
  check("owner/repo 与 fullName 对得上", repo.fullName === repo.owner + "/" + repo.repo, `${repo.fullName} vs ${repo.owner}/${repo.repo}`);
  check("按星数降序", first.items.every((item, index) => index === 0 || first.items[index - 1].stars >= item.stars));
  check("topics 是字符串数组", Array.isArray(repo.topics) && repo.topics.every((topic) => typeof topic === "string"));
  check("updatedAt 形如 ISO", /^\d{4}-\d{2}-\d{2}/.test(repo.updatedAt), repo.updatedAt);

  const narrowed = await searchCommunity("markdown", 1, {});
  check("追加关键词后查询串正确", narrowed.query === `topic:${DEFAULT_TOPIC} markdown`, narrowed.query);
  check("追加关键词后总数变小", narrowed.total <= first.total, `${narrowed.total} vs ${first.total}`);

  const page2 = await searchCommunity("", 2, {});
  check("第 2 页页码正确", page2.page === 2, String(page2.page));
  check("第 2 页内容与第 1 页不同", page2.items.length === 0 || page2.items[0].fullName !== first.items[0].fullName);

  console.log("\n[4] 缓存写入（需要一次真实请求）");
  const writeDir = await mkdtemp(join(tmpdir(), "dsh-plugin-url-cache-write-"));
  try {
    const live = await searchCommunity("mermaid", 1, { cacheDir: writeDir });
    check("带 cacheDir 首次仍打网络", live.cached === false);
    const re = await searchCommunity("mermaid", 1, { cacheDir: writeDir });
    check("同查询第二次走缓存", re.cached === true);
    check("缓存结果与首次数目一致", re.total === live.total && re.items.length === live.items.length);
    check("不同页码不复用缓存", (await searchCommunity("mermaid", 2, { cacheDir: writeDir })).cached === false);
  } finally {
    await rm(writeDir, { recursive: true, force: true });
  }
} catch (error) {
  skipped("真实检索 / 缓存写入", String(error?.message ?? error).slice(0, 70));
}

console.log(`\n社区检索测试：${pass} 项 PASS，${fail} 项 FAIL，${skip} 项 SKIP。`);
if (fail > 0) process.exitCode = 1;
