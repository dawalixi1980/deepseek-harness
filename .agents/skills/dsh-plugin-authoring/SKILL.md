---
name: dsh-plugin-authoring
description: Use when creating, packaging, distributing, installing, debugging, or verifying DeepSeek Harness (dsh) plugins — bundle/profile structure, cordis.patch.yml layers, tarball vs git install pitfalls, web client settings whitelist, and runtime verification. 创建/打包/分发/安装/调试 DeepSeek Harness 插件，或验证插件安装与配置层时使用。
whenToUse: 接到"开发/打包/安装/排查 dsh 插件"、"为什么插件装了不生效"、"settings-not-exposed"、"插件启动报 ERR_MODULE_NOT_FOUND" 等任务时。
metadata:
  verified-with: dsh 0.1.0-rc.6
---

# DeepSeek Harness 插件开发框架（实战版）

本 skill 沉淀自一次完整实战：开发、分发、安装、验证一个真实 Web 客户端插件（`dsh-chat-background`）的全过程，含官方文档未覆盖的实测结论。官方权威来源：[打包与安装插件](../../docs/user/develop/basic/publish.md)、[插件配置](../../docs/user/develop/basic/config.md)、[Cordis 教程](../../docs/cordis-tutorial/index.md)。

## 1. 核心概念

| 概念 | 是什么 | 谁写 |
|---|---|---|
| 组合包 (bundle) | 带配置层的 npm 包，`package.json` 声明 `dsh.bundle`（指向 `cordis.patch.yml`） | 插件作者分发 |
| profile | `$DSH_HOME/profiles/<name>/` 下的可启动组合，`dsh.profile` 声明有序 `bundles` 列表 | `dsh plugin` 自动维护 |
| patch 层 | `cordis.patch.yml`：insert/override 插件行的 YAML 数组 | 作者 / 用户 |
| loader | 启动时按 bundles 顺序 + profile patch + `--patch` overlay 组装插件树 | 框架 |

插件树**在进程启动时一次性组装**——装完插件必须重启后端进程才生效，刷新浏览器没用（浏览器只是前端）。

## 2. 插件代码形态

三种形态（函数 / 对象 / 类），普通插件用函数形态：

```ts
// function plugin（最常用）
import type { Context } from '@deepseek-ai/cordis'
export const name = 'my-plugin'          // 可选，诊断用
export const inject = ['tools']          // 可选，声明依赖的服务；未就绪则保持 PENDING
export function apply(ctx: Context) {    // 挂载时调用
  ctx.effect(() => { /* 外部资源 */ return disposer })  // 注册即 effect，卸载自动撤销
}
```

- **服务**：`Service` 子类 + `declare module` 声明合并；提供方 `ctx.plugin(MyService)`，消费方 `inject: ['name']`。
- **事件**：`declare module` 合并 `interface Events`；5 种分发（emit/parallel/serial/bail/waterfall）。waterfall 只观察的监听器**必须调用 `next()`**，否则短路吞掉下游。
- **配置**：导出 `Config`（Schemastery schema 同名），`cordis.yml` 的 `config` 块在 `apply` 前验证，错误即 FAILED 报错退出，绝不静默跳过。
- **注册即 effect**：`ctx.on()` / `ctx.plugin()` / `ctx.tools.register()` / `ctx.settings.register()` 都随插件卸载自动撤销。

Web 客户端插件是"双半"结构：主机半（`src/index.ts`，Node，注册 settings schema 等服务）+ 浏览器半（`src/client/index.ts`，`ClientContext`，`ctx.slots.inject('settings.section', ...)` 注册设置 UI、`ctx.settingsScope.bind()` 绑定持久化命名空间）。

## 3. 创建组合包（bundle）

```
my-plugin/
├── package.json       # 声明 dsh.bundle
├── cordis.patch.yml   # 配置层
├── index.js           # 插件模块（patch 行引用的包入口）
└── lib/               # 预构建产物（若分发构建产物）
```

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

```yaml
# cordis.patch.yml —— 插件行按包名引用（Node 才能解析到已安装代码）
- insert:
    - id: my-plugin
      name: my-plugin
```

没有 `dsh.bundle` 声明的包也能装，但只是普通依赖，不激活任何层（loader 会打警告）。

## 4. 分发与安装（实测结论，重要）

安装命令统一为：`dsh plugin --profile <name> add <来源>`（在 profile 目录内转发给 pnpm）。

| 方式 | 命令 | 实测结果 |
|---|---|---|
| npm 发布 | `dsh plugin add <pkg>` | ✅ 最标准，装的是发布时构建好的代码 |
| **tarball** | `dsh plugin add ./x-0.1.0.tgz` | ✅ **唯一开箱即用**（依赖一起装） |
| 本地目录 | `dsh plugin add ./my-plugin` | ⚠️ link 安装**不递归安装 dependencies**，有依赖的插件启动即崩 `ERR_MODULE_NOT_FOUND` |
| GitHub | `dsh plugin add github:user/repo#sha` | ⚠️ 要求**仓库根 = 包根**，不支持子目录；git 安装拉源码，需要 `prepare` 脚本 + 用户 `allowBuilds` 授权 |

**关键教训：真实插件都有依赖，tarball 或 npm 发布是唯一省心的分发方式。** 教程示例插件无依赖，所以官方文档没暴露 link/git 的坑。

- **git 安装**：作者提供自包含 `prepare` 脚本（pnpm 安装后自动跑）；用户首次 add 会失败，需在 profile 的 `pnpm-workspace.yaml` 加 `allowBuilds: { <pkg>: true }`（= 允许该包代码在安装时执行，只在源码可信时授权，建议锁定 `#<sha>`）。
- **分发构建产物**（`lib/` 随包，无 prepare 脚本）可以完全绕开 allowBuilds。

## 5. Web 客户端插件白名单（settings-not-exposed 血泪坑）

浏览器能否读写设置 namespace，由 `dsh-host-apiproxy` 的**硬编码白名单**决定：

```js
// node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js
const WEB_SETTINGS_NAMESPACES = ["agent-loop", "shell", "locale", "permission", "ui-conversation", "ui-theme", "web-search-deepseek", /* 自定义 namespace 加这里 */];
```

- 不在白名单的 namespace 即使插件注册了，浏览器端读写也返回 `settings-not-exposed`。
- 源码注释自认这是 **deferred work**（计划让插件自己暴露，未实现）→ 每个新 Web 设置插件在官方合入前都要手工 patch。
- **临时 patch 方法**：备份原文件 → 白名单数组加 `"<你的 namespace>"` → 重启 dsh web。升级 dsh 会被覆盖。

## 6. 验证清单（每步都实测过）

```sh
# 1. 安装（以 tarball 为例）
dsh plugin --profile web add ./my-plugin-0.1.0.tgz

# 2. 验证组合层生效（不启动）
dsh --profile web --dump-config | grep my-plugin

# 3. 另起端口测试实例（不干扰现有 GUI）
dsh --profile web --port 3100

# 4. 验证浏览器引导清单含插件
curl -s http://127.0.0.1:3100/ | grep my-plugin

# 5. 验证设置白名单（Typert RPC 协议，HTTP 端点 = /api/<method>）
curl -s -X POST http://127.0.0.1:3080/api/settings.describe \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"probe","method":"settings.describe","payload":{}}'
# 响应 namespaces 数组里应包含你的 namespace；写入测试用 settings.mutate（ops: set/unset）

# 6. 重启正式后端使插件进入 GUI
#    杀旧 node 进程 → dsh --profile web（浏览器刷新即可，不用重开窗口）
```

## 7. 常见坑速查

| 症状 | 原因 | 处理 |
|---|---|---|
| `ERR_PNPM_INVALID_DEPENDENCY_NAME` | git 安装但仓库根不是包 | 包提到仓库根，或改用 tarball |
| `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-settings'` | link: 安装不装依赖 | 改 tarball/npm 安装 |
| `settings-not-exposed` | namespace 不在 WEB_SETTINGS_NAMESPACES | patch 白名单 + 重启 |
| 装完 GUI 看不到 | 插件树启动时组装，无热安装 | 重启后端进程（不是刷新浏览器） |
| 插件保持 PENDING 无输出 | inject 的服务无人提供 | 检查组合里是否缺提供方插件 |
| "两个对话窗口" | 多个 dsh web 实例（不同端口） | 确认只用一个端口（如 3080） |
| git 连不上 GitHub | 本机 git 配置了代理但代理未运行 | `git -c http.proxy= -c https.proxy= <cmd>` 临时绕过 |
