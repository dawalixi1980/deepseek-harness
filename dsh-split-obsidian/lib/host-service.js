/**
 * dsh-split-obsidian —— 常驻窗口服务的 Node 侧客户端。
 *
 * 管理一个 long-lived 的 PowerShell 进程（lib/snap-server.ps1），通过 stdin/stdout
 * 的按行协议与它对话。
 *
 * ## 为什么要常驻
 *
 * 一次性起 PowerShell 进程 = 启动 + Add-Type 编译 C#，实测 ~390ms。拖动分隔条时
 * 每次都要这个开销会明显卡顿。常驻之后单次移动降到 ~3ms（实测 20 次连续移动共
 * 64ms），拖动完全跟手。
 *
 * ## 生命周期
 *
 * 服务在第一次用到时惰性启动，之后复用。DSH 退出时（host 的 dispose / 进程结束）
 * 会调 stop() 把它收干净 —— 否则会在任务管理器里留下一个孤立的 powershell.exe。
 * 另外还挂了进程退出钩子做兜底。
 *
 * ## 失败处理
 *
 * 服务可能因为各种原因起不来（PowerShell 被策略禁用、脚本被杀软拦、Windows 版本差异）。
 * 这时 isAvailable() 会如实返回 false 与原因，界面据此禁用按钮并显示原因，
 * 而不是给一个点了没反应的按钮。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = join(HERE, "snap-server.ps1");

/** 一条命令的默认超时。init 要编译 C#，给宽一点。 */
const INIT_TIMEOUT_MS = 20000;
const CALL_TIMEOUT_MS = 5000;

let server = null;

function ensureHooks() {
  if (ensureHooks.done === true) return;
  ensureHooks.done = true;
  const cleanup = () => { try { server?.kill(); } catch { /* 已经没了 */ } };
  process.once("exit", cleanup);
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
}

/**
 * 起服务并等它报 READY。
 * 返回 { ok, dshHandle, obHandle, workArea, error }
 */
async function startServer() {
  if (!existsSync(SERVER_SCRIPT)) {
    return { ok: false, error: "缺少服务脚本：" + SERVER_SCRIPT };
  }
  ensureHooks();

  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SERVER_SCRIPT],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
  );

  const state = { child: child, buffer: "", queue: [], stderr: "", dead: false };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    state.buffer += chunk;
    let idx = state.buffer.indexOf("\n");
    while (idx !== -1) {
      const line = state.buffer.slice(0, idx).replace(/\r$/, "");
      state.buffer = state.buffer.slice(idx + 1);
      if (line.length > 0) {
        const waiter = state.queue.shift();
        if (waiter !== undefined) { clearTimeout(waiter.timer); waiter.resolve(line); }
      }
      idx = state.buffer.indexOf("\n");
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { state.stderr += chunk; });

  child.on("exit", () => {
    state.dead = true;
    // 进程没了：把所有等待者叫醒，别让调用方永远挂着
    const pending = state.queue.splice(0, state.queue.length);
    for (const waiter of pending) {
      clearTimeout(waiter.timer);
      waiter.resolve("ERR service-exited");
    }
  });

  server = state;

  /*
   * 等第一条 READY。
   *
   * 注意**不要**给服务发 "init" —— READY 是它启动时主动推的第一行，脚本里并没有
   * init 这个命令。之前多发这一条会让服务回一个 ERR，于是回复队列整体串位，
   * 之后每次 call 都拿到上一条的答案（表现为 both/left/right 全部 unknown-command）。
   */
  const ready = await waitForLine(INIT_TIMEOUT_MS);
  if (!ready.ok || !ready.line.startsWith("READY")) {
    stop();
    return { ok: false, error: "窗口服务启动失败：" + (ready.line || state.stderr.slice(0, 300) || "无输出") };
  }

  const parts = ready.line.split(/\s+/);
  const dshHandle = Number(parts[1]);
  const obHandle = Number(parts[2]);
  const workArea = { x: Number(parts[3]), y: Number(parts[4]), width: Number(parts[5]), height: Number(parts[6]) };

  return { ok: true, dshHandle: dshHandle, obHandle: obHandle, workArea: workArea, error: "" };
}

/**
 * 只等下一行输出，不往 stdin 写任何东西。
 * 用于等服务启动时主动推的 READY。
 */
function waitForLine(timeoutMs) {
  const state = server;
  if (state === null || state.dead) return Promise.resolve({ ok: false, line: "ERR no-service" });
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, line: "ERR timeout" }), timeoutMs || CALL_TIMEOUT_MS);
    state.queue.push({ resolve: (line) => resolve({ ok: true, line: line }), timer: timer });
  });
}

/** 发一条命令，等一行回复。 */
function call(command, timeoutMs) {
  const state = server;
  if (state === null || state.dead) {
    return Promise.resolve({ ok: false, line: "ERR no-service" });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ ok: false, line: "ERR timeout" });
    }, timeoutMs || CALL_TIMEOUT_MS);
    state.queue.push({ resolve: (line) => resolve({ ok: true, line: line }), timer: timer });
    try { state.child.stdin.write(command + "\n"); }
    catch { clearTimeout(timer); resolve({ ok: false, line: "ERR write-failed" }); }
  });
}

/** 确保服务在跑；已经在跑就直接复用。 */
export async function ensureServer() {
  if (server !== null && server.dead !== true) return { ok: true, error: "" };
  return await startServer();
}

/** 服务是否可用（不含启动）。 */
export function isRunning() {
  return server !== null && server.dead !== true;
}

/** 停掉服务。幂等。 */
export function stop() {
  const state = server;
  server = null;
  if (state === null) return;
  try { state.child.stdin.write("quit\n"); } catch { /* 已经关了 */ }
  try { state.child.kill(); } catch { /* 同上 */ }
}

/** 只动 DSH 窗口。 */
export async function placeLeft(rect) {
  const r = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  const res = await call("left," + r.x + "," + r.y + "," + r.width + "," + r.height);
  if (!res.ok || res.line !== "OK") throw new Error("摆放 DSH 窗口失败：" + res.line);
  return true;
}

/** 只动 Obsidian 窗口。 */
export async function placeRight(rect) {
  const r = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  const res = await call("right," + r.x + "," + r.y + "," + r.width + "," + r.height);
  if (!res.ok || res.line !== "OK") throw new Error("摆放 Obsidian 窗口失败：" + res.line);
  return true;
}

/** 一次摆两个窗口（推荐：拖动时用这个，只走一趟协议）。 */
export async function placeBoth(left, right) {
  const l = { x: Math.round(left.x), y: Math.round(left.y), width: Math.round(left.width), height: Math.round(left.height) };
  const r = { x: Math.round(right.x), y: Math.round(right.y), width: Math.round(right.width), height: Math.round(right.height) };
  const cmd = "both," + l.x + "," + l.y + "," + l.width + "," + l.height +
    "," + r.x + "," + r.y + "," + r.width + "," + r.height;
  const res = await call(cmd);
  if (!res.ok || res.line !== "OK") throw new Error("并排摆放失败：" + res.line);
  return true;
}

/** 把焦点给某一侧。 */
export async function focusSide(side) {
  const res = await call("focus," + (side === "right" ? "right" : "left"));
  return res.ok && res.line === "OK";
}

/** 重新抓句柄（Obsidian 重启后句柄会变）。 */
export async function refreshHandles() {
  const res = await call("handles");
  if (!res.ok || !res.line.startsWith("OK")) return null;
  const parts = res.line.split(/\s+/);
  return { dshHandle: Number(parts[1]), obHandle: Number(parts[2]) };
}

/** 查当前两侧窗口状态。 */
export async function queryWindows() {
  const res = await call("query");
  if (!res.ok || !res.line.startsWith("L")) return null;
  const parse = (text) => {
    const m = /^(-?\d+),(-?\d+),(\d+),(\d+)\|(.)(.)$/.exec(text);
    if (m === null) return null;
    return { x: Number(m[1]), y: Number(m[2]), width: Number(m[3]), height: Number(m[4]), zoomed: m[5] === "z", iconic: m[6] === "i" };
  };
  const halves = res.line.split(";");
  return { left: parse(halves[0].slice(1)), right: halves[1] ? parse(halves[1].slice(1)) : null };
}
