---
name: lexiang-blocks
description: "乐享知识库已有页面的内容编辑与排版操作。【核心特征：用户提供了 lexiangla.com/pages/ 链接，并要求对该页面进行修改/编辑/追加/删除/移动操作】。当用户提到「乐享」「知识库」「lexiang」并明确指向已有页面做内容变更时使用。典型触发：「修改这个页面」「编辑一下这篇文档」「在页面里加个标题」「更新一下内容」「调整排版」「追加一段内容」「帮我改一下这个表格」「在这个页面后面插入…」「把这段移到前面」「删掉这个段落」「给这个页面加一段总结」「在 /pages/xxx 里创建标题」。【注意】：仅当操作目标是「已有页面」时才触发本 skill；创建全新文档请使用 lexiang-writer；仅浏览/搜索/阅读请使用 lexiang-search。支持 Block 级别的创建、更新、删除、移动、批量编辑，Markdown/HTML 转 Block 结构插入。"
---

# 乐享 Block 操作

> **前置条件**：本 skill 需要已配置乐享 MCP 连接。如未配置，请先使用 `lexiang-setup` skill。
> **遇到 401 错误**：不要重试，切换到 `lexiang-setup` skill 引导用户续期（点击续期按钮即可恢复，无需重新配置）。
> **安全规则**：Block 写入操作必须基于用户明确提供的目标信息，禁止 Agent 自行遍历或猜测写入目标。

---

## 工具概览

### 🧩 Block 操作
- `block_convert_content_to_blocks` — Markdown/HTML 转 Block 结构
- `block_create_block_descendant` — 创建 Block 结构
- `block_update_block` — 单块更新
- `block_update_blocks` — 批量更新
- `block_move_blocks` — 移动 Block
- `block_delete_block_children` — 删除子节点
- `block_delete_block` — 删除指定 Block（含子孙）
- `block_describe_block` — 获取单个 Block 详情
- `block_list_block_children` — 读取 Block 内容

---

## Block 结构核心规则

### 🍃 叶子节点（不能有 children）
- 标题块：h1, h2, h3, h4, h5
- 代码块：code
- 图片块：image
- 分割线：divider
- 图表块：mermaid, plantuml

### 📦 容器节点（必须指定 children）
- 提示框：callout
- 表格：table, table_cell
- 分栏布局：column_list, column
- 折叠块：toggle

> **详细说明**：完整 Block 类型和字段定义见 `references/block-schema.md`。

---

## ⚠️ 核心注意事项

1. **Block ID 映射**：`block_id` 为客户端临时 ID，服务端返回实际 ID 映射
2. **叶子节点限制**：标题、代码块、图片等不支持 children 字段
3. **容器节点要求**：callout、table、column_list 等必须指定 children
4. **`_mcp_fields` 优化**：所有工具支持 `_mcp_fields` 参数选择返回字段，减少 token 消耗
5. 参数不确定时以 `get_tool_schema(tool_name="xxx")` 返回为准

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

## 参考文档

| 文档                    | 说明                   |
| ----------------------- | ---------------------- |
| `references/block-schema.md`       | Block 类型完整说明     |
| `references/mcp-examples.md`       | 复杂 Block 结构示例    |
| `references/markdown-to-block.md`  | Markdown 转 Block 指南 |
| `references/block-update.md`       | 批量更新 Block 方法    |
| `references/content-reorganize.md` | 文档结构重组           |

---

## 辅助资源

| 资源 | 说明 |
|------|------|
| `assets/lexiang-block-schema.json` | Block Schema JSON 定义 |
| `assets/examples/create-compare-table.json` | 对比表格示例 |
| `assets/examples/create-tech-doc.json` | 技术文档示例 |
| `assets/themes/default.json` | 默认主题配置 |
