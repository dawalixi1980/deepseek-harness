# deepseek-harness (dawalixi1980)

本仓库存放 DeepSeek Harness 相关的独立插件/工具。

每个目录都是一个可以独立安装的 DSH 插件或技能包，各自有 README 说明细节。

## 内容

| 目录 | 说明 |
|---|---|
| [`dsh-skill-url/`](dsh-skill-url/README.md) | **从网址装技能**：粘贴一个 GitHub 网址，自动递归找出仓库里所有 `SKILL.md`，在设置面板里逐个安装 / 卸载，并可保存常用仓库网址。零第三方依赖，含预构建 `lib/` 与 bundle 补丁层。README 里记录了 DSH 插件开发的 **6 个致命坑**（TDZ、codec 形状、slot props、挂载护栏、方法名禁用名单、host/client 版本错位）与两个从 `app.asar` 抠真实校验源码的回归测试。 |
| [`dsh-plugin-url/`](dsh-plugin-url/README.md) | **从网址装插件**：社区搜索、快速发现与后台安装任务，安装进度就地显示在点击处，支持取消。安装走官方 `pluginManager.installBundle`（tarball 形式），失败由管理器自己回滚 `package.json` / `pnpm-lock.yaml`。 |
| [`dsh-lexiang/`](dsh-lexiang/README.md) | **乐享知识库面板**：在 DSH 设置里浏览乐享知识库与目录树、读正文、关键词/语义检索、**上传整个文件夹**（保留子目录层级，单文件不设大小上限）、新建/重命名/删除条目。**凭证由使用者在界面上自填**（存本机 ~/.dsh，不进仓库）。host 端直连乐享 MCP（JSON-RPC over SSE），零第三方依赖。也修掉了一批 Electron 里静默失效的交互（`window.prompt/confirm` 恒返回 null/false 导致按钮全哑）。 |
| [`dsh-restart/`](dsh-restart/README.md) | **一键重启 DSH**：侧栏底部一个按钮，关掉应用并重新打开。因为 host 进程拿不到 `app.relaunch()`、也没有给第三方的重启 IPC，只能另起一个脱离进程组的帮手来杀进程并重新拉起可执行文件（用 `wscript` 当跳板）。 |
| [`dsh-chat-background/`](dsh-chat-background/README.md) | 聊天背景插件：在 Web GUI 设置中选择本地图片作为聊天窗口背景。独立分发的 bundle，含预构建 `lib/` 和 `dsh.bundle` 补丁层，可通过 `dsh plugin add` 安装。 |
| `[lexiang/](lexiang/)` | 腾讯乐享官方 MCP 技能包（@lexiang/skills v1.1.2，MIT），6 个 skill：配置向导 / 搜索阅读 / 文档写入 / Block 编辑 / 文件上传 / 外部数据源导入。 |
| [`.agents/skills/harnessmaker/`](.agents/skills/harnessmaker/SKILL.md) | 插件开发 skill：完整开发/分发/安装/验证框架，含实测踩坑（tarball vs git/link 安装、Web 白名单 `settings-not-exposed`、运行时验证清单）。 |

## 相关仓库

| 仓库 | 说明 |
|---|---|
| [dsh-ogodingyue](https://github.com/dawalixi1980/dsh-ogodingyue) | **OpenCode Go 用量常驻条**（黑白配色版）：输入框下方常驻显示套餐余量（滚动/周/月）、token 消耗与花费。fork 自 `OK-wx/dsh-ocgo-lite`，只改配色 —— 去掉全部品牌色改为纯灰阶、不跟主题、去掉字重与光晕。**独立仓库，不在本仓库内。** |

## 关于这些插件

它们都是为**自己用**而写的，所以：

- **不含遥测**，不向外发数据；
- 凭证一律**不进仓库**，由使用者在本机界面上填；
- 每个插件的 README 都记录了**实测踩到的坑**，以及当时是怎么定位的 —— 这部分往往比功能本身更有参考价值。
