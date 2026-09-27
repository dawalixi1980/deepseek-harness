---
name: lexiang-search
description: "乐享知识库搜索与内容阅读。当用户提到「乐享」「知识库」「lexiang」并包含搜索/查找/阅读意图时使用。典型触发：「帮我找一下…」「搜索一下…」「查一下有没有…」「看看这个知识库里有什么」「找找关于 XX 的文档」「读一下这个页面」「打开这个链接」。也适用于用户提供 lexiangla.com 链接、/pages/、/spaces/ 路径需要读取内容的场景。支持关键词搜索、语义搜索、知识库浏览、目录结构导航、文档内容读取与解析。"
---

# 乐享搜索与浏览

> **前置条件**：本 skill 需要已配置乐享 MCP 连接。如未配置，请先使用 `lexiang-setup` skill。
> **遇到 401 错误**：不要重试，切换到 `lexiang-setup` skill 引导用户续期（点击续期按钮即可恢复，无需重新配置）。

---

## 工具概览

### 🔍 搜索与发现
- `search_kb_search` — 关键词搜索
- `search_kb_embedding_search` — 语义向量搜索
- `team_list_teams` — 获取团队列表
- `team_describe_team` — 获取团队详情
- `team_list_frequent_teams` — 获取常用团队列表
- `space_list_spaces` — 获取知识库列表
- `space_describe_space` — 获取知识库详情（返回 `root_entry_id`）
- `space_list_recently_spaces` — 获取最近访问知识库

### 📖 条目与结构浏览
- `entry_list_children` — 浏览目录结构
- `entry_describe_entry` — 获取条目元信息（不含正文）
- `entry_describe_ai_parse_content` — 获取 AI 解析内容（含正文）
- `entry_list_parents` — 获取父级路径（面包屑）
- `entry_list_latest_entries` — 获取最近更新条目

---

## 内容搜索

### 关键词搜索 vs 语义搜索

| 工具 | 适用场景 | 参数 |
|------|----------|------|
| `search_kb_search` | 精确关键词匹配 | `keyword="xxx"` |
| `search_kb_embedding_search` | 模糊查询、"记得大意但忘了标题" | `filters={"keyword": "xxx"}` |

> ⚠️ **参数注意**：`search_kb_embedding_search` 的关键词参数为 `filters.keyword`（嵌套字段），**不是**顶层 `keyword`。

**建议**：语义搜索召回后，再用 `entry_describe_entry` 或 `entry_describe_ai_parse_content` 精确读取。

### 搜索结果链接格式

> **⛔ URL 安全规则**：
> - `{domain}` 来自 `whoami()` 返回的 `company.company_domain`（如 `https://xxx.lexiangla.com`）
> - **禁止**将 `company_from` 拼接为子域名（如 `https://{company_from}.lexiangla.com` 是**错误**的）
> - `company_from` 只能作为 URL 查询参数（`?company_from=xxx`）

**链接拼接规则**：

| domain 类型 | 链接格式 | 示例 |
|------------|----------|------|
| 包含三级域名（如 `csig.lexiangla.com`） | 直接拼接，不加 `company_from` | `https://csig.lexiangla.com/pages/abc` |
| 顶级域名（如 `lexiangla.com`） | 末尾加 `?company_from=xxx` | `https://lexiangla.com/pages/abc?company_from=csig` |

> `{company_from}` 值从 mcp.json 的 `url` 字段中提取。

根据返回的 `target_type` 拼接路径部分：

| target_type            | 路径格式                                    |
| ---------------------- | ------------------------------------------- |
| `kb_page`              | `/pages/<target_id>`                |
| `kb_file` / `kb_video` | `/teams/<team_id>/docs/<target_id>` |

---

## 📖 内容读取

| 工具 | 返回内容 | 用途 |
|------|----------|------|
| `entry_describe_entry` | 条目元信息（ID、名称、类型等） | 获取基本信息 |
| `entry_describe_ai_parse_content` | **条目正文内容** | 读取实际内容进行分析 |

---

## ⚠️ 核心注意事项

1. **`_mcp_fields` 优化**：所有工具支持 `_mcp_fields` 参数选择返回字段，减少 token 消耗
2. 参数不确定时以 `get_tool_schema(tool_name="xxx")` 返回为准

---

## 参考文档

| 文档 | 说明 |
|------|------|
| `references/common-errors.md` | 常见错误排查 |
