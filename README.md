# deepseek-harness (dawalixi1980)

本仓库存放 DeepSeek Harness 相关的独立插件/工具。

## 内容

| 目录 | 说明 |
|---|---|
| [`dsh-skill-url/`](dsh-skill-url/README.md) | **从网址装技能**：粘贴一个 GitHub 网址，自动递归找出仓库里所有 `SKILL.md`，在设置面板里逐个安装 / 卸载，并可保存常用仓库网址。零第三方依赖，含预构建 `lib/` 与 bundle 补丁层。README 里记录了 DSH 插件开发的 **6 个致命坑**（TDZ、codec 形状、slot props、挂载护栏、方法名禁用名单、host/client 版本错位）与两个从 `app.asar` 抠真实校验源码的回归测试。 |
| [`dsh-chat-background/`](dsh-chat-background/README.md) | 聊天背景插件：在 Web GUI 设置中选择本地图片作为聊天窗口背景。独立分发的 bundle，含预构建 `lib/` 和 `dsh.bundle` 补丁层，可通过 `dsh plugin add` 安装。 |
| [`.agents/skills/harnessmaker/`](.agents/skills/harnessmaker/SKILL.md) | 插件开发 skill：完整开发/分发/安装/验证框架，含实测踩坑（tarball vs git/link 安装、Web 白名单 `settings-not-exposed`、运行时验证清单）。 |
