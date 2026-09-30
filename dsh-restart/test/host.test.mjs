/**
 * host 半的纯函数回归测试：detect() + buildHelperScript()。
 *
 * 为什么单独测：**这个插件的核心动作没法在测试里跑一遍** —— 跑一遍就等于把自己重启了。
 * 所以能离线钉死的东西必须钉死：
 *   - 在不该重启的环境里（比如从源码跑）必须老实说"不支持"，而不是点了没反应
 *   - 生成的帮手脚本**只按 PID 杀当前实例**，绝不能按镜像名杀（那会误伤你另外开的 DSH）
 *   - 杀父进程要在杀自己之前，拉起新实例要在两者之后
 *
 * lib/index.js 顶层 import 了 zod / @deepseek-ai/dsh-typert-protocol（纯 Node 下不存在），
 * 所以这里照 dsh-plugin-url 的做法：复制真实源码，配一份最小桩。
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
const tmpRoot = await mkdtemp(join(tmpdir(), "dsh-restart-host-"));

async function writeModule(relativeDir, source) {
  const dir = join(tmpRoot, "node_modules", relativeDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: relativeDir, version: "0.0.0", type: "module", main: "index.js" }), "utf8");
  await writeFile(join(dir, "index.js"), source, "utf8");
}

try {
  await copyFile(join(pluginRoot, "lib", "index.js"), join(tmpRoot, "index.js"));

  // zod 最小桩：只需要顶层这几个工厂（本插件的 schema 没有用到 .optional()/链式）
  await writeModule("zod", [
    "const leaf = (kind) => ({ kind });",
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
  check("lib/index.js 可加载（真实源码 + 最小桩）", typeof mod.detect === "function" && typeof mod.buildHelperScript === "function");
  check("导出 inject 含 typert", Array.isArray(mod.inject) && mod.inject.includes("typert"), JSON.stringify(mod.inject));

  console.log("\n[1] detect()：在测试进程里（纯 Node，不是桌面版 host）必须老实说不行");
  const info = mod.detect();
  check("supported = false", info.supported === false, JSON.stringify(info));
  check("mode 标成 source", info.mode === "source", info.mode);
  check("给出一句人话的原因", typeof info.reason === "string" && info.reason.length > 0, info.reason);
  check("原因里点明不是桌面版", /桌面版|dsh-desktop-host/.test(info.reason), info.reason);
  check("exe 用 process.execPath", info.exe === process.execPath);
  check("selfPid 是自己", info.selfPid === process.pid);
  check("不支持时 parentPid 归零（不能给出可疑的杀进程目标）", info.parentPid === 0, String(info.parentPid));

  console.log("\n[2] buildHelperScript()：内容与顺序");
  const fake = { supported: true, reason: "", exe: "E:\\dsh\\DeepSeek Harness.exe", mode: "desktop", parentPid: 27400, selfPid: 15044 };
  const script = mod.buildHelperScript(fake, "19387");
  const lines = script.split("\r\n").filter((line) => line.length > 0);

  check("用 CRLF 换行（cmd 的脾气）", script.includes("\r\n"));
  check("没有裸 LF", !/[^\r]\n/.test(script));
  check("设置 EXE", script.includes('set "EXE=E:\\dsh\\DeepSeek Harness.exe"'));
  check("设置 PARENT", script.includes('set "PARENT=27400"'));
  check("设置 SELF", script.includes('set "SELF=15044"'));
  check("开头是 @echo off", lines[0] === "@echo off");
  check("结尾是 endlocal", lines[lines.length - 1] === "endlocal");
  check("有 setlocal", script.includes("setlocal"));

  const killParent = lines.findIndex((line) => line.includes("taskkill /PID %PARENT%"));
  const killSelf = lines.findIndex((line) => line.includes("taskkill /PID %SELF%"));
  const firstWait = lines.findIndex((line) => line.includes("ping -n"));
  const launch = lines.findIndex((line) => line.includes('start "" "%EXE%"'));
  check("三个关键动作都找到了", killParent > 0 && killSelf > 0 && launch > 0, `parent=${killParent} self=${killSelf} launch=${launch}`);
  check("先等一会儿再动手（让界面把'正在重启'画出来）", firstWait > 0 && firstWait < killParent, `wait=${firstWait} killParent=${killParent}`);
  check("先杀父进程（Electron 主进程）", killParent < killSelf, `parent=${killParent} self=${killSelf}`);
  check("最后才拉起新实例", launch > killParent && launch > killSelf, `launch=${launch}`);

  console.log("\n[3] 安全约束");
  check("绝不按镜像名杀进程（taskkill /IM）", !/taskkill\s+\/IM/i.test(script));
  check("没有 /T 递归杀（会把派出去的帮手自己也带走）", !/taskkill[^\r\n]*\/T\b/i.test(script));
  check("每个 taskkill 都指定了 PID", (script.match(/taskkill/g) ?? []).length === (script.match(/taskkill\s+\/PID/g) ?? []).length);
  check("拉起时路径带引号（路径里有空格）", script.includes('start "" "%EXE%"'));
  check("没有 goto/label 之类的花活", !/\bgoto\b|^:/m.test(script));
  check("日志落在脚本同目录（%~dp0），且统一走 %LOG% 变量", script.includes('set "LOG=%~dp0restart.log"') && script.includes('"%LOG%"'));
  check("日志里带上端口，便于事后排查", script.includes("port=19387"));

  console.log("\n[4] 踩过的坑：等待方式与残留清理");
  // timeout 需要一个控制台输入句柄；detached 起的帮手没有控制台，它会立刻失败 ⇒ "等 3 秒"一秒都没等
  check("绝不用 timeout（脱离控制台时会立刻失败）", !/\btimeout\b/i.test(script));
  check("用 ping 当 sleep", script.includes("ping -n"));
  check("有三段等待（动手前 / 释放 / 自检）", (script.match(/ping -n \d+ 127\.0\.0\.1 >nul/g) ?? []).length === 3, String((script.match(/ping -n \d+ 127\.0\.0\.1 >nul/g) ?? []).length));
  check("杀掉主进程和 host 之后清理残留的 DSH 进程", script.includes("leftovers:") && /for \/f[^\r\n]*taskkill/.test(script));
  check("残留清理也是按 PID（从 tasklist 取）", /tasklist[^\r\n]*\/FO CSV/.test(script) && !/taskkill\s+\/IM/i.test(script));
  check("启动后有自检：把进程列表写回日志", script.includes("after start:"));
  const verify = lines.findIndex((line) => line.includes("after start:"));
  check("自检在 start 之后", verify > launch, `launch=${launch} verify=${verify}`);

  console.log("\n[5] 端口缺失也要能生成");
  const noPort = mod.buildHelperScript(fake, "");
  check("没有端口时仍可生成", noPort.includes('set "SELF=15044"') && noPort.includes('start "" "%EXE%"'));

  console.log("\n[6] 跳板脚本（wscript + 隐藏控制台）");
  // 实测：detached 的 cmd 没有控制台 —— 外部命令会蹦黑窗口且输出抓不到（清理循环失效）；
  // 不 detached 又活不过父进程被杀。所以必须用 wscript 当跳板把 cmd 藏起来跑。
  const launcher = mod.buildLauncherScript("C:\\Users\\Administrator\\.dsh\\cache\\dsh-restart\\restart.cmd");
  check("用 WScript.Shell", launcher.includes('CreateObject("WScript.Shell")'));
  check("用窗口样式 0（SW_HIDE）跑 cmd，这样才有控制台但看不见窗口", /sh\.Run[^\r\n]*,\s*0\s*,\s*False/.test(launcher));
  check("拉起的是 cmd.exe", launcher.includes('"cmd.exe /d /c'));
  check("helper 路径被引号包住（路径里有空格）", launcher.includes('restart.cmd""'));
  check("跳板脚本用 CRLF", launcher.includes("\r\n"));
  check("跳板脚本是纯 ASCII（wscript 按 ANSI 读）", /^[\x00-\x7F]*$/.test(launcher));
  check("helper 脚本是纯 ASCII（cmd 按 ANSI 读）", /^[\x00-\x7F]*$/.test(script));
} finally {
  await rm(tmpRoot, { recursive: true, force: true });
}

console.log(`\nhost 测试：${pass} 项 PASS，${fail} 项 FAIL。`);
if (fail > 0) process.exitCode = 1;
