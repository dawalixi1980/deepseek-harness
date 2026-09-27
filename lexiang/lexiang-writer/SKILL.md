---
name: lexiang-writer
description: "乐享知识库文档创建与写入。当用户提到「乐享」「知识库」「lexiang」并包含创建/写入/新建/导入意图时使用。典型触发：「写到乐享」「创建一个文档」「帮我新建一个页面」「把这段内容发到乐享」「保存到知识库」「导入到乐享」「帮我在 XX 知识库下建个文档」「把这篇文章存到乐享」。也适用于用户提供 lexiangla.com 链接并要求写入新内容、导入公众号文章到知识库的场景。支持 Markdown/HTML 导入创建文档、创建页面与文件夹、外部链接导入。注意：上传 PDF/Word/图片等文件请使用 lexiang-files。"
---

# 乐享文档写入

> **前置条件**：本 skill 需要已配置乐享 MCP 连接。如未配置，请先使用 `lexiang-setup` skill。
> **遇到 401 错误**：不要重试，切换到 `lexiang-setup` skill 引导用户续期（点击续期按钮即可恢复，无需重新配置）。
> **安全规则**：
> 1. **禁止**遍历团队/知识库列表后自行选择写入目标
> 2. **禁止**根据名称"看起来合适"就决定写入
> 3. 必须满足以下条件之一才可写入：用户提供了明确 URL、用户提供了明确 ID、用户指定名称且 Agent 回显后用户确认、用户说"保存到知识库"且 `whoami` 返回了个人知识库
> 4. **例外**：用户未指定目标但 `whoami` 返回了个人知识库时，可自动写入个人知识库（见下方规则）

---

## 工具概览

### 📚 知识库管理
- `entry_create_entry` — 创建文档/文件夹
- `entry_import_content` — 导入 Markdown/HTML 创建新文档（⚠️ 仅新建）
- `entry_import_content_to_entry` — 导入内容到已有页面（支持覆盖/追加）
- `entry_rename_entry` — 重命名条目

### 👤 用户与身份
- `whoami` — 获取当前用户信息（包括用户姓名、企业信息、个人知识库等）

### 🔗 外部内容导入
- `file_create_hyperlink` — 导入公众号文章等外部链接

---

## 常见操作流程

### ⚠️ 前置检查：确认产品版本

**每次执行写入操作前**，先调用 `whoami()` 检查 `sub_server_type`：
- `v2` → 继续使用本 skill
- `v1` → **停止，提示用户加载 `lexiang-v1-docs` skill**（本 skill 不适用于 v1）
- `v1v2` → 如果用户明确说了「乐享社区」→ 提示切换 `lexiang-v1-docs`；否则继续使用本 skill

### 从知识库链接写入文档

> ⚠️ 仅在用户**主动提供了知识库链接**时执行。

核心步骤：提取 `space_id` → `space_describe_space` 获取 `root_entry_id` → `entry_import_content` 写入 → 按「结果链接生成」规则拼接访问链接返回给用户。

> `{domain}` 为 `whoami()` 返回的 `company.company_domain`。

### 未指定知识库时写入个人知识库

当用户要求保存内容到知识库或个人知识库，但**未指定具体目标知识库**时：

1. **调用 `whoami()`** 获取当前用户信息
2. **检查返回结果中是否包含个人知识库信息**（如 `personal_space_id` 等字段）
3. **如果存在个人知识库**：
   - 使用 `space_describe_space` 获取个人知识库的 `root_entry_id`
   - 使用 `entry_import_content` 写入内容（`space_id` 和 `parent_id` 同时传）
   - 写入完成后按「结果链接生成」规则拼接访问链接返回给用户
4. **如果 `whoami` 返回中不包含个人知识库信息**：
   - 回退到标准写入安全规则，要求用户提供具体的写入目标（URL / ID / 名称）

> **注意**：此规则仅适用于用户明确表达"保存到知识库""保存到个人知识库""存到我的知识库"等意图且未指定具体目标的场景。如果用户指定了具体知识库，仍以用户指定的为准。

### 微信公众号导入

当用户提供 `mp.weixin.qq.com` 链接且意图是"导入/收藏/保存到乐享"时，使用 `file_create_hyperlink`。

> 如果用户只是想阅读或总结内容，不要默认导入。

---

## 🔗 结果链接生成

写入操作成功后，用返回的 `entry_id` 按以下规则拼接访问链接：

**判断 `{domain}` 是否包含三级域名（如 `csig.lexiangla.com`）：**

| 情况 | 链接格式 | 示例 |
|------|----------|------|
| domain 包含三级域名 | `{domain}/pages/{entry_id}` | `https://csig.lexiangla.com/pages/abc` |
| domain 为顶级域名 | `{domain}/pages/{entry_id}?company_from={company_from}` | `https://lexiangla.com/pages/abc?company_from=csig` |

> `{company_from}` 值从 mcp.json 的 `url` 字段中提取（如 `?company_from=csig` 中的 `csig`）。

**禁止**使用 MCP 端点域名拼接用户访问链接。

---

## 常见使用场景

### 场景0: 用户给了知识库链接，写入文档

> 用户："把报告写入乐享，链接是 https://lexiangla.com/spaces/16c4224607ea45ebacce6c15130a4957"

```
Step 1: 从 URL 提取 space_id = "16c4224607ea45ebacce6c15130a4957"
Step 2: call_tool("space_describe_space", {"space_id": "..."}) → 获取 root_entry_id
Step 3: call_tool("entry_import_content", {"space_id": "...", "parent_id": root_entry_id, "name": "报告", "content": "...", "content_type": "markdown"})
Step 4: 从返回结果取 entry_id，向用户展示访问链接：{domain}/pages/{entry_id}
```

> **要点**：`space_id` 和 `parent_id` 要同时传；`parent_id` 用 `root_entry_id` 表示写入根目录；链接中 `{domain}` 见上方 URL 规则定义。

### 场景1: 创建文档

```
call_tool("entry_create_entry", {"name": "技术文档", "parent_entry_id": "abc123", "entry_type": "page"})
```

### 场景2: 导入 Markdown

```
call_tool("entry_import_content", {"parent_id": "folder123", "name": "技术文档", "content": "...", "content_type": "markdown"})
```

### 场景3: 创建结构化 Block 文档

```
call_tool("block_create_block_descendant", {
  "entry_id": "doc123",
  "descendant": [
    {"block_id": "h1", "block_type": "h1", "heading1": {"elements": [{"text_run": {"content": "项目文档"}}]}},
    {"block_id": "tip", "block_type": "callout", "callout": {"color": "#FFF3E0"}, "children": ["tip_p"]},
    {"block_id": "tip_p", "block_type": "p", "text": {"elements": [{"text_run": {"content": "重要提示内容"}}]}},
    {"block_id": "li1", "block_type": "bulleted_list", "bulleted": {"elements": [{"text_run": {"content": "功能一"}}]}}
  ],
  "children": ["h1", "tip", "li1"]
})
```

### 场景4: 上传文件（3 步）

```
Step 1: call_tool("file_apply_upload", {"parent_entry_id": "folder123", "name": "README.md", "size": 1024, "mime_type": "text/markdown", "upload_type": "PRE_SIGNED_URL"})
        → 返回 upload_url, session_id
Step 2: 用 curl 命令执行 HTTP PUT（非 MCP 调用）：
        curl -X PUT -H "Content-Type: text/markdown" --data-binary "@/path/to/README.md" "<upload_url>"
Step 3: call_tool("file_commit_upload", {"session_id": "..."})
```

> ⚠️ Step 2 必须用 `curl -X PUT --data-binary`（不是 `-d`），参见 SKILL.md「文件上传完整流程」。

### 场景5: 读取 Block 内容

```
call_tool("block_list_block_children", {"entry_id": "abc123", "with_descendants": true})
```

### 场景6: 批量更新 Block

```
call_tool("block_update_blocks", {
  "entry_id": "abc123",
  "updates": {
    "actual_block_id": {
      "update_text_elements": {
        "elements": [{"text_run": {"content": "更新后的内容"}}]
      }
    }
  }
})
```

---

## ⚠️ 核心注意事项

1. `entry_import_content` 的 `parent_id` 通常用 `root_entry_id`（通过 `space_describe_space` 获取）
2. `space_id` 和 `parent_id` 要同时传
3. 支持的 `content_type`：`markdown`、`html`
4. 参数不确定时以 `get_tool_schema(tool_name="xxx")` 返回为准

---

## 参考文档

| 文档 | 说明 |
|------|------|
| `references/markdown-import.md` | Markdown 导入详解 |
| `references/doc-templates.md` | 文档模板 |
| `references/common-errors.md` | 常见错误排查 |
