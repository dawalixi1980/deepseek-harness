# dsh-split-obsidian

> **一句话**：在侧栏点一下，DSH 和 Obsidian 就在屏幕上左右并排；拖动侧栏里的分隔条
> 可以实时调整比例。

---

## 它解决什么

一边看 DSH 里的对话/资料，一边在 Obsidian 里记笔记，需要来切窗口。这个插件把两个
窗口**平铺到屏幕左右**，中间留一条缝，比例随时可调。

## 它不是"把 Obsidian 嵌进侧栏"

**那个做不到**，先说清楚：

- DSH 侧栏那个浏览器标签页本质是 `<webview>`（Chromium 内嵌网页控件），只能装网页；
- Obsidian 是**独立的 Windows 桌面程序**，它的窗口没法塞进网页控件里；
- 而且主进程会**主动拦掉** `obsidian://` 这类自定义协议（只放行 `http/https/about/data/blob`）。

所以这里做的是**操作系统层面的窗口平铺** —— 两个独立窗口并排。用户看到的"并排视图"
效果是一样的。

## 用法

1. 先启动 Obsidian（不用打开特定库，插件会自己找它的窗口）
2. 右侧栏 → 点展开 → 找到 **「Obsidian」**（和「工作区文件 / 浏览器 / 书签」并列）
3. 点「并排」→ 两个窗口左右铺开
4. 拖**分隔条**调比例；或者点预设 `50:50` `62:38` `70:30` `38:62`
5. 「还原 DSH」让 DSH 重新占满工作区

比例会被记住，下次打开还是这个。

## 工作原理

```
侧栏（拖动分隔条）
   ↓ Typert Remote 调用  drag(ratio)
host 半（lib/index.js）
   ↓ 按工作区与比例算出两个矩形（lib/layout.js）
常驻 PowerShell（lib/snap-server.ps1）
   ↓ user32!MoveWindow / ShowWindow / SetForegroundWindow
DSH 窗口  +  Obsidian 窗口
```

### 为什么是常驻 PowerShell

一次性起 PowerShell 进程要 **~390ms**（启动 + `Add-Type` 编译 C#），拖动时每次都要这个
开销会明显卡顿。改成进程内 `while` 循环读 stdin 之后，单次移动降到 **~4ms**（实测 20 次
连续移动共 64ms），**拖动完全跟手，可以每帧调用**。

### Windows 上的四个坑（都写在代码注释里）

1. **被最大化的窗口不能直接 `MoveWindow`** —— 实测 DSH 最大化时矩形是 `(-8,-8) 1936x1048`，
   比工作区 `1920x1032` 还大（含阴影边框），此时移动会被系统忽略。必须先 `ShowWindow(SW_RESTORE)`。
2. **最小化窗口的坐标是 `(-32000,-32000)`** —— 哨兵值，直接拿来做计算会得到垃圾结果。
3. **恢复 Obsidian 时用 `SW_SHOWNOACTIVATE`** —— 让它显示但不抢焦点（你在 DSH 里点按钮，
   焦点不该跳到 Obsidian）。
4. **`cmd start` 会把 URI 里的 `&` 当命令分隔符截断** —— 打开 Obsidian 用
   `rundll32 url.dll,FileProtocolHandler`。

## 已知限制

- **只支持 Windows**（用 Win32 调窗口）。
- **拖动时分隔条会略微"追不上手"**：DSH 窗口自己在变窄，而分隔条画在 DSH 页面里，
  它的位置也跟着窗口边缘动。这是"用两条独立窗口模拟分屏"的固有问题。
- **比例下限 20%、上限 80%** —— 再窄两边都没法用。
- **"在 Obsidian 打开本工作区"只定位到库，不定位到具体文件夹**：`obsidian://open` 的
  `file=` 参数只认文件；要定位文件夹需要 Obsidian 的 Advanced URI 社区插件。

## 开发

```bash
node test/layout.test.mjs          # 49 项布局计算测试
node scripts/probe-windows.mjs     # 真实窗口实测（会真的移动你的窗口）
```

## 卸载

插件卸载时会自动收掉常驻 PowerShell 进程（`ctx.effect` 的清理钩子），不会留孤立的
`powershell.exe`。
