# Issue 286 非 IM 会话文件返回假成功修复方案

日期：2026-10-01。需求来源：[Issue #286](https://github.com/xmanrui/dsh-im/issues/286)。本地分析基线：`4d41a288485be6dfe0f796999c92763ac24ada35`，包版本 `4.32.0`。关联实现：[PR #290](https://github.com/xmanrui/dsh-im/pull/290)，本次核验的提交为 `9104a4998611124e0423275e0d530e3297683c4c`。

已实施：**复用现有文件 registry 中的接收方记录，只有当前会话、当前轮次确实有文件接收方时，才允许文件入队并提供 IM 文件返回提示。** 网页等会话误调用工具时明确失败，提示模型使用宿主提供的 `present` 工具（如果可用）。主要业务修改集中在两个共享文件内。

状态：实施和验收完成。最终实施基线为 `055b9271be267c9b295d24d529cf8cfe11007844`；下文保留方案和设计依据，末尾记录实际改动及自动、真实宿主验收结果。飞书“今天是牢梁”和 QQ“winBot”均在最终版本重新构建并冷启动宿主后，均已实际收到 TXT 文件和 PNG 图片；完整检查 3500 个测试全部通过。

## 问题和修复目标

用户在 DSH 网页里说“生成报告，发给我”，AI 调用 `dsh_im_return_file` 后会收到成功结果，并告诉用户文件已排队。但这个网页请求没有 IM 接收方，轮次结束时文件快照被清理，用户收不到附件，也看不到错误。

这里的 `consumer` 是 IM 桥为一次请求登记的文件接收方：它在轮次结束后调用 `take()` 领取文件，再交给已有渠道投递流程。文件存在、插件已加载、某个机器人已连接，都不能代替这个接收方。

修复后的行为应为：

| 场景 | 预期行为 |
| --- | --- |
| Web GUI、Desktop、CLI/API 请求，没有当前轮的 IM 接收方 | 不注入 IM 文件返回指令；误调用工具明确失败，不生成投递快照 |
| 当前 IM 请求提供了文件投递回调 | 工具入队，轮次结束后由现有流程领取、上传、发送 |
| IM 请求只需要文本，没有文件投递回调 | 不登记文件接收方；误调用文件工具同样明确失败 |
| 同一会话里另有等待执行的 IM 请求 | 等待中的请求不能使当前 Web 轮次具备文件投递能力 |
| 复制文件期间接收方关闭、被替换，或轮次结束、会话销毁 | 本次调用失败，清理本次临时快照，保留用户原文件 |
| 文件已经入队，随后渠道上传失败 | 沿用现有投递错误和回执机制；工具成功仍只表示已排队 |

修复选用 issue 允许的“工具明确失败”路径。插件只负责 IM 投递，不增加 Web 附件转发逻辑，也不在工具内部自动调用 `present`。是否能通过 `present` 展示文件，由宿主实际提供的能力决定。

## 已核实的代码依据

修复前的关键位置及复用方式如下：

| 代码位置 | 修复前行为 | 修复用途 |
| --- | --- | --- |
| [artifact.mjs](../../src/channels/shared/semantic/artifact.mjs) 的 `openConsumer()` | 建立请求接收方，保存到 `#consumersByPrompt` | 沿用登记与关闭生命周期 |
| 同文件的 `observeSessionEvent()` | 按 `user/message.source.rpcId` 将接收方绑定到轮次 | 复用精确匹配，不根据渠道名称或 UUID 前缀猜测 |
| 同文件的 `stage()` | 只检查会话和开放轮次，然后复制文件 | 在复制前后增加接收方校验 |
| 同文件的 `installOutboundArtifactTool()` | 全局注册工具，并注入静态文件返回指令 | 保留工具注册，改为当前轮次的动态上下文 |
| [harness-client.mjs](../../src/channels/shared/harness-client.mjs) 的 `ask()` | 无论是否有 `onArtifact` 都登记接收方；实际领取依赖 `onArtifact` | 使登记条件与实际领取能力一致 |
| [injected-context.mjs](../../plugin-src/host/injected-context.mjs) 的 `startGuidanceContext()` | 使用 `systemPrompt.context()` 动态提供会话上下文 | 复用同一动态上下文接口 |

本轮使用现有模块、临时报告文件和无接收方的会话进行了隔离复现，结果为：工具返回成功，`turn/end` 后 `take()` 返回空数组，原文件内容保留。该结果验证了主线模块中的失败链路；验证范围为模块级。

还读取了本机原版 DSH `0.1.7-rc.2` 的 Agent loop 源码。顺序为：`turn/start` → Inbox claim 并发出 `agent/inbox/claimed` → `systemPrompt.assemble()` → 后续步骤处理和用户消息落盘。因此，只等 `user/message` 再绑定接收方，会使首次提示词缺少 IM 文件返回指导；在 `agent/pre-step` 才绑定也晚于上下文组装。这项时序应在实施后的目标宿主版本上再次验收。

## 具体实现

### 使用已有记录判断当前轮是否能投递

在 `OutboundArtifactRegistry` 内提取一个小的私有查询函数，供 `stage()`、动态提示词和异常清理使用：

```js
#consumerForTurn(sessionId, turn) {
  const consumer = this.#consumersByTurn.get(turnKey(sessionId, turn));
  return consumer
    && !consumer.released
    && consumer.turn === turn
    && this.#consumersByPrompt.get(
      promptKey(sessionId, consumer.promptRpcId),
    ) === consumer
    ? consumer : null;
}
```

查询已有的两张 Map 即可。核对对象身份，是为了防止同一个请求 key 已被新接收方替换，旧记录仍被当作有效接收方。

再将读取当前轮次的现有逻辑统一成一个私有函数：事件流中已有记录时使用该记录；没有观察记录时，继续使用现有 `snapshotEvents()` / `session.events` 回退。

```js
#currentTurn(session) {
  const sessionId = sessionIdOf(session);
  return this.#openTurns.has(sessionId)
    ? this.#openTurns.get(sessionId)
    : currentTurn({ session });
}
```

收到当前轮的 `turn/end` 时，将 `#openTurns` 对应值设为 `null`。直到下一次 `turn/start` 再写入新轮次。这样已经观察到的结束事件不会被旧快照覆盖。这里必须使用 `Map.has()`，不能用 `??`，因为 `null` 明确表示轮次已关闭。

`disposeSession()` 和 `clear()` 沿用现有清理。对外只需要一个 `hasActiveConsumer(session)` 方法，为动态上下文返回布尔值；它先取得当前开放轮，再调用上述查询。

### 复制前后检查同一个接收方

在 `stage()` 已有参数和会话检查之后、`snapshotFile()` 之前查接收方。没有接收方就沿用 `artifactError()` 抛错：

```text
code: artifact-consumer-required
message: No active IM delivery consumer owns this turn. The file was not queued.
Use the host present tool if available to return the file in this conversation.
```

宿主现有工具执行机制会将异常转换为 `isError: true`。无需新增工具结果格式；现有成功结果、`artifactId` 和渲染逻辑继续使用。

复制和哈希计算包含异步操作，期间接收方可能失效。因此保留第一次取得的接收方对象，在快照完成后再检查一次：

```js
const consumer = this.#consumerForTurn(sessionId, turn);
if (!consumer) throw unavailable();

const snapshot = await snapshotFile(workspace, requestedPath, exec?.signal);
try {
  exec?.signal?.throwIfAborted();
  if (this.#currentTurn(agent.session) !== turn
    || this.#consumerForTurn(sessionId, turn) !== consumer) {
    throw unavailable();
  }
} catch (error) {
  await unlink(snapshot.storagePath).catch(() => undefined);
  throw error;
}

// 以下继续使用现有 artifact 构造和暂存流程。
```

`unavailable()` 只是生成上述错误的局部函数。验证通过后再写入 `artifactStorage` 和 `#stagedTurns`，因此验证失败时直接删除这次快照即可。`snapshotFile()` 自身发生复制、哈希或取消异常时，继续使用它已有的清理。

保留 `tools/result` 决定 `commit()` 或 `release()` 的现有机制，包括 Code Mode 外层调用失败时不投递文件的规则。接收方在成功入队后关闭，继续由现有 `closeConsumer()` / `discard()` 清理。

### 在首次上下文组装前绑定接收方

将 `observeSessionEvent()` 中按 `rpcId` 匹配并绑定轮次的几行代码提取成私有 `#bindConsumer()`。两个事件入口共用这个函数：

1. 新增 `observeClaimedMessage(session, message, turn)`：检查轮次有效且等于当前开放轮，使用 `message.source.rpcId` 绑定已有接收方。
2. 原有 `user/message` 分支：继续使用 `event.data.source.rpcId` 绑定，保留现有事件路径。

安装工具时增加宿主事件监听：

```js
ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
  registry.observeClaimedMessage(agent?.session, message, turn);
}, { global: true });
```

`openConsumer()` 只登记请求，不能提前给会话标记“支持文件返回”。必须等宿主实际领取这条消息才绑定到轮次，这样排队中的 IM 请求不会影响当前 Web 轮次。

### 文件返回指令只在拥有接收方的当前轮生效

在 `installOutboundArtifactTool()` 中删除静态 `systemPrompt.section()` 注册，改用仓库已有的动态上下文机制。沿用名称 `dsh-im:return-file`、顺序 `115` 和现有提示内容：

```js
ctx.systemPrompt.context({
  name: 'dsh-im:return-file',
  order: 115,
  text: (assembly) => registry.hasActiveConsumer(assembly?.agent?.session)
    ? returnFileGuidance
    : '',
});
```

`returnFileGuidance` 是现有提示内容的局部常量。动态查询直接读取文件 registry，无需再建一个提示词 Map，也无需向 `imSourceGuidance` 塞入另一份文件投递状态。复用的是宿主上下文机制。

工具仍通过现有 `tools.register()` 全局注册，执行时由 `stage()` 检查实际接收能力。工具 description 同时明确：需要当前 IM 轮次的活跃接收方；网页等会话应使用宿主的 `present`（如果可用）；成功只表示已排队。

安装函数沿用 PR #290 的三个前置条件：`tools.register`、`systemPrompt.context` 和 `ctx.on` 必须都可用，缺少任意接口则返回 `false`。不添加兼容兜底、静态提示或宿主版本分支。

### 有文件投递回调才登记接收方

`HarnessClient.ask()` 已将 `options.onArtifact` 归一化为函数或 `null`，直接复用该值：

```js
const closeArtifactConsumer = onArtifact
  ? outboundArtifactRegistry.openConsumer(sessionId, promptRpcId)
  : null;
```

位置保持在提交 prompt 之前。`finally` 中改为 `closeArtifactConsumer?.()`。`deliverArtifacts()`、`take()`、各渠道的 `onArtifact` 和上传发送实现继续沿用。

这一步补齐“有接收方就能领取”的前提，避免只有文本回调的请求也被认为能收文件。

### 异常丢弃有诊断日志

`turn/end` 分支使用同一接收方查询判断文件是否应保留。没有有效接收方、且该轮确实存在尚未领取的快照时，记录一条 warn 后调用原有 `discard()`。

日志包含 `sessionId`、`turn`、产物数量和“无有效 IM 接收方”的原因即可。数量直接从已有的 committed/staged Map 读取。安装函数取得宿主 logger，作为 `observeSessionEvent()` 的可选参数传入即可。

普通 Web 轮次没有产物时保持安静。日志放在异常 `turn/end` 分支，避免在通用 `discard()` 中给正常取消和清理打印警告。用户可见的失败仍由工具错误承担，warn 用于定位异常遗留。

## 改动范围和现有 PR 的复用

| 文件 | 改动 |
| --- | --- |
| `src/channels/shared/semantic/artifact.mjs` | 接收方查询、当前轮状态、复制前后校验、claimed 事件绑定、动态提示、异常丢弃日志 |
| `src/channels/shared/harness-client.mjs` | 按 `onArtifact` 条件登记接收方，使用可选关闭调用 |
| `test/outbound-artifact.test.mjs` | 修正正常发送 fixture，覆盖拒绝、提示、时序和异步失效 |
| `test/artifact-delivery.test.mjs` 及实际创建 artifact 的渠道测试 | 在 fixture 中建立与生产一致的接收方生命周期 |
| `test/channels/feishu/harness-client.test.mjs` 等共享 Harness 测试 | 覆盖有、无 `onArtifact` 的真实交接路径 |
| `lib/index.js` | 用现有构建脚本重新生成 Host bundle |

PR #290 已实现上述主要校验、claimed 事件、动态提示、回调条件和相应测试，可以作为实施基础。最终选择保留 PR #290 的实现，并补两处小调整：`turn/end` 复用同一有效接收方查询，避免保留已被替换接收方的产物；仅对确有异常遗留快照的情况记录 warn。另保留准备期间取消及日志的回归测试。移除曾提出的动态上下文接口缺失兼容分支及其专用测试。

本次保留现有文件 schema、上传逻辑和渠道回执，不增加配置、新依赖、队列、注册表或独立投递服务。业务修改集中在共享层，各渠道只补必要的测试 fixture。`lib/index.js` 是自动生成的发布入口，需要随源码修改重新构建。

## 回归测试和验收

正常发送测试的 fixture 应先 `openConsumer()`，再通过实际事件入口绑定到轮次。无接收方测试单独创建该场景，不能在所有 fixture 中默认登记而掩盖故障。当前“无 consumer 也能 stage，结束后清理”的用例需要改成“调用即失败”；清理覆盖另用接收方失效的场景验证。

自动测试至少覆盖以下行为：

| 验证点 | 必须断言的结果 |
| --- | --- |
| 无接收方、接收方已关闭、属于其他 session/turn、同 key 已被替换 | 调用失败；没有可领取产物；错误明确表示未入队 |
| 已绑定的有效 IM 接收方 | 成功入队；轮次结束后仍可领取；文件内容正确 |
| claimed 事件先于持久化 `user/message` | 首次上下文已经包含文件返回提示 |
| Web 轮次及同 session 的等待 IM 请求 | 当前轮次没有文件返回提示；工具不能借用等待请求的接收方 |
| 同 session 从 IM 轮次切到 Web 轮次 | 新的上下文不再提供 IM 文件返回指令；旧轮不能授权新轮 |
| 复制或哈希期间取消、关闭或替换接收方、结束轮次、销毁会话 | 调用不成功；本次实际快照被删除；原文件内容保留 |
| 已观察到 `turn/end`，会话快照仍停留在 `turn/start` | 不能重新入队或重新显示提示 |
| `ask()` 有或无 `onArtifact` | 有回调时正确交接；无回调时不存在可被文件工具使用的接收方 |
| 异常无主产物和空 Web 轮次 | 前者记录 warn 并清理；后者不输出警告 |

异步失效测试用确定的暂停点控制复制或哈希期间的事件，检查真实临时文件清理；复用 PR #290 已有的测试方法即可。继续运行原有 Code Mode、上传回退、取消、回执和文件原件保留用例。

实施后先运行受影响用例，修正遗漏的 fixture，再运行仓库完整检查：

```sh
node --test --test-concurrency=1 test/outbound-artifact*.test.mjs test/artifact-delivery.test.mjs test/channels/feishu/harness-client.test.mjs test/channels/shared/harness-control.test.mjs
npm run check
git diff --check
```

新增测试文件遵循现有命名和测试入口。上述检查已经执行，结果见末尾实施记录。

真实宿主验收使用修复后构建的包，至少完成：

1. 只加载插件，从 Web GUI 新建会话。请求返回文件，确认不出现全局 IM 文件指导；直接触发工具误调用时确认 `isError: true`，回复不再声称 IM 文件已排队。宿主有 `present` 时，再确认其正常提供下载或展示。
2. 从已有可用的 IM 渠道发起请求。确认首轮提示已生效，工具入队，轮次结束后用户实际收到附件或图片，回执沿用原流程。
3. 在同一 session 中切换 Web 和 IM 来源，并制造等待中的 IM 请求。确认发送权限跟随当前轮的实际接收方。
4. 在准备文件期间取消请求。确认无迟到入队、无本次快照遗留、原文件保留。

完成这些检查后即可认为本 issue 的目标达成：网页等会话不能再得到虚假的 IM 入队成功，正常 IM 会话继续通过原有渠道交付文件。

## 实施和验收记录（2026-10-01）

### 实际改动

以 PR #290 的共享层实现和测试为基础，应用到当前主线后补齐轮次结束时的有效接收方校验和条件 warn，并新增确定性取消测试。最终版本移除了缺少动态上下文接口时仍注册工具的兼容兜底，三个安装前置条件与 PR 保持一致。业务源码只修改 `artifact.mjs`、`harness-client.mjs` 两个共享文件；各渠道发送实现、文件 schema 和原有上传回执流程继续复用。

新增 `test/outbound-artifact-consumer.test.mjs` 和 `test/outbound-artifact-prompt.test.mjs`。前者在真实文件复制的确定暂停点验证取消、接收方关闭、替换、会话销毁、registry 清空、轮次结束和切换，断言临时快照删除及原文件保留；后者验证首次 claimed 绑定、动态上下文、等待请求隔离及 IM 到 Web 的来源切换。现有正常发送测试补上与生产一致的接收方登记。

已使用现有构建脚本生成 `lib/index.js`。包版本仍为 `4.32.0`；未新增配置项、依赖或投递服务。实现及本记录随本次修复提交，未发布 npm 包。

### 自动检查

| 检查 | 结果 |
| --- | --- |
| 受影响的文件返回、投递、飞书 Harness 和共享控制测试 | 初次检查 107 个用例全部通过 |
| 文件准备期间失效的确定性测试 | 补充取消用例后 7 个用例全部通过 |
| 最终 `npm run check` | 构建成功；3500 个测试通过，失败、取消、跳过均为 0；包产物验证通过 |
| `git diff --check` | 通过 |

上述机器人验收所用构建的 `lib/index.js` SHA-256：`1e9ddf6486d65fab496cc4e4b9076db8815a738361b54f7d443716448935b892`。

### 本机真实宿主和机器人验收

宿主为本机 DSH `0.1.7-rc.2`，地址 `http://127.0.0.1:3080`。最终构建后，在没有运行中会话的情况下使用原命令冷启动宿主。宿主 profile 的 `@xmanrui/dsh-im` 链接指向本工作区；记录了新进程 PID 与构建 SHA-256，确认本轮使用最终构建。临时 HMR 配置已在冷启动前逐字节还原。测试沿用两个机器人的现有模型、私聊及会话绑定。

| 场景 | 实际结果和证据 |
| --- | --- |
| 飞书“今天是牢梁”最终版本返回 | 第 7 轮真实调用两次 `dsh_im_return_file`，工具结果 seq 124、126 均成功，seq 132 正常结束；飞书原生客户端实际显示 `ISSUE286_SELECTED_FEISHU_20261001.txt`（135 Byte）和 128 × 96 PNG 图片 |
| QQ“winBot”最终版本返回 | 第 5 轮真实调用两次工具，结果 seq 80、82 均成功，seq 88 正常结束；QQ 原生客户端实际显示 `ISSUE286_SELECTED_QQ_20261001.txt`（127 Byte）及 PNG 图片 |
| 首轮实施验收：首次 IM 提示组装 | 飞书和 QQ 的 runtime-context 在首次模型请求 header 之前已包含 `dsh-im:return-file` 指导，确认 claimed 绑定时序生效 |
| 最终版本 Web/API 来源误调用 | 在已有验收 Web 会话的第 3 轮复测；当前上下文没有 IM 文件指导，工具结果 seq 53 为 `isError: true`，明确写出 `No active IM delivery consumer owns this turn. The file was not queued.`；模型明确说明失败、未排队，seq 59 正常结束 |
| 首轮实施验收：同一飞书 session 改由 Web/API 发起 | 当前轮不再提供 IM 文件指导；真实误调用同样失败，旧 IM 接收方不能授权新的 Web 轮次 |
| 首轮实施验收：Web 使用宿主 `present` | 实际调用成功，生成 `deliverables/presented`；在 Web 页面看到了两个文件卡片，并打开 TXT 侧边栏预览，内容包含合成测试标记 `ISSUE286_FEISHU_FILE_OK_20261001` |
| 首轮实施验收：飞书文件准备途中取消 | 使用 256 MiB 合成文件；观察到实际快照复制到 67,174,400 字节时调用宿主取消。工具结果为 `isError: true`，`turn/end.reason.kind` 为 `aborted`、原因为用户取消；快照不存在，原文件大小和内容标记保留，未迟到入队 |
| 首轮实施验收：切换来源及取消后恢复 IM | 同一飞书 session 再次真实返回 TXT 和 PNG，两次工具调用成功、轮次正常结束，原生客户端再次收到附件及图片 |
| 收尾状态 | 两个机器人均连接正常、健康检查为 healthy，最终没有消息错误；临时宿主 patch 已逐字节恢复原始内容 |

表中“首轮实施验收”在此前包含兼容兜底的实现上完成；这些场景的核心逻辑在最终版本中保留，其对应自动用例再次通过。最终版本重新执行了飞书、QQ 文件和图片回传及 Web 误调用验收，不将此前实测冒充最终构建的新记录。

等待中的 IM 请求与当前 Web 轮次的隔离、接收方替换及旧快照不能重新开放结束轮次，使用确定性自动测试验证；未声称在真实聊天中制造了这些并发时序。

取消测试的前两次尝试没有成功触发取消，合成大文件入队后产生已有的 `CHANNEL_DELIVERY` 错误回执，这两次不计为取消验收成功。调整测试触发器后，第三次确实在复制尚未完成时取消，清理和后续正常发送均通过。大文件只用于这一项取消测试，验收后已删除。

使用的 TXT 和 PNG 均为合成测试数据。证据保存在本机 `/Users/manruixie/.dsh-test-evidence/issue286-20261001/`，目录权限为 `0700`；日志和结构化记录未加入仓库，机器人配置、认证信息和完整宿主配置未写入本文。

最终版本证据：`selected-version-check.log`、`selected-cold-start.json`、`selected-feishu-session-events.json`、`selected-qq-session-events.json`、`selected-web-negative-events.json`、`selected-profile-restored.json`、`selected-final-verification.json`。

首轮实施验收证据另行保留：`final-check.log`、`feishu-session-events.json`、`qq-session-events.json`、`web-negative-events.json`、`same-session-web-events.json`、`web-present-events.json`、`cancel-during-snapshot.json`、`cancel-cleanup.json`、`final-verification.json`。其中飞书第 5 轮为取消、第 6 轮为正常恢复；QQ 第 4 轮为此前的文件投递。

### 提交前同步主线（2026-10-01）

用户要求提交并推送后，先同步远端最新主线 `b197700099836c654f0d0fadcd1313d8e8d58f94`，包含 PR #289 的飞书资源下载修复及贡献者元数据整理。Issue #286 的源码和测试补丁干净应用，共享业务修复保持与上述机器人验收一致。随后重新构建 Host bundle，并执行 `npm run check`：3544 个测试全部通过，失败、取消、跳过均为 0，包产物验证通过。

本次提交的 Host bundle SHA-256：`ac599c23cc72cba7d50297da828daf07444358b4a9c99fe57d941a30f547c585`。构建哈希因合入上游修改而变化；本节完整检查对应同步后的代码，上面的机器人实测记录对应其注明的原构建，未重复声称实测。检查日志为本机私有证据目录中的 `push-check.log`。

提交只包含 Issue #286 的共享层修复、相应测试、Host 构建产物及本记录。其他工作区文档和素材不纳入本次提交。
