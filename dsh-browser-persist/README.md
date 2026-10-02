# dsh-browser-persist

> **一句话**：DSH 侧栏浏览器（书签点开的那个标签页）**每次重启都要重新登录**，
> 因为官方把它建成了随机命名的临时会话。本插件把官方 `app.asar` 里的**一行代码**改掉，
> 让它变成持久会话；并且做成可重复执行的开关——**DSH 升级会冲掉这个改动，回来点一下就行**。

---

## 改了官方的什么（精确到行）

**文件**：`<DSH 安装目录>/resources/app.asar` → 归档内 `lib/main.js`
**位置**：`class DesktopBrowserGuests` → `acquire(owner, workspace)` 方法内

**改动前（官方原样）**：

```js
partition = `dsh-sidebar-browser-${randomUUID()}`;
```

**改动后**：

```js
partition = `persist:dsh-sidebar-browser-${createHash('sha256').update(workspace).digest('hex').slice(0, 32)}`;
```

**就这一行。** 改动只做两件事：

| | 改动前 | 改动后 | 为什么 |
|---|---|---|---|
| 1 | 无前缀 | 加 `persist:` | Electron 里无前缀 = 内存会话，进程退出即丢；有前缀 = 落盘会话 |
| 2 | `randomUUID()` | `createHash('sha256').update(workspace)` | 随机名意味着**每次启动都是另一个存储目录**，存下来的登录态对不上号；改成由工作区派生的确定性值，同一工作区重启后命中同一分区 |

**只做第 1 步是无效的**——名字每次随机，即使落盘也找不回来。两步必须同时做。

`createHash` 在 `main.js` 第 8 行**官方已经导入**，不需要额外引入任何东西。

### 官方自己就是这么写的

同一个文件第 6018 行，官方给平台登录态用的正是这套写法：

```js
const partition = account.userId === null
  ? `dsh-platform-${randomUUID()}`
  : `persist:dsh-platform-${createHash("sha256").update(JSON.stringify([account.origin, account.userId])).digest("hex")}`;
```

所以这不是能力缺失。至于侧栏浏览器**是不是有意**不这么做（侧栏能打开任意网址，
持久化意味着那些网站的 cookie 也会留在磁盘上），代码里无从判断——
官方注释写的是 "process-lifetime partition"，这个措辞读起来像是想过才写的。

---

## 一次性手工改法（不用插件）

如果你只想改一次、不装插件：

1. 备份 `<DSH>/resources/app.asar`
2. 用任意 asar 工具（或十六进制编辑器）取出 `lib/main.js`
3. 把上面那行替换掉
4. 写回归档，**重启 DSH**

难点在于**第 4 步**：asar 归档里每个文件都带 SHA256 完整性哈希，
手改会让哈希对不上。本插件的 `lib/asar.js` 就是干这个的——把新内容追加到归档末尾、
只更新那一个条目的 size/offset/hash，**其它文件的字节一个都不动**。

---

## DSH 升级之后怎么办

**升级会整体替换 `app.asar`，这个改动必然消失，而且没有任何提示** ——
你会突然又开始被要求重新登录却不知道为什么。

所以插件存在的意义就是把"重打"变成一个按钮：

```
发现又开始要重新登录
  -> 设置 → 浏览器登录态
  -> 看状态是不是变回「未启用（官方原样）」
  -> 点「启用」-> 点「重启 DSH 生效」
```

也可以不开插件，照上面「一次性手工改法」再来一遍。

---


让 DSH 侧栏浏览器**记住登录状态**，并且把"改官方安装文件"这件事做成**可重复执行**的开关。

## 它解决什么问题

在 DSH 侧栏里打开的网页（典型场景：从「书签」点开乐享知识库）**每次重启 DSH 都要重新登录**。

根因在官方 `app.asar/lib/main.js` 的 `DesktopBrowserGuests.acquire()`：

```js
partition = `dsh-sidebar-browser-${randomUUID()}`;
```

两个问题叠在一起：

1. **没有 `persist:` 前缀** —— Electron 用进程内会话，进程一退 cookie 全丢；
2. **名字来自 `randomUUID()`** —— 即使补上前缀，每次启动也是另一个存储目录，存下来的登录态对不上号。

只做第 1 步是没用的，必须同时把名字换成**由工作区派生的确定性值**。官方自己在同一个文件里就有正确写法（平台分区）：

```js
`persist:dsh-platform-${createHash("sha256").update(JSON.stringify([...])).digest(...)}`
```

所以这不是能力缺失，而是侧栏浏览器没这么做。本插件把这个差异补上：

```js
partition = `persist:dsh-sidebar-browser-${createHash('sha256').update(workspace).digest('hex').slice(0, 32)}`;
```

`createHash` 在 `main.js` 顶部已经导入，不需要额外引入任何东西。

## 为什么做成插件而不是手工改一次

**DSH 升级会整体替换 `app.asar`，手改的那一行必然消失**，而且没有任何提示 ——
你会突然又开始被要求重新登录，却不知道为什么。

本插件把"重新打补丁"变成一个按钮：升级之后回到设置页，再点一次「启用」即可。

## 用法

设置 → **浏览器登录态**：

| 按钮 | 作用 |
|---|---|
| 启用 | 打补丁（升级后重新点这个） |
| 恢复官方 | 撤销补丁，回到官方行为 |
| 重新检查 | 重新读取当前状态 |
| 重启 DSH 生效 | 重启应用让改动生效 |

改动写完后**必须重启 DSH**，因为 `main.js` 在主进程启动时就被加载了。

## 它是怎么改的（安全边界）

`app.asar` 是 Electron 归档，在 DSH 进程里被 asar 补丁伪装成目录，但用普通 node 打开就是一个
121 MB 的文件，且**每个条目都带 SHA256 完整性哈希**。

改法选择了风险最小的路径：

1. 把新内容**追加到归档末尾**（旧内容成为不再被引用的死区）；
2. 只改头部里**这一个条目**的 `size` / `offset` / `hash`；
3. 靠数字位数不变（hash 64 位、size 6 位、offset 9 位）保证**头部 JSON 长度不变**，
   于是 `dataOffset` 不变、**其它所有文件的 offset 全部保持有效**；
4. **回退时原地复用**（新内容更短），归档不增长，反复开关不会把文件越滚越大。

结果：归档只增长"新增内容的字节数"，**其它所有文件的原字节一个都没动**（有测试逐字节对比）。

每一步都有断言，条件不满足就**拒绝动手**：

- 目标表达式必须**恰好出现一次**（0 处或 2 处都拒绝，绝不猜）；
- 改之前核对内容哈希与头部记录一致（防止认错文件）；
- 新旧位数必须相同；
- 改完立即复验，失败即报错。

首次改动会生成 `app.asar.dsh-browser-persist.bak` 备份。

## 环境要求

- **DSH 桌面版**（需要有 Electron 的 `original-fs` 来绕过 asar 补丁读写归档）。
  从源码跑 `dsh web` 时 `app.asar` 本来就是普通目录，插件会走解包目录分支。
- 自动重启只在桌面版可用；其它情况请手动重启。

## 开发

```bash
node test/patch.test.mjs
```

测试全部使用自造的 asar 夹具（覆盖归档布局、偏移语义、哈希一致性、原地复用、幂等、
各种拒绝条件），**不写入真实安装目录**；最后只对真实 `app.asar` 做一次只读状态检查。
