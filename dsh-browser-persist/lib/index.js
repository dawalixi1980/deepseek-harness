/**
 * dsh-browser-persist —— host 半。
 *
 * 一个 Typert Remote 服务（"browserPersist"），暴露四个方法：
 *   status()  现在是什么状态（applied / clean / unknown，以及原因）
 *   apply()   打补丁：让侧栏浏览器记住登录态
 *   revert()  撤销补丁，回到官方行为
 *   restart() 重启 DSH，让改动生效
 *
 * ## 为什么要做这个插件
 *
 * DSH 官方把侧栏浏览器（书签点开的那个标签页）的分区建成
 *
 *     partition = \`dsh-sidebar-browser-\${randomUUID()}\`;
 *
 * 没有 persist: 前缀 + 随机 UUID 名字，两个问题叠在一起，结果是**每次重启 DSH
 * 都要重新登录**。官方自己的平台分区（同文件另一处）用的是
 * \`persist:dsh-platform-\${createHash("sha256").update(...)}\`，所以这不是能力问题，
 * 而是侧栏浏览器没这么做。
 *
 * 本插件就是把这个差异补上，并且做成**可重复执行**的：DSH 升级会整体替换
 * app.asar，补丁随之消失，重新点一下"应用"即可，不用手工找代码改。
 *
 * 详细的改写策略与安全边界见 lib/patch.js 与 lib/asar.js 的头部注释。
 */
import { z } from "zod";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { applyPatch, patchStatus, revertPatch } from "./patch.js";

export const name = "browser-persist";
export const inject = ["typert"];

/** 与 dsh-restart 保持一致的等待节奏（用 ping 当 sleep）。 */
const SETTLE_PINGS = 3;
const RELEASE_PINGS = 7;

function resolveDshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === "string" && env.trim().length > 0) return env.trim();
  return join(homedir(), ".dsh");
}

function helperDir() {
  return join(resolveDshHome(), "cache", "dsh-browser-persist");
}

function currentPort() {
  try {
    const url = new URL(process.env.DSH_WEB_URL ?? "");
    return url.port;
  } catch {
    return "";
  }
}

/** 现在能不能重启（复用 dsh-restart 判定过的那套标记）。 */
export function detectRestart() {
  const argv = Array.isArray(process.argv) ? process.argv.join(" ") : "";
  const electron = typeof process.versions.electron === "string" ? process.versions.electron : "";
  const exe = process.execPath ?? "";
  const isDesktopHost = argv.includes("dsh-desktop-host");
  if (!isDesktopHost || electron.length === 0 || typeof process.ppid !== "number" || process.ppid <= 0) {
    return { supported: false, exe, parentPid: 0, selfPid: process.pid };
  }
  return { supported: true, exe, parentPid: process.ppid, selfPid: process.pid };
}

/**
 * 重启帮手脚本。
 * 沿用 dsh-restart 实测出的三条硬约束：用 ping 当 sleep（timeout 需要控制台）、
 * 只按 PID 杀（绝不用 /T，那会把自己也带走）、杀完清孤儿进程。
 */
export function buildHelperScript(info, port) {
  return [
    "@echo off",
    "setlocal",
    'set "LOG=%~dp0restart.log"',
    `set "EXE=${info.exe}"`,
    `set "PARENT=${info.parentPid}"`,
    `set "SELF=${info.selfPid}"`,
    `echo [%date% %time%] begin (self=${info.selfPid} parent=${info.parentPid} port=${port}) > "%LOG%"`,
    `ping -n ${SETTLE_PINGS} 127.0.0.1 >nul`,
    'echo [%date% %time%] killing parent >> "%LOG%"',
    'taskkill /PID %PARENT% /F >> "%LOG%" 2>&1',
    'echo [%date% %time%] killing self >> "%LOG%"',
    'taskkill /PID %SELF% /F >> "%LOG%" 2>&1',
    'echo [%date% %time%] leftovers: >> "%LOG%"',
    'tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /FO CSV /NH >> "%LOG%" 2>&1',
    'for /f "tokens=2 delims=," %%p in (\'tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /FO CSV /NH 2^>nul\') do taskkill /PID %%~p /F >> "%LOG%" 2>&1',
    `ping -n ${RELEASE_PINGS} 127.0.0.1 >nul`,
    'echo [%date% %time%] starting "%EXE%" >> "%LOG%"',
    'start "" "%EXE%"',
    "endlocal",
  ].join("\r\n") + "\r\n";
}

/** 跳板：wscript（无控制台）拉起 cmd（有隐藏控制台），见 dsh-restart 的注释。 */
export function buildLauncherScript(helperPath) {
  return [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run "cmd.exe /d /c ""${helperPath}""", 0, False`,
  ].join("\r\n") + "\r\n";
}

// ── wire schemas ──────────────────────────────────────────────────────────
const statusSchema = z.object({
  supported: z.boolean(),
  reason: z.string(),
  state: z.string(),
  layout: z.string(),
  kind: z.string(),
  main: z.string(),
  version: z.string(),
  backup: z.string(),
  restartSupported: z.boolean(),
});

const actionSchema = z.object({
  changed: z.boolean(),
  message: z.string(),
  backup: z.string(),
  growth: z.number(),
  state: z.string(),
});

const restartSchema = z.object({
  started: z.boolean(),
  exe: z.string(),
  helper: z.string(),
});

/** codec 必须声明在 MANIFEST 之前（MANIFEST 在模块求值期就会调用它，否则踩 TDZ）。 */
const codec = (typeSymbol, schema) => ({ mode: "strict", typeSymbol, create: () => schema });

const MANIFEST = {
  package: "dsh-browser-persist",
  face: "host",
  schemas: [],
  invocations: [
    { id: "dsh-browser-persist#browserPersist/status", service: "browserPersist", namespace: "browserPersist", method: "status", invocation: { kind: "direct" }, parameters: [], result: codec("dsh-browser-persist#Status", statusSchema) },
    { id: "dsh-browser-persist#browserPersist/apply", service: "browserPersist", namespace: "browserPersist", method: "apply", invocation: { kind: "direct" }, parameters: [], result: codec("dsh-browser-persist#Action", actionSchema) },
    { id: "dsh-browser-persist#browserPersist/revert", service: "browserPersist", namespace: "browserPersist", method: "revert", invocation: { kind: "direct" }, parameters: [], result: codec("dsh-browser-persist#Action", actionSchema) },
    { id: "dsh-browser-persist#browserPersist/restart", service: "browserPersist", namespace: "browserPersist", method: "restart", invocation: { kind: "direct" }, parameters: [], result: codec("dsh-browser-persist#Restart", restartSchema) },
  ],
  model: { services: [], events: [], objects: [] },
};

class BrowserPersistGateway extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, "browserPersist");
    this.hostCtx = ctx;
  }

  /** 当前状态。任何异常都转成"不支持 + 人话原因"，不让界面看到堆栈。 */
  status() {
    let info;
    try {
      info = patchStatus({});
    } catch (error) {
      info = { supported: false, reason: String(error?.message ?? error), state: "unknown", layout: "", kind: "", main: "", version: "", backup: "" };
    }
    return {
      supported: info.supported,
      reason: info.reason,
      state: info.state,
      layout: info.layout,
      kind: info.kind,
      main: info.main,
      version: info.version,
      backup: info.backup,
      restartSupported: detectRestart().supported,
    };
  }

  /** 打补丁。 */
  apply() {
    try {
      const result = applyPatch({});
      const after = patchStatus({});
      return {
        changed: result.changed === true,
        message: result.message ?? "",
        backup: result.backup ?? "",
        growth: typeof result.growth === "number" ? result.growth : 0,
        state: after.state,
      };
    } catch (error) {
      throw new Error(String(error?.message ?? error));
    }
  }

  /** 撤销补丁。 */
  revert() {
    try {
      const result = revertPatch({});
      const after = patchStatus({});
      return {
        changed: result.changed === true,
        message: result.message ?? "",
        backup: result.backup ?? "",
        growth: typeof result.growth === "number" ? result.growth : 0,
        state: after.state,
      };
    } catch (error) {
      throw new Error(String(error?.message ?? error));
    }
  }

  /** 重启，让改动生效。几秒后本进程会被帮手杀掉，客户端多半收不到应答。 */
  async restart() {
    const info = detectRestart();
    if (!info.supported) throw new Error("当前不是 DSH 桌面版，无法自动重启，请手动关闭并重新打开 DSH");
    const dir = helperDir();
    await mkdir(dir, { recursive: true });
    const helper = join(dir, "restart.cmd");
    const launcher = join(dir, "restart-launch.vbs");
    // cmd.exe 与 wscript 按系统 ANSI 代码页读脚本，必须写 ASCII，否则中文路径会变乱码
    await writeFile(helper, buildHelperScript(info, currentPort()), "ascii");
    await writeFile(launcher, buildLauncherScript(helper), "ascii");
    const child = spawn("wscript.exe", ["//B", launcher], {
      cwd: dir,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return { started: true, exe: info.exe, helper };
  }
}

export function apply(ctx) {
  const gateway = new BrowserPersistGateway(ctx);
  ctx.effect(() => ctx.typert.register(MANIFEST), "dsh-browser-persist: typert manifest");
  return gateway;
}
