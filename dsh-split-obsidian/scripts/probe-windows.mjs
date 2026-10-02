/**
 * 真实窗口实测 —— 会**真的移动你的 DSH 和 Obsidian 窗口**。
 *
 * 用法：node scripts/probe-windows.mjs
 *
 * 跑完之后窗口会停在最后一次并排的位置；按 Ctrl+C 或等它自己结束。
 */
import { ensureServer, placeBoth, placeLeft, queryWindows, focusSide, stop } from "../lib/host-service.js";
import { computeFull, computeSideBySide, describeRatio } from "../lib/layout.js";

const log = (...a) => console.log(...a);

log("=== 启动窗口服务 ===");
const t0 = Date.now();
const srv = await ensureServer();
log("耗时 " + (Date.now()-t0) + "ms  ok=" + srv.ok + "  " + (srv.error || ""));
if (!srv.ok) process.exit(1);
log("工作区 " + JSON.stringify(srv.workArea));
if (srv.obHandle <= 0) { log("★ 没找到 Obsidian 窗口 —— 请先启动 Obsidian"); stop(); process.exit(1); }

log("\n=== 并排 62:38 ===");
{
  const s = computeSideBySide(srv.workArea, 0.62, 8);
  await placeBoth(s.left, s.right);
  log(JSON.stringify(await queryWindows()));
}

log("\n=== 拖动模拟 30 次 ===");
{
  const t = Date.now();
  const N = 30;
  for (let i = 0; i < N; i++) {
    const r = 0.25 + (i/(N-1))*0.5;
    const s = computeSideBySide(srv.workArea, r, 8);
    await placeBoth(s.left, s.right);
  }
  const dt = Date.now()-t;
  log(N + " 次共 " + dt + "ms，平均 " + (dt/N).toFixed(1) + "ms/次");
}

log("\n=== 预设 ===");
for (const r of [0.5, 0.7, 0.38]) {
  const s = computeSideBySide(srv.workArea, r, 8);
  await placeBoth(s.left, s.right);
  log("  " + describeRatio(r) + " ✓");
  await new Promise((res) => setTimeout(res, 250));
}

log("\n=== 聚焦切换 ===");
await focusSide("right"); await new Promise((r)=>setTimeout(r,400));
log("  切到 Obsidian ✓");
await focusSide("left"); await new Promise((r)=>setTimeout(r,400));
log("  切回 DSH ✓");

log("\n=== 还原 DSH 占满 ===");
await placeLeft(computeFull(srv.workArea));
log("  ✓");

stop();
log("\n服务已停");
