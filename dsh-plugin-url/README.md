# dsh-plugin-url

DeepSeek Harness 插件：**粘一个 GitHub 仓库地址 → 递归找出仓库里所有 DSH 插件包 → 逐个安装 / 卸载。**

图形面板在 **设置 → 从网址装插件**。

> 与官方「添加插件」的区别：官方只认 `host/owner/repo` 三段地址，而且**要求仓库根就是包根**。
> 一个仓库里放多个插件（monorepo）时，官方那条路会失败在
> `not-a-bundle: <name> declares no dsh.bundle`。
> 本插件专治这个：它把子目录里的插件**就地打成 npm tarball**，再交给官方插件管理器安装，
> 所以仓库怎么组织都行。

---

## 一、为什么官方装不了 monorepo（实测链条）

| 步骤 | 发生什么 |
|---|---|
| `parseInstallSpec("https://github.com/o/r")` | 匹配 `HOSTED_REPOSITORY_URL`，判为 `kind: 'git'`，**这一步是过的** |
| pnpm `add github:o/r` | 克隆仓库，把**仓库根**当包根 |
| 仓库根没有 `package.json` | pnpm 塞一个占位文件：`{"_pnpmPlaceholder":"..."}` |
| `bundleManifest()` 读 `dsh.bundle` | 读不到 |
| `installBundle()` | 抛 `ManagementFailure("not-bundle")`，回滚 `package.json` / `pnpm-lock.yaml` |

另外官方地址正则 `^https?:\/\/[^/]+\/[^/]+\/[^/#]+(?:\.git)?(?:#.*)?$` 只接受三段，
所以 `.../tree/main/子目录` 会被判成 `a URL must point at a git repository or a tarball` —— **不支持子目录**。

本插件绕开的是第 2 步：不把仓库交给 pnpm，而是自己解压、自己定位包、自己打包。

---

## 二、安装

```powershell
cd dsh-plugin-url
pnpm pack
dsh plugin --profile <你的 profile> add .\dsh-plugin-url-0.2.0.tgz
```

装完在 GUI 里刷新页面即可（本插件带 client 半，host 半会被 HMR 热加载；若面板空白就重启 DSH）。

> ⚠️ **同版本重打包不会生效**：profile 的 `pnpm-lock.yaml` 把 tarball 按路径钉住了，
> 再 `add` 一次同样的路径，pnpm 会直接用锁文件里的旧包（输出会是 `added 0`）。
> 改了代码要重装，必须先 `dsh plugin --profile <p> remove dsh-plugin-url`，或者把 `version` 升一位。

---

## 三、用法

1. 打开 **设置 → 从网址装插件**
2. 粘网址，支持这些形式：
   - `https://github.com/owner/repo`
   - `https://github.com/owner/repo/tree/<ref>/<子目录>`
   - `https://github.com/owner/repo/blob/<ref>/<文件>`
   - `raw.githubusercontent.com/...`
   - 裸写 `owner/repo`
   - 漏写 `https://` 会自动补
3. 点「查找插件」→ 列出仓库里所有声明了 `dsh.bundle` 的包
4. 每个包单独「安装」/「卸载」

> 结果行里会标出这次走的**发现路线**：
> - **轻量扫描** —— 只取仓库的路径清单 + 几个 `package.json`（默认，秒级）
> - **整包扫描（回退）** —— 路径清单被截断 / API 限流时才下载整包归档，会慢很多
>
> 详见下面「为什么发现这么快」。

列表里的标签含义：

| 标签 | 含义 |
|---|---|
| 可直接装 | 无构建脚本、入口文件存在 → 打包即可用 |
| 需要构建 | 声明了 `prepare` / `postinstall` 等 → 需要源码构建，多半会失败（会显示具体脚本名） |
| 缺入口产物 | `main` / `exports` 指向的文件不在包里（典型的"只发 src"） |
| 含界面 | 该插件带 `dsh.client`（Web 半边） |

### 关掉设置也不会中断

扫描和安装都是**后台任务**，跑在 host 进程里 —— 你退出设置页，活儿照跑。

面板顶部会有一条「后台任务」，显示每个任务在干什么、跑了多久。再打开设置时：

- 有任务在跑 → 卡片还在，继续显示进度（面板每 1.5 秒问一次 host）
- 已经跑完 → **上次的扫描结果直接回来，不用重扫**

> 一个例外：**整个 DSH 进程退出**时，正在跑的任务会真的断掉。后台 ≠ 能扛进程退出。
>
> 另一个好处：同一个仓库正在扫的时候再点「查找」，会**接到那个任务上**，不会重复下载。

### 社区插件检索

同一个面板里还有**「社区插件」**区：按 GitHub 话题 `dsh-plugin` 检索（按星数排序），
可以在关键词框里追加过滤词（`markdown`、`diagram` …），支持翻页。

每条结果有一个「查看插件」：点一下就会把该仓库地址填进上面的输入框并**直接扫一遍**，
复用的就是同一条发现流程 —— 所以社区检索没有另起一套下载/安装逻辑。

> ⚠️ **挂着 `dsh-plugin` 话题 ≠ 是 DSH 插件。** 这个话题下有上万仓库，混着大量
> 顺手打标签的非插件项目（各种 resume / memory / 框架仓库）。所以面板**不会**预先替你
> 判断"这是不是插件" —— 点开扫过 `dsh.bundle` 才算数。搜索结果里 30 个仓库，
> 不可能为了显示列表就去下 30 个归档（又慢又费配额）。

配额说明：未认证的 GitHub 搜索 API 只有 **10 次/分钟**，而且本插件**不读取、不存储、
不发送任何 token**。两个护栏：

- 只在点「搜索社区插件」时才发请求（**不做输入即搜**，否则几秒就烧光）；
- 同一个「查询 + 页码」的结果缓存 **10 分钟**，缓存目录 `~/.dsh/cache/dsh-plugin-url/community/`。

被限流时会明确告诉你什么时候可以重试，而不是静默失败。

---

## 四、实现要点

### 为什么发现这么快

发现插件**不需要下载整个仓库**。实测一个真实仓库（`elysia395/dsh-wallpaper-engine`，
GitHub 报 **83 MiB**，但文件总数只有 **169 个** —— 体积全压在某几个巨型媒体文件上）：

| 路线 | 做什么 | 实测耗时 |
|---|---|---|
| **轻量（默认）** | `git/trees?recursive=1` 拿路径清单（48 KiB），再只抓那几个 `package.json` | **约 2–3.5 秒** |
| 整包归档（回退） | 下载 83 MiB 归档 → 解压到磁盘 → 递归遍历 | **5 分钟以上**，还没跑完 |

为找两个 `package.json` 把 83 MiB 全下下来是纯浪费。走轻量路线时**一个字节都不落盘**，
`readiness` 判定（入口文件在不在）也直接用手上的路径清单算，不用再下任何东西。

**回退条件**（满足任一条就走归档路线）：

- GitHub 把路径清单截断了（超大仓库，响应里的 `truncated: true`）
- core API 限流（未认证 60 次/小时）
- `raw.githubusercontent.com` 读不到

代价与守卫：core API 每次浏览仓库只花 **1 次**，结果缓存 10 分钟（`~/.dsh/cache/dsh-plugin-url/trees/`）；
单个仓库最多抓 40 个 `package.json`，防极端仓库打爆配额。

> 正确性由 `test/tree-scan.test.mjs` 的**交叉验证**兜住：同一个仓库同时跑轻量路线和归档路线，
> 两边发现的 `{name, subpath, readiness}` 集合必须**完全一致** —— 快而不准没有意义。

### 安装为什么自己打 tarball

三种可选形式都不行，只剩 tarball：

| 形式 | 问题 |
|---|---|
| git URL | 只认仓库根 = 包根（见上） |
| 本地目录 `path` | 是 link 安装，**不递归装 dependencies**；而且临时解压目录会变成永久依赖，清不掉 |
| **tarball** | ✅ 插件管理器实测唯一开箱即用；`install-spec.ts` 里 `.tgz` 走 `kind: 'tarball'` |

而 `pnpm pack` 不能用 —— DSH 桌面版 host 进程不保证 PATH 里有 pnpm（插件管理器自己是从
`pnpmCommand`（默认 `"pnpm"`）找的，那个值不对外暴露）。所以 `lib/tarball.js` 用
`node:zlib` + 手写 512 字节 tar 头自产 npm tarball，**零依赖、零外部进程**。
支持 ustar prefix 拆分与 GNU longname 两种长路径写法。

### 安装走的是官方那条管道

`lib/index.js` 注入官方的 `pluginManager` 服务，最终调用 `installBundle(<tarball 绝对路径>)`。
所以失败回滚、`not-bundle` 校验、版本兼容性校验、profile 激活——**全部复用官方护栏**，
本插件不自己写一套。

### 识别标准和官方一致

只在 `package.json` 声明了 `dsh.bundle.patch` 时才算插件包 —— 这正是 `bundleManifest` 的门槛。
所以「面板里能看到的」和「真能装上的」集合必然一致，不会出现显示了但装不上。

---

## 五、文件结构

```
package.json          # dsh.bundle + dsh.client 清单（无构建脚本，lib/ 已随包分发）
cordis.patch.yml      # bundle 补丁层：向 profile 插入 plugin-url 行
lib/index.js          # host 半：pluginUrl 远程服务（typert MANIFEST）
lib/client.js         # client 半：设置页分区（手写 bundle）
lib/discover.js       # URL 解析 / 归档下载 / ZIP 解压 / 递归扫描（逐字复用自 dsh-skill-url）
lib/scan.js           # 插件包发现 + readiness 判定
lib/tarball.js        # 纯 Node npm tarball 打包器
lib/community.js      # 社区检索：topic:dsh-plugin（带 10 分钟缓存与限流处理）
test/*.mjs            # 5 个测试
```

### 远程接口（host 半 `pluginUrl` 命名空间）

| 方法 | 参数 | 说明 |
|---|---|---|
| `inspect` | `url` | 解析 + 下载 + 递归发现，返回插件清单（不落盘） |
| `installPlugin` | `url`, `subpath` | 打包并安装（**线名不能叫 `install`**，见下） |
| `uninstallPlugin` | `name` | 卸载 |
| `listInstalled` | — | 已装的可管理插件（含来源仓库） |
| `searchCommunity` | `keywords`, `page` | 按 `topic:dsh-plugin` 检索候选仓库（只返回仓库元信息） |
| `rememberUrl` / `recentUrls` / `forgetUrl` | `url` / — / `url` | 已保存的仓库网址（归一化 + 去重，最多 12 条） |

---

## 六、开发 DSH 插件会踩的坑（本插件全部踩过）

1. **ESM 暂时性死区（TDZ）**：`const codec = ...` 必须声明在 `CONTRIBUTION` / `MANIFEST` **之前**，
   否则模块求值期就抛 `Cannot access 'identity' before initialization`，整个 Web 端起不来。
   `node --check` **查不出来**。
2. **typert codec 形状**：strict codec 必须是 `{ mode, typeSymbol, create: () => schema }`。
   写成 `{ mode, typeSymbol, schema }` 会报 `strict codec has no create() factory`。
3. **slot props 形态**：宿主把 `inject()` 的返回值**摊平成 props**，不存在 `props.face`。
   要写 `const face = props.face ?? props;`。
4. **挂载期同步抛错会白屏**：`useEffect` 里一个同步 throw 就让整个分区变空白
   （文档原话 "a throwing component blanks your slot entry"）。所有远程调用都要包 try/catch，
   缺服务时渲染红字而不是白屏。
5. **远程方法名禁用名单**：不能叫 `install` / `remove` / `has` / `name` / `ctx` / `namespace` 等
   （`RemoteNamespaceService` 原型成员）。本插件用 `installPlugin` / `uninstallPlugin`。
6. **host 半改了要重启进程**：client bundle 每次请求现读，host 半只在进程启动时 import 一次。
7. **`jsx(type, props, key)` 第三个参数是 key，不是 children**。文字必须写进 `props.children`，
   否则渲染成空胶囊（数据是好的，只是不显示）。

---

## 七、测试

```powershell
cd dsh-plugin-url
node test/scan.test.mjs                 # 插件包发现
node test/tarball.test.mjs              # 手写 tarball 打包器
node test/community.test.mjs            # 社区检索（查询串/缓存离线可跑；真实检索限流则 SKIP）
node test/load-client.mjs               # client 半加载 + 渲染 + 交互
node test/validate-typert-contract.mjs  # typert 契约（默认读 E:\dsh\resources\app.asar）

# 也可指定 DSH 安装位置
$env:DSH_APP_ASAR="F:\dsh\resources\app.asar"
node test/validate-typert-contract.mjs
```

契约测试与渲染测试都从**已安装的 DSH（app.asar）里抠真实校验源码**，所以 DSH 升级一改契约，
测试会跟着失败 —— 不是自己写一份宽松的假校验。

社区检索的测试刻意把**查询串构造**与**缓存读取**做成完全离线、可确定复现的断言
（缓存那段会预置一份假数据：如果实现改成打网络，返回的就不是那个假 `total`，断言立刻失败）；
只有「真实检索」和「缓存写入」需要网络，限流时记 SKIP 而不是 FAIL —— 测试不该因为
GitHub 心情不好就红。

---

## 八、安全边界

| 限制 | 值 |
|---|---|
| 归档下载 | 64 MiB（复用 discover.js） |
| 单次超时 | 60 秒 |
| 递归深度 | 6 |
| 插件包数上限 | 100 |
| 打包体积上限 | 32 MiB / 4000 个文件 / 单文件 8 MiB |
| 压缩方式 | 仅 store / deflate（ZIP） |
| 搜索请求超时 | 20 秒 |
| 搜索缓存 | 10 分钟（`~/.dsh/cache/dsh-plugin-url/community/`） |

- 仓库坐标逐段白名单校验；解压拒绝路径穿越（`..`、绝对路径、盘符）与符号链接。
- 打包时**跳过符号链接**（既不跟随，也不入包）。
- 只读**公开仓库**，不读取、不存储、不发送任何 token（社区检索同样不带凭证）。
- 安装本身由官方插件管理器执行，沿用其失败回滚。

### 已知限制

- 未认证的 GitHub API 有速率限制（核心 60 次/小时/IP；**搜索 10 次/分钟**）。
- 无法从 URL 区分"含斜杠的分支名"；下载失败自动回退 `main` / `master`。
- **源码包装不了**：声明了 `prepare` / `postinstall` 之类构建脚本的包需要现场构建 +
  `allowBuilds` 授权，本插件不会替用户授权（面板会标「需要构建」并显示脚本名）。
  这类插件的正确做法是作者把 `lib/` 预构建后随包分发。
- **社区检索的结果不保证是插件**：`topic:dsh-plugin` 下有上万仓库，包含大量误打标签的
  非插件项目。列表只做展示，点开扫过 `dsh.bundle` 才算数。
- 社区检索只能翻到第 10 页（GitHub 搜索 API 自身上限）。
- 安装会重载 profile：面板可能闪一下属正常。
- 私有仓库不支持。

## 许可

MIT
