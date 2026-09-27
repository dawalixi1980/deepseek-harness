# dsh-lexiang — 乐享知识库面板

> 在 DSH 设置里给 **乐享（Lexiang）知识库**一个完整的前端界面：浏览知识库与目录树、读正文、搜索、上传文件、新建 / 重命名 / 删除条目。
> **凭证由使用者自己在界面上填写**，保存在本机 `~/.dsh/dsh-lexiang.json`，不进仓库、不上传。

## 为什么需要它

乐享官方提供的是 **MCP 工具**（78 个），但没有图形界面 —— 每次操作都要用对话驱动。本插件把它做成**可视化的知识库管理器**。

| 能力 | 纯 MCP（对话驱动） | **本插件（图形界面）** |
|---|---|---|
| 看知识库里有什么 | 要问一句、等一段 | ✅ 下拉选库 + 目录树点开 |
| 读条目正文 | 要问一句 | ✅ 点一下右侧就渲染 |
| 搜索 | 要问一句 | ✅ 输入框 + 关键词/语义切换 |
| 上传文件 | 要问一句 | ✅ 选文件即传 |
| 编辑 / 删除 | 要问一句 | ✅ 按钮操作 |
| 多人使用 | 每人自己配 MCP | ✅ **各自填自己的凭证** |

## 安装

### 方式 A：本地目录（开发/自用）

```powershell
# 1) 放进 profile 的 node_modules
$dst = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-lexiang"
New-Item -ItemType Directory -Path $dst -Force | Out-Null
Copy-Item .\dsh-lexiang\* $dst -Recurse -Force

# 2) 在 profile 的 package.json 里注册
#    dependencies 加： "dsh-lexiang": "file:<本仓库路径>/dsh-lexiang"
#    dsh.profile.bundles 加： "dsh-lexiang"
```

### 方式 B：从 git 安装

```bash
dsh plugin --profile desktop add github:dawalixi1980/deepseek-harness#dsh-lexiang
```

> 安装后需要**真正重启 DSH**（桌面版点 X 只是缩进托盘，进程不死）。

## 配置凭证（首次必做）

插件**不附带任何凭证**。首次打开设置面板会看到「未配置」：

| 字段 | 说明 | 从哪拿 |
|---|---|---|
| **COMPANY_FROM** | 企业标识（32 位十六进制） | https://lexiangla.com/mcp |
| **LEXIANG_TOKEN** | 访问令牌（`lxmcp_` 开头） | 同上，登录后生成 |
| **MCP 端点** | 留空即用默认 `https://mcp.lexiang-app.com/mcp` | — |

点「保存」后凭证写入 `~/.dsh/dsh-lexiang.json`（权限 0600），**刷新页面 / 重启 DSH 都还在**。

- 多个使用者**各填各的**即可，互不影响。
- Token 回显只显示掩码（如 `lxmcp…8fc2 (70 位)`），**界面和远程调用都不会回传明文**。
- Token 过期（401）时，界面会提示去 `https://lexiangla.com/mcp` 点「续期」——**不需要重新获取 token**。

## 界面

```
┌─ 凭证配置 ────────────────────────────────────┐
│ COMPANY_FROM [__________]  LEXIANG_TOKEN [••••]│
│ MCP 端点 [________________]                    │
│ [保存] [测试连接] [清除凭证]                    │
└───────────────────────────────────────────────┘
┌─ 浏览 ────────────────────────────────────────┐
│ 知识库 [下拉 ▾] [刷新]  [新建页面][新建文件夹][上传文件]│
├──────────────────┬────────────────────────────┤
│ 📁 投标大师知识库  │  条目名                     │
│ 📄 模板参考1      │  [page] [docx] [时间] [id]  │
│ 📁 案例           │  ─────────────────────      │
│                  │  正文内容（Markdown）        │
│                  │  [重命名] [删除]             │
└──────────────────┴────────────────────────────┘
┌─ 搜索 ────────────────────────────────────────┐
│ [关键词________] ○关键词 ●语义  [搜索]          │
│ · 标题  [pdf] score 9.41                       │
│   正文片段…                                    │
└───────────────────────────────────────────────┘
```

## 技术要点

### 数据链路

```
client (浏览器)                host (进程内 ESM)            乐享
  LexiangSection  ──remote──▶  LexiangService  ──HTTP──▶  mcp.lexiang-app.com
       │                            │                        (JSON-RPC over SSE)
       │                       ~/.dsh/dsh-lexiang.json
       └── ctx.slots.register("settings.section")
```

**host 端直连乐享 MCP**，不依赖用户在 DSH 里另配 MCP 服务器 —— 插件自己管凭证，这样"前端填一次就能用"才成立。

### 乐享 MCP 的调用约定（实测踩出来的）

1. **meta 工具直接调**（`list_tool_categories` / `search_tools` / `get_tool_schema`），**不能走 `call_tool`**
2. **业务工具必须走 `call_tool`**：`{name:"call_tool", arguments:{tool_name, arguments}}`
3. 响应是 **SSE**（`data:` 行），不是纯 JSON
4. `search_kb_embedding_search` 的参数是 **`filters.keyword`**，不是顶层 `query`
5. `entry_set_entry_validity` 用 **`validity_type`**（`force_expire` = 删除）
6. `space_list_spaces` **必须传 `team_id`**（先用 `team_list_teams` 拿）
7. 文件上传是 **三步**：`file_apply_upload` → **HTTP PUT**（非 MCP 调用）→ `file_commit_upload`

### 复用 DSH 插件开发的 7 个坑

本插件在实现时把 `dsh-skill-url` 记录的 7 个坑全部规避了，测试里也有对应回归：

| # | 坑 | 本插件的处理 |
|---|---|---|
| 1 | ESM TDZ（codec 引用未初始化） | `identity`/`codec` 声明在 `CONTRIBUTION` **之前** |
| 2 | strict codec 缺 `create()` | 所有 codec 都带 `create: () => ({parse})`，测试校验 |
| 3 | slot props 被摊平，没有 `props.face` | 用 `props.face ?? props` |
| 4 | 挂载期同步远程调用抛错 → 空白面板 | 全程 `try/catch` + 红字诊断 |
| 5 | 远程线名撞保留名 | 避开 `install`/`remove`/`has` 等 13 个保留名 |
| 6 | host/client 版本错位 → 404 | 改名后**真正重启** DSH |
| 7 | `jsx()` 第三参数是 key，不是 children | 文字一律写 `children:`，测试含**空胶囊回归** |

## 测试

```bash
node test/lexiang-api.test.mjs   # 20 项：传输层（端点拼装/SSE 解码/鉴权/错误映射）
node test/host.test.mjs          # 32 项：凭证存储 + 15 个业务方法 + 三步上传 + MANIFEST 契约
node test/load-client.mjs        # 19 项：真实执行 client bundle，含渲染与空胶囊回归
```

**共 71 项，全部离线可跑**（不需要网络、不需要凭证）。

几个值得说的断言：

- **`props.face` 不存在时也能工作** —— 忠实模拟 DSH 的 props 摊平行为。
- **空胶囊回归**：把所有 button/option 收集起来，断言每个都有可见文本。**已用负向对照验证**：把 `children: t("save")` 改成 `jsx(..., t("save"))` 后测试立刻失败并给出准确诊断。
- **MANIFEST 契约**：invocation 与 schema 一一对应、每个 codec 都有 `create()`、线名不撞保留名。

## 已验证（对真实乐享 API）

| 操作 | 结果 |
|---|---|
| `testConnection` | ✅ `HerbertCamus @ HerbertCamus的组织` |
| `listTeams` | ✅ 示例团队 |
| `describeSpace`（个人库） | ✅ root_entry_id 解析正确 |
| `listChildren` | ✅ 目录树正常 |
| `search`（关键词） | ✅ 31 命中，返回**正文片段** |
| `search`（语义） | ✅ 返回相似度 score |
| `listSpaces` | ✅ 团队知识库 |

> 注：真实凭证只用于**本机验证**，从未写入仓库或测试文件。

## 文件结构

```
dsh-lexiang/
├── package.json          # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml      # bundle 补丁层（insert 一条）
├── lib/
│   ├── index.js          # host 半：Typert 远程服务（15 个方法）
│   ├── lexiang-api.js    # 传输层：MCP JSON-RPC over SSE + 错误映射
│   ├── store.js          # 凭证存储（~/.dsh/dsh-lexiang.json，0600）
│   └── client.js         # client 半：手写 bundle（面板 UI）
└── test/
    ├── lexiang-api.test.mjs
    ├── host.test.mjs
    └── load-client.mjs
```

## 许可

MIT
