# dsh-skill-url

DeepSeek Harness 插件：**粘贴一个网址 → 自动找出仓库里所有技能 → 逐个安装 / 卸载。**

图形面板在 **设置 → 从网址装技能**。支持仓库首页、任意子目录、`blob` / `raw` 链接、`skills.sh`、裸写 `owner/repo`，会**递归**扫出全部 `SKILL.md`。

> 本包已随仓库分发**预构建的 `lib/`**（host 半 + 手写 client bundle）+ 可直接激活的 bundle 补丁层，**不含任何 build / prepare 脚本**。
> 使用者 clone 下来即可用，不需要编译。

---

## 一、给使用者：5 分钟装好

### 前置

- 已安装 DeepSeek Harness 桌面版（或 `dsh` CLI）。下面以 Windows 桌面版 **desktop** profile 为例；Web 版把 `desktop` 换成 `web`。
- Node / pnpm 由 DSH 自带运行时提供，无需自己装。

### 步骤 1：把插件放进 profile

**方式 A（推荐，实测开箱即用）：tarball**

```powershell
# 1) 取到插件
git clone https://github.com/dawalixi1980/deepseek-harness.git
cd deepseek-harness\dsh-skill-url

# 2) 打包（本包无 prepare 脚本，直接 pack 即可）
pnpm pack
#   → 得到 dsh-skill-url-0.1.0.tgz
```

然后把 tarball 交给 DSH 的插件管理器（GUI 里 **设置 → 内置插件 → 从文件安装**，或 CLI）：

```powershell
dsh plugin --profile desktop add .\dsh-skill-url-0.1.0.tgz
```

**方式 B（本地目录，无 pnpm 时最快）**：手工写 profile 清单

```powershell
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"

# 依赖直接指向 clone 下来的目录（注意用正斜杠）
# 在 $profile\package.json 中：
#   "dependencies": { "dsh-skill-url": "file:<clone 路径>/deepseek-harness/dsh-skill-url" }
#   "dsh": { "profile": { "bundles": [ ..., "dsh-skill-url" ] } }

cd $profile
pnpm install --ignore-scripts
```

> ⚠️ 本插件**没有任何第三方依赖**（`lib/discover.js` 只用 `node:` 内置模块，host 半只用 DSH 自带的 `zod` 与 `@deepseek-ai/dsh-typert-protocol`），所以两种方式都不会踩「依赖没被递归安装」的坑。

### 步骤 2：重启 DSH（**必须**）

```powershell
# 桌面版：托盘图标右键 → 退出，然后重新打开
#   ⚠️ 点窗口右上角的 X 只是缩到托盘，进程不死，插件不会重新加载！
```

这一步是**必须**的，两个原因：
1. host 半的 MANIFEST 在**进程启动时**注册，改完文件不重启不生效；
2. DSH 的 HMR 只监视 profile 的 `package.json` 与 `cordis.patch.yml`，**不监视插件自己的 `lib/`**。

### 步骤 3：验证

打开 **设置 → 从网址装技能**，应当看到标题、网址输入框、「查找技能」按钮、「已保存的仓库网址」一行，以及「本地已安装的技能」。

粘一个仓库试：

```
https://github.com/anthropics/skills
```

点「查找技能」→ 列出 20 个技能 → 点某个技能的「安装」。

装成功后会真的落盘：

| 位置 | 内容 |
|---|---|
| `%USERPROFILE%\.dsh\skills\<技能名>\` | 技能目录（含 `SKILL.md`） |
| `%USERPROFILE%\.dsh\dsh-skill-url.json` | 来源记录 + 已保存的仓库网址 |

---

## 二、功能

- **网址解析**：`github.com/o/r`、`.../tree/ref/sub`、`.../blob/ref/f.md`、`raw.githubusercontent.com/...`、`skills.sh/o/r/skill`、裸 `o/r`；漏写 `https://` 自动补。
- **递归发现**：下载仓库归档，深度 ≤6 找含 `SKILL.md` 的目录；跳过 `node_modules`、点目录、符号链接与路径穿越条目。
- **逐个安装 / 真卸载**：每张卡片单独装/卸；重装即覆盖；目录束删目录，平铺 md 连 `.disabled` 变体一起删。
- **保存仓库网址**（v0.1.0 新增）：
  - 查找成功后**自动记住**该网址；
  - 面板里以胶囊标签列出，点标签**填入输入框**、点 `×` **移除**；
  - 重开面板时**自动把上次用的网址填好**；
  - 归一化成 `https://github.com/owner/repo` 后去重（同一仓库的深链只存一条），最多 12 条。
- **来源标注 + 缓存**：列表显示技能来自哪个仓库；归档缓存 30 分钟。

---

## 三、开发过程中踩的全部坑（重点）

这个插件从"装上就报错"到"能用"，一共踩了 **6 个**独立的坑。前 5 个都是 **DSH 插件 API 契约**问题（不是插件逻辑问题），第 6 个是环境/加载机制问题。**写 DSH 插件的人建议全部读一遍**——每一条都能让你的插件白屏或激活失败。

### 坑 1：ESM 暂时性死区（TDZ）→ 整个 Web 端起不来

```js
const CONTRIBUTION = { ... codec(...) ... };   // 模块求值期就调用 codec()
const identity = (v) => v;                     // ← 声明在后面
function codec(t) { return { ..., create: () => ({ parse: identity }) }; }
```

**报错**：

```
web boot: 1 entry did not activate
dsh-skill-url: import failed: Cannot access 'identity' before initialization
```

`node --check` **查不出来**（语法完全合法），因为这是**求值顺序**错误。

**修**：把 `identity` / `codec` 声明挪到 `CONTRIBUTION` **之前**。

### 坑 2：typert codec 形状过期 → 插件项激活失败

**报错**：

```
typert: dsh-skill-url#skillUrl/inspect result strict codec has no create() factory
```

DSH 的 typert 注册表只认这一种形状（生成器产出的也是它）：

```js
// ✅ 正确：create 是「返回 zod schema 的工厂」
{ mode: "strict", typeSymbol: "...", create: () => z.object({ ... }) }
// ❌ 错误（曾经的写法）
{ mode: "strict", typeSymbol: "...", schema: z.object({ ... }) }
```

运行期按 `codec.create().parse(value)` 解析线格式；loader 侧 `requireStrictCodec` 同样要求 `create`。

**修**：`const codec = (typeSymbol, schema) => ({ mode: "strict", typeSymbol, create: () => schema })`。

### 坑 3：slot 组件读错 props → 设置页**一片空白**

DSH 的 slot 宿主把 `inject()` 的返回值**摊平成 props**（内置组件就是这么写的）：

```js
// DSH 内置写法
function AgentPresetSection({ load, view, makeDefault, t }) { ... }
```

全 app.asar 里 `props.face` **命中 0 次**。而我们的组件写的是 `const face = props.face;` → `undefined` → 挂载 effect 里 `face.listInstalled()` 抛 `TypeError` → **React 把整个 slot 渲染成空白**。

DSH 官方文档原话：

> *a throwing component blanks your slot entry*（console 里会打 `slot entry crashed in '<slot>'`）

**修**：`const face = props.face ?? props;`（两种形态都兼容）。

### 坑 4：挂载期的同步调用没有护栏 → 仍然白屏

即使 props 读对了，`useEffect` 里一个**同步**抛错照样把 slot 打成空白。典型来源：`ctx.get("sessions").currentProvideInfo...` 在设置弹窗里可能还不存在。

**修**：

```js
const refreshLocal = react.useCallback(() => {
  try {
    if (typeof face?.listInstalled !== "function") { setError("skillUrl 服务不可用…"); setLocal([]); return; }
    Promise.resolve(face.listInstalled()).then(...).catch(...);
  } catch (err) { setError(String(err?.message ?? err)); setLocal([]); }
}, [face, t]);
```

外加一个**探针**：注入缺失时渲染一行红字而不是白屏。这样"空白"这个现象本身就能自证是旧模块没换。

### 坑 5：远程方法名撞上客户端的 namespace service → 挂载即失败

**报错**：

```
client api: method "skillUrl/install" conflicts with its namespace service
```

DSH 客户端 `RemoteNamespaceService` 的原型上**已经有 `install()`**（`installDirect` / `installScoped` 都调它），端点不能同名。判定代码：

```js
static assertMethodAvailable(namespace, method) {
  if (REMOTE_NAMESPACE_FIELDS.has(method) || method in RemoteNamespaceService.prototype)
    throw new Error(`client api: method ${JSON.stringify(`${namespace}/${method}`)} conflicts with its namespace service`);
}
```

**禁用方法名全集**（`0.1.7-rc.2` 实测）：

```
assertMethodAvailable, constructor, empty, has, install, installDirect,
installScoped, methods, remove, ctx, invokeRemote, name, namespace
```

**修**：远程线名 `install` → **`installSkill`**（面板 API 仍叫 `install`，只改线名）。

### 坑 6：host 换了代码、client 没换 → 安装报 404

**报错**：

```
skillUrl/installSkill failed: transport failure for /api/skillUrl/installSkill: HTTP 404
```

**原因**：

| 半边 | 加载方式 | 改了文件后 |
|---|---|---|
| client bundle | 每次请求**现从磁盘读** | 立刻换 rev，页面刷新即生效 |
| host 半 | 进程内 **ESM import，只在启动时一次** | **必须重启 DSH 进程** |

而 DSH 的 HMR 只监视 profile 的 `package.json` 与 `cordis.patch.yml`，**不监视插件自己的 `lib/`**。所以出现"客户端在调新端点、host 只认旧端点"的错位 → 404。

**修**：重启 DSH。**桌面版点 X 只是缩进托盘、进程不死**——必须"托盘右键 → 退出"或任务管理器结束 `DeepSeek Harness` 进程。

---

## 四、排障速查

| 现象 | 原因 | 处理 |
|---|---|---|
| 应用报「无法启动或已意外停止 / 1 entry did not activate」 | host 或 client 半加载期抛错 | 跑两个测试；启动对话框里点「禁用第三方插件、备份 profile patch 并重启」自救 |
| 设置里点「从网址装技能」**一片空白** | 组件抛错（坑 3 / 4） | 刷新页面；仍白屏说明还是旧 bundle → 重启 DSH |
| 面板有内容但一行**红字** | 已修版在跑，具体原因看红字 | 按红字内容对照上面 6 个坑 |
| 点「安装」报 **404** | host 进程没重启（坑 6） | 托盘右键退出 → 重开 |
| 报 `conflicts with its namespace service` | 端点名撞了（坑 5） | 换线名（避开禁用名单） |
| 报 `strict codec has no create() factory` | codec 形状过期（坑 2） | 用 `create: () => schema` |
| 找不到「从网址装技能」这一项 | bundle 没进 profile 或没重启 | 检查 profile `package.json` 的 `dsh.profile.bundles` 里有 `dsh-skill-url`，然后重启 |

### 自助回滚

```powershell
# 桌面版启动异常时，手工摘掉插件
cd "$env:USERPROFILE\.dsh\profiles\desktop"
Copy-Item package.json.bak-before-skillurl package.json -Force
# 然后重启 DSH
```

---

## 五、测试

本包带两个回归测试，**都从已安装的 DSH（`app.asar`）里抠出真实校验代码**，所以 DSH 升级后契约一变，测试会跟着失败——不是"自己写一份宽松的假校验"。

```powershell
cd dsh-skill-url

# 1) typert 契约：codec 形状 + 远程方法名禁用名单（host & client 两半）
node test/validate-typert-contract.mjs

# 2) client 半加载与首屏渲染：**真实执行挂载 effect**
#    （能捕获 node --check 查不出的 TDZ 与挂载期抛错）
node test/load-client.mjs

# 也可以指定 DSH 安装位置与已安装副本做交叉验证
$env:DSH_APP_ASAR="F:\dsh\resources\app.asar"
node test/validate-typert-contract.mjs
node test/load-client.mjs "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-skill-url\lib\client.js"
```

当前状态：契约测试 **14 项 PASS**，渲染测试 **16 项 PASS**。

两个测试都带**负向对照**思路：把代码改回出事故的写法，测试必须失败（已验证能精确复现 `Cannot read properties of undefined (reading 'listInstalled')` 与 `strict codec has no create() factory`）。

---

## 六、安全边界

| 限制 | 值 |
|---|---|
| 归档下载 | 64 MiB |
| 单次超时 | 60 秒 |
| 递归深度 | 6 |
| 技能数上限 | 300 |
| 单个 SKILL.md | 512 KiB |
| 归档条目 | 20000 |
| 压缩方式 | 仅 store / deflate |

- 仓库坐标（owner/repo/ref/subpath）逐段白名单校验，防 URL 改写。
- 解压拒绝路径穿越（`..`、绝对路径、盘符）与符号链接。
- 只读**公开仓库**，不读取、不存储、不发送任何 token。
- 安装是原子的：先解压到暂存目录校验，再改名就位；失败不留残骸。

### 已知限制

- 未认证的 GitHub API 有速率限制（60 次/小时/IP）。
- 无法从 URL 区分"含斜杠的分支名"；下载失败自动回退 `main` / `master`。
- 不递归扫描远程来源（与官方 filesystem provider 行为一致）。
- 私有仓库不支持。

---

## 七、文件结构

```
package.json          # dsh.bundle + dsh.client 清单（无构建脚本）
cordis.patch.yml      # bundle 补丁层：向 profile 插入 skill-url 行
lib/index.js          # host 半：skillUrl 远程服务（typert MANIFEST）
lib/client.js         # client 半：设置页分区（手写 bundle）
lib/discover.js       # URL 解析 / 归档下载 / ZIP 解压 / frontmatter / 递归扫描（零依赖）
test/validate-typert-contract.mjs   # 契约测试（从 app.asar 抠真实校验源码）
test/load-client.mjs                # client 半加载 + 首屏渲染测试
README.md / LICENSE / .gitignore
```

### 远程接口（host 半 `skillUrl` 命名空间）

| 方法 | 参数 | 说明 |
|---|---|---|
| `inspect` | `url` | 解析 + 下载 + 递归发现，返回技能清单（不落盘） |
| `installSkill` | `url`, `subpath` | 装到 `<dsh home>/skills/<name>/`（**线名不能叫 `install`**，见坑 5） |
| `uninstall` | `name` | 目录束删目录；平铺 md 连 `.disabled` 变体一起删 |
| `listInstalled` | — | 已装技能列表（含来源仓库） |
| `rememberUrl` | `url` | 保存仓库网址（归一化 + 去重，最多 12 条） |
| `recentUrls` | — | 已保存网址列表（最近优先） |
| `forgetUrl` | `url` | 删除一条已保存网址 |

---

## 许可

MIT
