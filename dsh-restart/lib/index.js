/**
 * dsh-restart —— host 半。
 *
 * 一个 Typert Remote 服务（"appRestart"），暴露：
 *   - restartSupport()  现在能不能重启（不是桌面版就明说，而不是点了没反应）
 *   - restart()         一键重启
 *
 * ## 为什么重启要这么绕
 *
 * 实测出来的桌面版进程结构（`DeepSeek Harness.exe` 一个镜像，三种角色）：
 *
 *   PID 27400  DeepSeek Harness.exe                       ← Electron 主进程（GUI 窗口）
 *    ├─ 25048  --type=renderer                            ← 界面
 *    ├─ 26656  --type=gpu-process
 *    └─ 15044  --expose-internals ...dsh-desktop-host...  ← DSH host，本插件跑在这里
 *
 * 所以：
 *   1. **拿不到 `app.relaunch()`** —— 我们不在 Electron 主进程里。host 是被主进程用
 *      `ELECTRON_RUN_AS_NODE` 拉起来的子进程（探针实测：`process.type === null`、
 *      `import("electron")` 只给到路径字符串、没有 `app` 对象）。
 *   2. **没有给第三方用的重启 IPC** —— host→主进程的合法消息只有 ready / platform-session /
 *      shutdown-complete / fatal（主进程用 isDesktopHostEvent 白名单校验，发别的会被当成
 *      invalid 直接 SIGTERM）。界面→主进程的 DESKTOP_IPC 里也只有快捷键 / 引导 / 目录选择 /
 *      更新这些，**没有重启通道**。
 *   3. **"优雅退出"这条路也堵死** —— 主进程监听 host 的 close，无论退出码是不是 0 都走
 *      `fail("dsh desktop host stopped")`，也就是弹崩溃恢复框。想让 host 自己退出换来一次
 *      重启是做不到的。
 *
 * 结论：只能另起一个**脱离进程组**的帮手，由它来杀进程 + 重新拉起可执行文件。
 * 帮手用 `detached: true` 启动，所以它不会被我们自己被杀时带走。
 *
 * ## 代价（必须承认）
 *
 * 这是硬杀，不是优雅退出：没落盘的东西会丢。DSH 的会话是 JSONL 持续写的，风险不大但不是零。
 * 另外它**只针对当前这个实例**的 PID，不会误伤你另外开的 DSH。
 */
import { z } from "zod";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export const name = "app-restart";
export const inject = ["typert"];

/**
 * 三个阶段各等多久。**用 ping 次数表示**（`ping -n N` 约等于 N-1 秒）。
 * 不用 `timeout`：脱离控制台的进程里它需要一个控制台输入句柄，会直接失败。
 */
/** 动手前的缓冲：留给界面把"正在重启"画出来、以及 RPC 应答回去。 */
const SETTLE_PINGS = 3;
/** 杀完之后等端口和单实例锁释放。 */
const RELEASE_PINGS = 7;
/** 拉起之后等一会儿，再把进程列表写进日志自检。 */
const VERIFY_PINGS = 8;

function resolveDshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === "string" && env.trim().length > 0) return env.trim();
  return join(homedir(), ".dsh");
}

/** 帮手与日志的落点。 */
function helperDir() {
  return join(resolveDshHome(), "cache", "dsh-restart");
}

/** 当前主机端口（用于日志，不参与决策）。 */
function currentPort() {
  try {
    const url = new URL(process.env.DSH_WEB_URL ?? "");
    return url.port;
  } catch {
    return "";
  }
}

/**
 * 判断现在能不能重启。
 *
 * 用 `dsh-desktop-host` 是否出现在 argv 里来认「我们是桌面版 host」—— 这是最硬的标记：
 * 从源码跑（`pnpm dsh web`）时 argv 里是 apps/cli 的 bin，进程里也没有 Electron。
 */
export function detect() {
  const argv = Array.isArray(process.argv) ? process.argv.join(" ") : "";
  const electron = typeof process.versions.electron === "string" ? process.versions.electron : "";
  const exe = process.execPath ?? "";
  const isDesktopHost = argv.includes("dsh-desktop-host");

  if (!isDesktopHost) {
    return {
      supported: false,
      reason: "当前不是 DSH 桌面版（没有检测到 dsh-desktop-host），无法重启进程。从源码跑 dsh web 时请自己重启。",
      exe,
      mode: "source",
      parentPid: 0,
      selfPid: process.pid,
    };
  }
  if (electron.length === 0) {
    return {
      supported: false,
      reason: "桌面版 host 里没有 Electron 运行时信息，重启机制可能已变，已保守拒绝。",
      exe,
      mode: "unknown",
      parentPid: 0,
      selfPid: process.pid,
    };
  }
  if (typeof process.ppid !== "number" || process.ppid <= 0) {
    return {
      supported: false,
      reason: "拿不到父进程 PID（Electron 主进程），无法安全地重启。",
      exe,
      mode: "desktop",
      parentPid: 0,
      selfPid: process.pid,
    };
  }
  return {
    supported: true,
    reason: "",
    exe,
    mode: "desktop",
    parentPid: process.ppid,
    selfPid: process.pid,
  };
}

/**
 * 生成帮手脚本。
 *
 * 刻意保持简单，但有几处是踩过坑才定下来的：
 *
 *   - **用 `ping -n` 而不是 `timeout` 等待**。`timeout` 需要一个控制台输入句柄；
 *     帮手是用 detached 起的（没有控制台），`timeout` 会直接报
 *     "ERROR: Input redirection is not supported" 然后立刻返回 —— 也就是"等 3 秒"
 *     其实一秒都没等。新实例于是在旧的单实例锁/端口还没释放时就启动，自己退出了，
 *     表现出来就是"只关不开"。`ping` 不需要控制台。
 *   - **杀完主进程和 host 之后，还要清理残留的 `DeepSeek Harness.exe`**。主进程被
 *     硬杀时 renderer / GPU / utility 会变成孤儿，仍可能占着单实例锁或端口。
 *   - **仍然只按 PID 杀，绝不 `taskkill /IM`、绝不用 `/T`**。`/T` 会顺着进程树把
 *     帮手自己也带走（它就是我们派出去的），那就没人负责重新拉起了。
 *   - **启动后自检**：把之后的进程列表写进日志。这个脚本没法在开发环境里跑完整一遍
 *     （跑一遍就把自己重启了），所以"事后能看出到底哪一步没成"比什么都重要。
 *
 * 顺序也不能变：先杀父进程（Electron 主进程 → 窗口关掉），再杀自己（host → 端口释放）。
 */
export function buildHelperScript(info, port) {
  const lines = [
    "@echo off",
    "setlocal",
    'set "LOG=%~dp0restart.log"',
    `set "EXE=${info.exe}"`,
    `set "PARENT=${info.parentPid}"`,
    `set "SELF=${info.selfPid}"`,
    `echo [%date% %time%] begin (self=${info.selfPid} parent=${info.parentPid} port=${port}) > "%LOG%"`,

    // ping 当 sleep 用：脱离控制台也能跑
    `ping -n ${SETTLE_PINGS} 127.0.0.1 >nul`,
    'echo [%date% %time%] killing parent >> "%LOG%"',
    'taskkill /PID %PARENT% /F >> "%LOG%" 2>&1',
    'echo [%date% %time%] killing self >> "%LOG%"',
    'taskkill /PID %SELF% /F >> "%LOG%" 2>&1',

    // 孤儿进程清理：按 PID 杀（不是 /IM），并记下来杀了谁
    'echo [%date% %time%] leftovers: >> "%LOG%"',
    'tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /FO CSV /NH >> "%LOG%" 2>&1',
    'for /f "tokens=2 delims=," %%p in (\'tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /FO CSV /NH 2^>nul\') do taskkill /PID %%~p /F >> "%LOG%" 2>&1',

    // 给端口和单实例锁留足释放时间
    `ping -n ${RELEASE_PINGS} 127.0.0.1 >nul`,
    'echo [%date% %time%] starting "%EXE%" >> "%LOG%"',
    'start "" "%EXE%"',

    // 自检：起完之后还有没有 DSH 在跑
    `ping -n ${VERIFY_PINGS} 127.0.0.1 >nul`,
    'echo [%date% %time%] after start: >> "%LOG%"',
    'tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /FO CSV /NH >> "%LOG%" 2>&1',
    "endlocal",
  ];
  // cmd 需要 CRLF
  return lines.join("\r\n") + "\r\n";
}

// ── wire schemas ──────────────────────────────────────────────────────────

/** 重启能力：不支持时 reason 是一句人话，界面据此禁用按钮。 */
const restartSupportSchema = z.object({
  supported: z.boolean(),
  reason: z.string(),
  exe: z.string(),
  mode: z.string(),
  parentPid: z.number(),
  selfPid: z.number(),
});

const restartResultSchema = z.object({
  started: z.boolean(),
  exe: z.string(),
  helper: z.string(),
  parentPid: z.number(),
  selfPid: z.number(),
});

/**
 * 远程 schema codec 工厂。
 * 必须声明在 MANIFEST 之前 —— MANIFEST 在模块求值期就会调用 codec()，
 * 声明晚了会踩 TDZ（`Cannot access 'codec' before initialization`），整个 Web 端起不来。
 * 形状也必须是 `{ mode, typeSymbol, create: () => schema }`，缺 create() 注册即失败。
 */
const codec = (typeSymbol, schema) => ({ mode: "strict", typeSymbol, create: () => schema });

/** 注册到 API 网关的远程描述符。 */
const MANIFEST = {
  package: "dsh-restart",
  face: "host",
  schemas: [],
  invocations: [
    {
      id: "dsh-restart#appRestart/restartSupport",
      service: "appRestart",
      namespace: "appRestart",
      method: "restartSupport",
      invocation: { kind: "direct" },
      parameters: [],
      result: codec("dsh-restart#RestartSupport", restartSupportSchema),
    },
    {
      // 避开了 RemoteNamespaceService 原型上的禁用名（install/remove/methods/name/...）
      id: "dsh-restart#appRestart/restart",
      service: "appRestart",
      namespace: "appRestart",
      method: "restart",
      invocation: { kind: "direct" },
      parameters: [],
      result: codec("dsh-restart#RestartResult", restartResultSchema),
    },
  ],
  model: { services: [], events: [], objects: [] },
};

/**
 * 跳板脚本。
 *
 * 为什么不能直接 `spawn("cmd.exe", ..., { detached: true })`：
 *
 *   detached 在 Windows 上等于 `DETACHED_PROCESS`，也就是**没有控制台**。实测（用记事本当靶子）：
 *
 *     detached: true  → helper 活得过父进程被杀 ✅，但 `ping` / `tasklist` / `taskkill`
 *                       这些外部命令**每调一个就蹦一个黑窗口**，而且它们的输出**抓不到**
 *                       （日志里 tasklist 是空的）——于是那句 `for /f ... tasklist` 的
 *                       残留清理循环拿到空输入，等于没执行。
 *     detached: false → 外部命令一切正常，但 helper **会被父进程一起带走**
 *                       （父进程被杀后，helper 第二步就再也没写日志）。
 *
 * 两头都不行，所以走中间：**用 wscript 当跳板**。wscript.exe 是 GUI 子系统进程，
 * 本身没有控制台；它用 `WshShell.Run(..., 0, False)`（0 = SW_HIDE）让 cmd 拿到一个
 * **隐藏的控制台**。这样：
 *   - cmd 有控制台 → 外部命令行为正常、输出能重定向、不会另开窗口
 *   - 窗口是隐藏的 → 用户看不到一片黑框
 *   - wscript 由我们 detached 起 → 活得过我们被杀
 *
 * 实测这三条同时成立。
 */
export function buildLauncherScript(helperPath) {
  return [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run "cmd.exe /d /c ""${helperPath}""", 0, False`,
  ].join("\r\n") + "\r\n";
}

// ── 远程服务 ──────────────────────────────────────────────────────────────

class AppRestartGateway extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, "appRestart");
    this.hostCtx = ctx;
  }

  /** 现在能不能重启。 */
  restartSupport() {
    return detect();
  }

  /**
   * 一键重启：写帮手脚本 + 跳板脚本 → 脱离启动跳板 → 立刻返回。
   * 几秒后本进程会被那个帮手杀掉，所以这里返回的东西客户端**不一定收得到**；
   * 界面应该先显示"正在重启"，而不是等这个 promise。
   */
  async restart() {
    const info = detect();
    if (!info.supported) throw new Error(info.reason);

    const dir = helperDir();
    await mkdir(dir, { recursive: true });
    const helper = join(dir, "restart.cmd");
    const launcher = join(dir, "restart-launch.vbs");
    // 两个文件都保持纯 ASCII：cmd.exe 与 wscript 都按系统 ANSI 代码页读脚本，
    // 写成 UTF-8 的话非 ASCII 字符（比如中文路径）会变乱码。
    await writeFile(helper, buildHelperScript(info, currentPort()), "ascii");
    await writeFile(launcher, buildLauncherScript(helper), "ascii");

    const child = spawn("wscript.exe", ["//B", launcher], {
      cwd: dir,
      detached: true, // 关键：脱离我们，这样我们被杀时它活着
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();

    return {
      started: true,
      exe: info.exe,
      helper,
      parentPid: info.parentPid,
      selfPid: info.selfPid,
    };
  }
}

export function apply(ctx) {
  const gateway = new AppRestartGateway(ctx);
  ctx.effect(() => ctx.typert.register(MANIFEST), "dsh-restart: typert manifest");
  return gateway;
}
