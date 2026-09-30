# dsh-restart

DeepSeek Harness 桌面版的**一键重启**插件：侧边栏底部一个按钮，点一下关闭应用并重新打开。

**位置**：侧边栏底部、最下面那一行的**正上方**。这个位置是从源码确认的：

```
SidebarRoot 的 footArea = [
  div.footerActions { renderSlot("sidebar.footer.action", { wide }) },   ← 本插件注册在这
  div.settingsArea  { renderSlot("sidebar.settings",  { wide }) }        ← 最底下一行
]
```

官方插件 `@deepseek-ai/dsh-client-ui-cordis` 也往 `sidebar.footer.action` 注册，可以对照。

---

## 一、为什么重启要这么绕（实测结论）

桌面版是**同一个 `DeepSeek Harness.exe` 镜像跑三种角色**：

```
PID 27400  DeepSeek Harness.exe                        ← Electron 主进程（GUI 窗口）
 ├─ 25048  --type=renderer                             ← 界面
 ├─ 26656  --type=gpu-process
 └─ 15044  --expose-internals ...dsh-desktop-host...   ← DSH host，插件跑在这里
```

三条"正规"的路，全都被堵死了：

| 想法 | 为什么不行 |
|---|---|
| `app.relaunch()` + `app.exit(0)` | **我们不在主进程里**。host 是主进程用 `ELECTRON_RUN_AS_NODE` 拉起来的子进程。探针实测：`process.type === null`、`import("electron")` 只返回一个路径字符串、**没有 `app` 对象** |
| 通过 IPC 请主进程重启 | 没有给第三方用的通道。host→主进程的合法消息只有 `ready` / `platform-session` / `shutdown-complete` / `fatal`（主进程用 `isDesktopHostEvent` 白名单校验，发别的会被当成 invalid 直接 `SIGTERM`）；界面→主进程的 `DESKTOP_IPC` 里只有快捷键 / 引导 / 目录选择 / 更新这些 |
| 让 host 优雅退出，换一次重启 | **主进程把 host 退出当崩溃**：`child.once("close", code => …)` 里两个分支都走 `fail("dsh desktop host stopped")`，连退出码 0 也算。结果是弹崩溃恢复框，不是重启 |

只剩一条：**另起一个脱离进程组的帮手，由它来杀进程并重新拉起可执行文件。**

## 二、帮手脚本干什么

host 半每次现生成一个 `restart.cmd`（落在 `~/.dsh/cache/dsh-restart/`）并**脱离**启动它：

```bat
@echo off
setlocal
set "EXE=E:\dsh\DeepSeek Harness.exe"
set "PARENT=27400"      ← Electron 主进程
set "SELF=15044"        ← host 自己
timeout /t 2            ← 留给界面把"正在重启"画出来
taskkill /PID %PARENT% /F
taskkill /PID %SELF% /F
timeout /t 3            ← 等端口释放
start "" "%EXE%"
endlocal
```

因为是用 `detached: true` 启动的，我们（host）被杀掉时它不受影响，能继续跑完。

脚本刻意**保持极简，没有端口轮询之类的花活** —— 这个脚本没法在开发环境里完整跑一遍（跑一遍就等于把自己重启了），所以每一行都必须一眼看懂。执行日志写在同目录的 `restart.log`。

## 三、代价（必须说清）

- **这是硬杀，不是优雅退出**：没落盘的东西会丢。DSH 的会话是 JSONL 持续写的，风险不大，但**不是零**。
- **只针对当前这个实例的 PID**，不会误伤你另外开的 DSH。脚本里**没有** `taskkill /IM`，也**没有** `/T`（递归杀会把脱离进程组的帮手自己也带走）。这两条有测试钉死。
- 如果新实例起来时端口还没释放，DSH 会弹"另一个 DSH 实例在运行"并提供重启按钮 —— 脚本里那 3 秒就是为这个留的。
- **整个 DSH 进程退出**时，正在跑的任务会断（和后台任务不同，这里没有绕开的办法）。

## 四、支持范围

| 运行方式 | 能不能用 |
|---|---|
| 桌面版（`DeepSeek Harness.exe`） | ✅ |
| 从源码跑 `pnpm dsh web` | ❌ 按钮置灰，并把原因写在旁边（"当前不是 DSH 桌面版…请自己重启"） |

判定方式是看 `process.argv` 里有没有 `dsh-desktop-host` —— 这是最硬的标记（不是靠进程名猜）。

## 五、安装

```powershell
cd dsh-restart
pnpm pack
dsh plugin --profile <你的 profile> add .\dsh-restart-0.1.0.tgz
```

> ⚠️ 装完**需要重启 DSH** 才会生效（host 半只在进程启动时加载一次）。第一次请手动重启。

## 六、文件结构

```
package.json          # dsh.bundle + dsh.client 清单（无构建脚本，lib/ 已随包分发）
cordis.patch.yml      # bundle 补丁层：向 profile 插入 app-restart 行
lib/index.js          # host 半：appRestart 远程服务（restartSupport / restart）+ 帮手脚本生成
lib/client.js         # client 半：sidebar.footer.action 里的按钮
test/host.test.mjs    # detect() / buildHelperScript() 的离线单测
test/load-client.mjs  # client 半加载 + 渲染 + 点击交互
test/validate-typert-contract.mjs   # typert 契约（从真实 app.asar 抠校验代码）
```

### 远程接口（host 半 `appRestart` 命名空间）

| 方法 | 参数 | 说明 |
|---|---|---|
| `restartSupport` | — | `{supported, reason, exe, mode, parentPid, selfPid}`；不支持时 `reason` 是一句人话 |
| `restart` | — | 生成帮手并脱离启动它，然后立刻返回。**几秒后本进程就被杀了，这个回执客户端多半收不到** |

## 七、测试

```powershell
cd dsh-restart
node test/host.test.mjs                 # 离线：detect 判定 + 帮手脚本内容与顺序 + 安全约束
node test/load-client.mjs               # client 半加载 + 渲染 + 点击调用 restart
node test/validate-typert-contract.mjs  # typert 契约（默认读 E:\dsh\resources\app.asar）
```

契约测试与渲染测试都从**已安装的 DSH（app.asar）里抠真实校验源码**，DSH 升级一改契约测试就会失败。

## 八、开发 DSH 插件会踩的坑（本插件踩到 / 规避的）

1. **ESM 暂时性死区（TDZ）**：`const codec = ...` 必须声明在 `CONTRIBUTION` / `MANIFEST` **之前**，否则模块求值期就抛错，整个 Web 端起不来。`node --check` 查不出来。
2. **typert codec 形状**：strict codec 必须是 `{ mode, typeSymbol, create: () => schema }`，缺 `create()` 注册即失败。
3. **slot props 形态**：宿主把 `inject()` 的返回值**摊平成 props**，不存在 `props.face`；owner 传来的 `wide` 也在 props 上。
4. **挂载期同步抛错会白屏**：所有远程调用都要包 try/catch。
5. **远程方法名禁用名单**：不能叫 `install` / `remove` / `has` / `name` / `ctx` / `namespace` 等（`RemoteNamespaceService` 原型成员）。
6. **host 半改了要重启进程**：client bundle 每次请求现读，host 半只在进程启动时 import 一次。
7. **`jsx(type, props, key)` 第三个参数是 key，不是 children** —— 文字必须写进 `props.children`，否则渲染成空元素。

## 许可

MIT
