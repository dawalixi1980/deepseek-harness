/**
 * host 侧后台任务机制的单测：去重 / 取消 / 状态流转。
 *
 * 这两条正是用户实际踩到的：
 *   - 每次重开面板再点「查找」，任务表里就多一条一模一样的「扫描完成」→ 界面太繁杂
 *   - 任务跑起来之后没法取消
 *
 * lib/index.js 顶层 import 了 zod / @deepseek-ai/dsh-typert-protocol 以及同目录的
 * discover.js / scan.js / tarball.js / community.js / tree-scan.js，
 * 所以照 validate-typert-contract.mjs 的做法：复制真实源码 + 最小桩。
 */
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, "..");
const tmpRoot = await mkdtemp(join(tmpdir(), "dsh-plugin-url-jobs-"));

async function writeModule(relativeDir, source) {
  const dir = join(tmpRoot, "node_modules", relativeDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: relativeDir, version: "0.0.0", type: "module", main: "index.js" }), "utf8");
  await writeFile(join(dir, "index.js"), source, "utf8");
}

try {
  for (const file of ["index.js", "discover.js", "scan.js", "tarball.js", "community.js", "tree-scan.js"]) {
    await copyFile(join(pluginRoot, "lib", file), join(tmpRoot, file));
  }
  // zod 桩：只需要顶层工厂 + optional
  await writeModule("zod", [
    "const leaf = (kind) => { const o = { kind }; o.optional = () => ({ kind, optional: true }); return o; };",
    "export const z = {",
    "  object: (shape) => ({ kind: 'object', shape }),",
    "  string: () => leaf('string'),",
    "  number: () => leaf('number'),",
    "  boolean: () => leaf('boolean'),",
    "  array: (item) => ({ kind: 'array', item }),",
    "};",
    "export default { z };",
  ].join("\n"));
  await writeModule("@deepseek-ai/dsh-typert-protocol", "export class TypertRemoteService { constructor(ctx, name) { this.ctx = ctx; this.name = name; } }\n");

  const mod = await import(pathToFileURL(join(tmpRoot, "index.js")).href);

  // 极简 ctx：只需要 effect / typert.register / get
  const fakeManager = { listBundles: async () => [], installBundle: async () => ({ application: "applied" }), cancelInstall: async () => ({ status: "cancelled" }) };
  const ctx = {
    get: (key) => (key === "pluginManager" ? fakeManager : undefined),
    effect: (fn) => { fn(); return () => {}; },
    typert: { register: () => () => {} },
  };
  const gateway = mod.apply(ctx);
  check("apply() 返回网关实例", gateway !== undefined && gateway !== null);
  check("初始后台状态为空", gateway.backgroundStatus().jobs.length === 0);

  const jobSpec = (url, key) => ({ kind: "inspect", key: key ?? `inspect|${url}`, url, subpath: "", label: `owner/${url}` });

  console.log("\n[1] 去重：同一个目标反复跑，任务表不堆叠");
  await gateway.startJob(jobSpec("repoA"), async () => ({ ok: 1 }));
  const afterFirst = gateway.backgroundStatus().jobs.length;
  check("第一次跑完留下一条记录", afterFirst === 1, String(afterFirst));
  await gateway.startJob(jobSpec("repoA"), async () => ({ ok: 2 }));
  const afterSecond = gateway.backgroundStatus().jobs.length;
  check("同一个 key 再跑不会新增记录（这就是「不再堆一屏」）", afterSecond === 1, String(afterSecond));
  await gateway.startJob(jobSpec("repoB"), async () => ({ ok: 3 }));
  check("不同目标仍然各自留一条", gateway.backgroundStatus().jobs.length === 2, String(gateway.backgroundStatus().jobs.length));

  console.log("\n[2] 并发去重：同一个 key 正在跑时接上去，不重复执行");
  let workCalls = 0;
  const slowWork = (signal) => new Promise((resolve) => { workCalls += 1; setTimeout(() => resolve({ done: true }), 20); });
  const first = gateway.startJob({ ...jobSpec("repoC"), key: "inspect|repoC" }, slowWork);
  const second = gateway.startJob({ ...jobSpec("repoC"), key: "inspect|repoC" }, slowWork);
  check("两次调用拿到同一个 promise", first === second);
  await Promise.all([first, second]);
  check("底层 work 只被执行一次", workCalls === 1, String(workCalls));

  console.log("\n[3] 取消：abort 真的传到 work，状态变 cancelled");
  let sawSignal;
  const pending = gateway.startJob(jobSpec("repoD"), (signal) => new Promise((resolve, reject) => {
    sawSignal = signal;
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  }));
  await Promise.resolve();
  const runningJob = gateway.backgroundStatus().jobs.find((job) => job.url === "repoD");
  check("进行中的任务标记为 cancellable", runningJob?.cancellable === true, JSON.stringify(runningJob));
  check("进行中的 phase 是 running", runningJob?.phase === "running", runningJob?.phase);

  const cancelResult = await gateway.cancelJob(runningJob.id);
  check("cancelJob 返回 cancelled=true", cancelResult.cancelled === true && cancelResult.id === runningJob.id, JSON.stringify(cancelResult));
  check("signal 真的被 abort 了", sawSignal?.aborted === true);

  const rejected = await pending.then(() => "resolved", (error) => error);
  check("取消时抛的是「已取消」而不是底层错误", String(rejected?.message ?? rejected).includes("已取消"), String(rejected?.message ?? rejected));

  const cancelledJob = gateway.backgroundStatus().jobs.find((job) => job.id === runningJob.id);
  check("任务被标成 cancelled", cancelledJob?.phase === "cancelled", cancelledJob?.phase);
  check("已取消的任务不再可取消", cancelledJob?.cancellable === false);
  check("已取消的摘要写明「已取消」", String(cancelledJob?.summary).includes("已取消"), cancelledJob?.summary);
  check("已取消不留 error 文本", cancelledJob?.error === "", cancelledJob?.error);

  const again = await gateway.cancelJob(runningJob.id);
  check("对已结束的任务再取消是无害的", again.cancelled === false && again.status === "cancelled", JSON.stringify(again));

  console.log("\n[4] 普通失败仍然标 failed，且保留原因");
  const failed = gateway.startJob(jobSpec("repoE"), async () => { throw new Error("网络炸了"); });
  await failed.catch(() => {});
  const failedJob = gateway.backgroundStatus().jobs.find((job) => job.url === "repoE");
  check("phase 是 failed", failedJob?.phase === "failed", failedJob?.phase);
  check("原因被保留下来", String(failedJob?.error).includes("网络炸了"), failedJob?.error);
  check("失败的不能取消", failedJob?.cancellable === false);

  console.log("\n[5] 只有成功才进「最近结果」缓存");
  const status = gateway.backgroundStatus();
  const cachedUrls = status.results.map((entry) => entry.url);
  check("成功的目标进了结果缓存", cachedUrls.includes("repoA") && cachedUrls.includes("repoC"), JSON.stringify(cachedUrls));
  check("失败/取消的目标没进缓存", !cachedUrls.includes("repoD") && !cachedUrls.includes("repoE"), JSON.stringify(cachedUrls));

  console.log("\n[6] 取消不存在的任务要报错");
  const missing = await gateway.cancelJob("no-such-job").then(() => null, (error) => error);
  check("取消不存在的任务抛错", missing instanceof Error && String(missing.message).includes("no-such-job"), String(missing?.message));
} finally {
  await rm(tmpRoot, { recursive: true, force: true });
}

console.log(`\n后台任务测试：${pass} 项 PASS，${fail} 项 FAIL。`);
if (fail > 0) process.exitCode = 1;
