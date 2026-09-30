/**
 * tree-scan.js 回归测试：轻量发现路线（git trees API）。
 *
 * 最要紧的一条是 [3]：**把轻量路线和归档路线跑在同一个仓库上，结果必须一致**。
 * 快没有意义 —— 如果它找到的插件集合和"老老实实下整包再扫"不一样，那它就是错的。
 */
import { treeRefCandidates, scanViaTree, TreeTruncatedError, TREE_CACHE_TTL_MS, MAX_MANIFEST_FETCHES } from "../lib/tree-scan.js";
import { fetchArchive, extractArchive, makeTempDir, removeDir, parseRepoUrl } from "../lib/discover.js";
import { scanPluginPackages } from "../lib/scan.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

console.log("\n[1] ref 候选（离线）");
check("空 ref -> HEAD, main, master", JSON.stringify(treeRefCandidates("")) === JSON.stringify(["HEAD", "main", "master"]), JSON.stringify(treeRefCandidates("")));
check("显式 ref 排在最前", treeRefCandidates("dev")[0] === "dev");
check("显式 ref 不会重复出现", treeRefCandidates("main").filter((r) => r === "main").length === 1);
check("候选里一定含 HEAD（省掉一次 /repos 调用）", treeRefCandidates("").includes("HEAD"));
check("缓存 TTL 是 10 分钟", TREE_CACHE_TTL_MS === 10 * 60 * 1000);
check("manifest 抓取有上限", MAX_MANIFEST_FETCHES > 0 && MAX_MANIFEST_FETCHES <= 100, String(MAX_MANIFEST_FETCHES));
check("截断错误是可识别类型", new TreeTruncatedError() instanceof Error && new TreeTruncatedError().name === "TreeTruncatedError");

const SMALL = "https://github.com/dawalixi1980/deepseek-harness";

console.log("\n[2] 轻量路线跑真仓库（网络；失败则 SKIP）");
let treePlugins;
try {
  const loc = parseRepoUrl(SMALL);
  const cacheDir = await mkdtemp(join(tmpdir(), "dsh-plugin-url-tree-"));
  try {
    const started = Date.now();
    const result = await scanViaTree(loc.owner, loc.repo, loc.ref, { cacheDir, subpath: loc.subpath });
    const elapsed = Date.now() - started;

    treePlugins = result.plugins;
    check("ref 解析成功", typeof result.ref === "string" && result.ref.length > 0, result.ref);
    check("首次不是缓存", result.cached === false);
    check("至少发现 1 个插件", result.plugins.length >= 1, String(result.plugins.length));
    check("耗时在合理范围（< 30 秒）", elapsed < 30_000, elapsed + " ms");

    for (const plugin of result.plugins) {
      check(`插件字段齐全：${plugin.name}`,
        typeof plugin.version === "string" && typeof plugin.description === "string" &&
        typeof plugin.subpath === "string" && typeof plugin.patch === "string" &&
        typeof plugin.patchPresent === "boolean" && typeof plugin.web === "boolean" &&
        Array.isArray(plugin.dependencies) && Array.isArray(plugin.buildScripts) &&
        ["ready", "needs-build", "missing-entry"].includes(plugin.readiness),
        JSON.stringify(plugin));
    }
    check("已知插件 dsh-skill-url 在列", result.plugins.some((p) => p.name === "dsh-skill-url"));
    check("patchPresent 为 true（补丁层文件真的在路径清单里）",
      result.plugins.filter((p) => p.name === "dsh-skill-url").every((p) => p.patchPresent === true));

    const second = await scanViaTree(loc.owner, loc.repo, loc.ref, { cacheDir, subpath: loc.subpath });
    check("第二次走缓存（core API 只有 60 次/小时）", second.cached === true);
    check("缓存结果与首次一致", JSON.stringify(second.plugins.map((p) => p.name)) === JSON.stringify(result.plugins.map((p) => p.name)));
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
} catch (error) {
  skipped("轻量路线", String(error?.message ?? error).slice(0, 80));
}

console.log("\n[3] 交叉验证：轻量路线 vs 归档路线，结果必须一致");
try {
  const loc = parseRepoUrl(SMALL);
  const { buffer } = await fetchArchive(loc.owner, loc.repo, loc.ref, {
    cacheDir: "C:\\Users\\Administrator\\.dsh\\cache\\dsh-plugin-url",
  });
  const tempDir = await makeTempDir();
  let archivePlugins;
  try {
    await extractArchive(buffer, tempDir);
    archivePlugins = await scanPluginPackages(tempDir);
  } finally {
    await removeDir(tempDir);
  }

  const key = (list) => list.map((p) => `${p.name}|${p.subpath}|${p.readiness}`).sort();
  const fromTree = key(treePlugins ?? []);
  const fromArchive = key(archivePlugins);
  check("归档路线也能发现插件", archivePlugins.length >= 1, String(archivePlugins.length));
  if (treePlugins === undefined) {
    skipped("两路线一致", "轻量路线本回合不可用");
  } else {
    check("两条路线发现的集合完全一致", JSON.stringify(fromTree) === JSON.stringify(fromArchive),
      `tree=${JSON.stringify(fromTree)} archive=${JSON.stringify(fromArchive)}`);
  }
} catch (error) {
  skipped("交叉验证", String(error?.message ?? error).slice(0, 80));
}

console.log(`\n轻量发现测试：${pass} 项 PASS，${fail} 项 FAIL，${skip} 项 SKIP。`);
if (fail > 0) process.exitCode = 1;
