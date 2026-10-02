/**
 * dsh-split-obsidian —— host 半。
 *
 * 一个 Typert Remote 服务（obsidianSplit），把"让 DSH 和 Obsidian 并排"这件事
 * 暴露给界面：
 *
 *   status()      当前能不能用（找到两个窗口没有、屏幕多大）
 *   snap(ratio)   按比例并排
 *   drag(ratio)   拖动中的高频调用（比 snap 轻）
 *   unsnap()      还原（DSH 占满工作区）
 *   focus(side)   把焦点给某一侧
 *   openVault()   用 obsidian:// 让 Obsidian 定位到指定库
 *
 * ## 这不是"把 Obsidian 嵌进 DSH"
 *
 * 那是做不到的：Obsidian 是独立桌面程序，DSH 侧栏是 webview，只能装网页。
 * 这里做的是**操作系统层面的窗口平铺** —— 两个独立窗口在屏幕上并排，中间留一条缝。
 *
 * ## 窗口操作的实现在哪
 *
 * lib/host-service.js（常驻 PowerShell 客户端）+ lib/snap-server.ps1（Win32 调用）。
 * 拖动性能的关键在那两个文件，见它们的注释。
 */
import { z } from "zod";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { spawn } from "node:child_process";
import {
  ensureServer,
  focusSide,
  placeBoth,
  placeLeft,
  queryWindows,
  refreshHandles,
  stop as stopService
} from "./host-service.js";
import {
  clampRatio,
  computeFull,
  computeSideBySide,
  DEFAULT_GAP,
  describeRatio,
  PRESETS
} from "./layout.js";

export const name = "obsidian-split";
export const inject = ["typert"];

/** 记住当前比例 —— 拖动之后 unsnap 再 snap 应该回到同一个比例。 */
let lastRatio = 0.62;

/**
 * 用 obsidian:// 让 Obsidian 定位到某个库。
 *
 * 用 rundll32 而不是 cmd start：cmd start 会把 URI 里的 & 当成命令分隔符截断
 * （实测踩过），rundll32 url.dll,FileProtocolHandler 走系统协议解析，不截断。
 */
function openObsidianUri(uri) {
  return new Promise((resolve) => {
    const child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", uri], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.on("error", () => resolve(false));
    child.unref();
    setTimeout(() => resolve(true), 120);
  });
}

// ── wire schemas ──────────────────────────────────────────────────────────
const workAreaSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
const rectSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

const statusSchema = z.object({
  available: z.boolean(),
  reason: z.string(),
  dshHandle: z.number(),
  obHandle: z.number(),
  workArea: workAreaSchema,
  ratio: z.number(),
  gap: z.number(),
  presets: z.array(z.number()),
  snapped: z.boolean()
});

const actionSchema = z.object({
  ok: z.boolean(),
  ratio: z.number(),
  label: z.string(),
  left: rectSchema,
  right: rectSchema
});

const uriSchema = z.object({ ok: z.boolean(), uri: z.string() });

/** codec 必须声明在 MANIFEST 之前（MANIFEST 在模块求值期就会调用它，否则踩 TDZ）。 */
const codec = (typeSymbol, schema) => ({ mode: "strict", typeSymbol, create: () => schema });

const P = "dsh-split-obsidian";
const MANIFEST = {
  package: P,
  face: "host",
  schemas: [],
  invocations: [
    { id: P + "#obsidianSplit/status", service: "obsidianSplit", namespace: "obsidianSplit", method: "status", invocation: { kind: "direct" }, parameters: [], result: codec(P + "#SplitStatus", statusSchema) },
    { id: P + "#obsidianSplit/snap", service: "obsidianSplit", namespace: "obsidianSplit", method: "snap", invocation: { kind: "direct" }, parameters: [codec(P + "#Ratio", z.number())], result: codec(P + "#SplitAction", actionSchema) },
    { id: P + "#obsidianSplit/drag", service: "obsidianSplit", namespace: "obsidianSplit", method: "drag", invocation: { kind: "direct" }, parameters: [codec(P + "#Ratio", z.number())], result: codec(P + "#SplitAction", actionSchema) },
    { id: P + "#obsidianSplit/unsnap", service: "obsidianSplit", namespace: "obsidianSplit", method: "unsnap", invocation: { kind: "direct" }, parameters: [], result: codec(P + "#SplitAction", actionSchema) },
    { id: P + "#obsidianSplit/focus", service: "obsidianSplit", namespace: "obsidianSplit", method: "focus", invocation: { kind: "direct" }, parameters: [codec(P + "#Side", z.string())], result: codec(P + "#SplitAction", actionSchema) },
    { id: P + "#obsidianSplit/openVault", service: "obsidianSplit", namespace: "obsidianSplit", method: "openVault", invocation: { kind: "direct" }, parameters: [codec(P + "#VaultName", z.string())], result: codec(P + "#OpenUri", uriSchema) }
  ],
  model: { services: [], events: [], objects: [] }
};

class ObsidianSplitGateway extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, "obsidianSplit");
    this.hostCtx = ctx;
    // 插件卸载时把常驻 PowerShell 收干净，别留孤立进程
    ctx.effect(() => () => { try { stopService(); } catch { /* 已经没了 */ } }, "dsh-split-obsidian: stop window service");
  }

  /** 内部：准备好服务，并确保两个句柄都在。 */
  async ready() {
    const srv = await ensureServer();
    if (!srv.ok) throw new Error(srv.error);
    if (srv.obHandle > 0 && srv.dshHandle > 0) return srv;
    // Obsidian 可能是刚启动的，句柄变了 —— 重抓一次
    const again = await refreshHandles();
    if (again === null || again.dshHandle <= 0) throw new Error("没有检测到 DSH 窗口");
    srv.dshHandle = again.dshHandle;
    srv.obHandle = again.obHandle;
    if (again.obHandle <= 0) throw new Error("没有检测到 Obsidian 窗口 —— 请先启动 Obsidian，再点「重新检测」");
    return srv;
  }

  /** 现在能不能用。任何异常都转成人话，别让界面看到堆栈。 */
  async status() {
    const blank = { available: false, reason: "", dshHandle: 0, obHandle: 0, workArea: { x: 0, y: 0, width: 0, height: 0 }, ratio: lastRatio, gap: DEFAULT_GAP, presets: PRESETS, snapped: false };
    try {
      const srv = await ensureServer();
      if (!srv.ok) return { ...blank, reason: srv.error };
      let query = await queryWindows();
      if (srv.obHandle <= 0) {
        const again = await refreshHandles();
        if (again !== null && again.obHandle > 0) {
          srv.obHandle = again.obHandle;
          query = await queryWindows();
        }
      }
      const snapped = query !== null && query.left !== null && query.left.zoomed !== true && query.right !== null;
      return {
        available: true,
        reason: srv.obHandle > 0 ? "" : "没有检测到 Obsidian 窗口 —— 请先启动 Obsidian（启动后点「重新检测」）",
        dshHandle: srv.dshHandle,
        obHandle: srv.obHandle,
        workArea: srv.workArea,
        ratio: lastRatio,
        gap: DEFAULT_GAP,
        presets: PRESETS,
        snapped: snapped
      };
    } catch (error) {
      return { ...blank, reason: String(error && error.message ? error.message : error) };
    }
  }

  /** 内部：按比例摆两个窗口。 */
  async arrange(ratio) {
    const srv = await this.ready();
    const r = clampRatio(ratio);
    lastRatio = r;
    const pair = computeSideBySide(srv.workArea, r, DEFAULT_GAP);
    await placeBoth(pair.left, pair.right);
    return { ok: true, ratio: r, label: describeRatio(r), left: pair.left, right: pair.right };
  }

  /** 按比例并排。 */
  async snap(ratio) {
    return await this.arrange(ratio);
  }

  /**
   * 拖动中的高频调用。
   *
   * 和 snap 的区别：不重抓句柄、不做额外检查，只发一条 both 命令。
   * 实测单次约 5ms，所以可以跟着鼠标每一帧调。
   */
  async drag(ratio) {
    const srv = await this.ready();
    const r = clampRatio(ratio);
    lastRatio = r;
    const pair = computeSideBySide(srv.workArea, r, DEFAULT_GAP);
    await placeBoth(pair.left, pair.right);
    return { ok: true, ratio: r, label: describeRatio(r), left: pair.left, right: pair.right };
  }

  /** 还原：DSH 占满工作区。 */
  async unsnap() {
    const srv = await this.ready();
    const full = computeFull(srv.workArea);
    await placeLeft(full);
    return { ok: true, ratio: lastRatio, label: describeRatio(lastRatio), left: full, right: full };
  }

  /** 把焦点给某一侧。 */
  async focus(side) {
    const srv = await this.ready();
    await focusSide(side === "right" ? "right" : "left");
    const pair = computeSideBySide(srv.workArea, lastRatio, DEFAULT_GAP);
    return { ok: true, ratio: lastRatio, label: describeRatio(lastRatio), left: pair.left, right: pair.right };
  }

  /** 用 obsidian:// 让 Obsidian 定位到某个库。 */
  async openVault(vaultName) {
    const raw = typeof vaultName === "string" ? vaultName.trim() : "";
    if (raw.length === 0) throw new Error("库名为空");
    const uri = "obsidian://open?vault=" + encodeURIComponent(raw);
    const ok = await openObsidianUri(uri);
    if (!ok) throw new Error("无法打开 obsidian:// 链接 —— 请确认已安装 Obsidian");
    return { ok: true, uri: uri };
  }
}

export function apply(ctx) {
  const gateway = new ObsidianSplitGateway(ctx);
  ctx.effect(() => ctx.typert.register(MANIFEST), "dsh-split-obsidian: typert manifest");
  return gateway;
}
