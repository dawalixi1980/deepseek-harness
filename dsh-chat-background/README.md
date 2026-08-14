# dsh-chat-background

DeepSeek Harness Web GUI 聊天背景插件：在设置中选择本地图片作为聊天窗口背景，选择以 data URL 持久化到用户设置文档，刷新后和同一 harness 主目录下的其他 Web 端口都会保留。

该包是 `packages/client/ui-chat-background`（`@deepseek-ai/dsh-client-ui-chat-background`）的独立分发版本：预构建的 `lib/`（节点半 + 浏览器端 `client.js`）+ 可直接激活的 bundle 补丁层，源码在 `src/`。

## 安装（给使用者）

在装有 `dsh` CLI 的机器上，向 `web` profile 安装本 bundle：

```sh
# 方式一：从 git 仓库安装（推荐固定 commit，例如 #<sha>）
dsh plugin --profile web add github:dawalixi1980/<仓库名>#<sha>

# 方式二：tarball（在包目录先执行 pnpm pack）
dsh plugin --profile web add ./dsh-chat-background-0.1.0.tgz

# 方式三：本地目录
dsh plugin --profile web add file:/path/to/dsh-chat-background
```

然后重启 Web 服务使主机侧组合生效：

```sh
dsh web
```

启动后进入 **设置 → 聊天背景**，选择本地图片即可。图片最大 2 MB。

本包不携带任何 build/prepare 脚本，`lib/` 已随仓库分发，因此 git 安装无需 `allowBuilds` 放行。

## 前置条件（重要）

本插件是 web 客户端插件，依赖 harness 的 `settings` 服务把 `ui-chat-background` 命名空间**暴露给浏览器**。该暴露由 `dsh-host-apiproxy` 包中的硬编码白名单（`WEB_SETTINGS_NAMESPACES`）决定：

- 当前官方发布版（`0.1.0-rc.6` 及更早）的 `WEB_SETTINGS_NAMESPACES` **不含** `ui-chat-background`，安装后设置 section 会以 `settings-not-exposed` 拒绝读写。
- 在本仓库（含未合入改动的检出）中已加入该命名空间，功能可用。
- 官方仓库合入该改动后的版本无需任何额外操作。

因此，在官方版本跟上之前，使用者在自己的安装上需要把 `ui-chat-background` 加入 `packages/host/apiproxy/src/api-proxy.ts` 的 `WEB_SETTINGS_NAMESPACES` 数组（或使用已包含该改动的 harness 版本）。

## 结构

```
package.json        # dsh.bundle + dsh.client 清单，真实版本依赖（无 workspace: 协议）
cordis.patch.yml    # 向 web 组合插入 ui-chat-background 行
lib/                # 预构建产物：index.js（节点半）、invariant.js、client.js（浏览器端）、types/**
src/                # 插件源码（设置 schema、presenter、设置 section 组件、文案）
README.md / LICENSE
```

## 来源与许可

源码来自 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 `packages/client/ui-chat-background`，MIT 许可。上游 README 见 `src` 对应目录的原始说明（`README.md` / `README.zh.md` 未随本包分发，功能契约见 [packages/client/ui-chat-background](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/client/ui-chat-background)）。
