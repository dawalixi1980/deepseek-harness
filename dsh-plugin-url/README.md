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
dsh plugin --profile <你的 profile> add .\dsh-plugin-url-0.1.0.tgz
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

列表里的标签含义：

| 标签 | 含义 |
|---|---|
| 可直接装 | 无构建脚本、入口文件存在 → 打包即可用 |
| 需要构建 | 声明了 `prepare` / `postinstall` 等 → 需要源码构建，多半会失败（会显示具体脚本名） |
| 缺入口产物 | `main` / `exports` 指向的文件不在包里（典型的"只发 src"） |
| 含界面 | 该插件带 `dsh.client`（Web 半边） |

---

## 四、实现要点

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
test/*.mjs            # 4 个测试
```

### 远程接口（host 半 `pluginUrl` 命名空间）

| 方法 | 参数 | 说明 |
|---|---|---|
| `inspect` | `url` | 解析 + 下载 + 递归发现，返回插件清单（不落盘） |
| `installPlugin` | `url`, `subpath` | 打包并安装（**线名不能叫 `install`**，见下） |
| `uninstallPlugin` | `name` | 卸载 |
| `listInstalled` | — | 已装的可管理插件（含来源仓库） |
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
node test/load-client.mjs               # client 半加载 + 渲染
node test/validate-typert-contract.mjs  # typert 契约（默认读 E:\dsh\resources\app.asar）

# 也可指定 DSH 安装位置
$env:DSH_APP_ASAR="F:\dsh\resources\app.asar"
node test/validate-typert-contract.mjs
```

契约测试与渲染测试都从**已安装的 DSH（app.asar）里抠真实校验源码**，所以 DSH 升级一改契约，
测试会跟着失败 —— 不是自己写一份宽松的假校验。

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

- 仓库坐标逐段白名单校验；解压拒绝路径穿越（`..`、绝对路径、盘符）与符号链接。
- 打包时**跳过符号链接**（既不跟随，也不入包）。
- 只读**公开仓库**，不读取、不存储、不发送任何 token。
- 安装本身由官方插件管理器执行，沿用其失败回滚。

### 已知限制

- 未认证的 GitHub API 有速率限制（60 次/小时/IP）。
- 无法从 URL 区分"含斜杠的分支名"；下载失败自动回退 `main` / `master`。
- **源码包装不了**：声明了 `prepare` / `postinstall` 之类构建脚本的包需要现场构建 +
  `allowBuilds` 授权，本插件不会替用户授权（面板会标「需要构建」并显示脚本名）。
  这类插件的正确做法是作者把 `lib/` 预构建后随包分发。
- 安装会重载 profile：面板可能闪一下属正常。
- 私有仓库不支持。

## 许可

MIT
