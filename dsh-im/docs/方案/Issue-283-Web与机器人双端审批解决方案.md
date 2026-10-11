# Issue 283 Web 与机器人双端审批解决方案

本方案解决同一 DSH 会话在 Web 端与机器人端之间切换时，另一端看不到审批、任务静默等待的问题。建议在现有审批处理函数中增加双端竞争，并为 Web 发起的审批补上已绑定私聊的投递入口。继续使用 Host 的审批日志、现有审批队列和卡片，不建立新的审批系统。

问题来源：[Issue 283](https://github.com/xmanrui/dsh-im/issues/283) 及其 Telegram 复现评论。代码核对基线：2026-10-03，本仓库 `55e4b58`，插件 `4.34.2`。本文是待实施方案，没有修改功能代码，也没有完成双端实测。

DSH 目标版本：2026-10-03 查询 npm 时，`@deepseek-ai/dsh` 的 `latest` 与 `next` 均为 `0.2.0-rc.2`。已读取同版本 `dsh-user-approval` 和 `dsh-client-ui-approval` 发布包，确认本方案依赖的审批事件、结果枚举、Host 日志和 Web 取消信号仍存在。发布信息：[DSH latest](https://registry.npmjs.org/@deepseek-ai/dsh/latest)、[审批服务 0.2.0-rc.2](https://registry.npmjs.org/@deepseek-ai/dsh-user-approval/0.2.0-rc.2)、[Web 审批 0.2.0-rc.2](https://registry.npmjs.org/@deepseek-ai/dsh-client-ui-approval/0.2.0-rc.2)。实施开始时再核对 latest；如有更新，核对新版本接口并更新单一验收基线，不增加多版本兼容分支。

## 目标与实施范围

本次实施和专项验收限定为 11 个渠道：飞书、微信、钉钉、企业微信机器人、企业微信自建应用、QQ、Telegram、Slack、Discord、WhatsApp、Matrix。iMessage、Email、AI Office 暂不处理，其专项适配、协议调查和真机验收不作为本次交付条件。

仅支持最新版 DSH 的现代接口，不做旧 `apiProxy` 服务兼容、历史版本特性探测、协议回退或多版本测试矩阵。issue 中的旧版本仅用于描述问题来源。

同一次审批在 Web 与一个明确的机器人入口同时可处理；Host 先收到的有效批准或拒绝生效，另一端结束交互。这里的两端是 Web 与机器人，与使用电脑还是手机无关。

| 场景 | 预期行为 |
| --- | --- |
| 机器人发起，Web 在线 | 原机器人入口和 Web 同时可审批，无需开启双向同步 |
| Web 发起，有唯一有效的双向同步私聊 | Web 与该私聊同时可审批 |
| 无浏览器连接，但有可用机器人入口 | 继续等待机器人审批 |
| 无 `rpcId` 的 Host 轮次，有唯一有效的同步私聊 | 按 Session 绑定找到机器人，不要求伪造用户输入 |
| 没有机器人入口 | 使用 Host 原生审批链 |
| 同步未开启，或者只有 `/watch` 关注 | 不由关注关系增加审批入口 |
| 无活动机器人发起人，且绑定了多个不同私聊 | 向有效同步目标发提示，由 Web 处理；不擅自选择审批人 |
| 所有处理端都不可用 | 沿用 Host 的 `unavailable` 结果；能送达提示时明确说明操作未获批准 |

“只保留一个机器人审批入口”是本方案为降低复杂度作出的范围选择：现有队列按 `approvalId` 保存一项审批，可以直接复用。多个机器人或多个私聊同时竞争同一次审批不包含在本次实现中。它不影响 issue 中单个私聊绑定的两个方向，但不能将本方案宣称为任意数量终端的广播审批。

机器人继续提供“允许一次”和“拒绝”。当前接口只接受 `allowed-once` 和 `rejected`，最新版 DSH 的 Web 审批也提供这两个决定。本次不增加“总是允许”或修改审批策略；联调只针对上述最新版验收基线的返回值及取消行为。

## 已有机制与实际缺口

| 现有代码 | 可以复用的内容 | 本次补充 |
| --- | --- | --- |
| `plugin-src/host/modern-harness-api.mjs` | `approval/request`、审批 ID 匹配、pending Map、响应校验、事件广播 | 同时调用原生回答链与机器人回答链，统一决定和清理 |
| 同文件的 `#requestQuestion()` | 双端等待、独立取消信号、结束另一端交互的做法 | 借鉴生命周期，不直接复制问题答案的返回语义 |
| `src/channels/shared/harness-client.mjs` | 活动轮次归属、工具调用详情提取、`respondInteraction()`、结果分发 | 小范围复用工具详情提取；保留现有 ownership 规则 |
| `plugin-src/host/delivery-service.mjs`、`delivery-adapter.mjs` | 按 Session 查同步目标、验证私聊目标和绑定、主动发送 | 增加内部审批投递入口，复用同一条校验链 |
| `src/channels/shared/harness-approval.mjs` | FIFO、精确回复、操作者检查、重复提交保护、`handleResolved()` | 接入同步发起的审批；补足退出展示与最终决定之间的区分 |
| 飞书 Bridge、审批卡模板 | 按钮、结果文案、更新原卡、文字降级 | 复用到没有入站消息的同步私聊 |
| `TextHarnessBridge` | Telegram 等渠道的审批文字和回复处理 | 接收同步发起的审批，复用原队列 |

当前 `#requestApproval()` 被机器人认领后不再调用 `next()`，导致 Web 收不到；没有活动 IM ownership 时直接走 `next()`，导致 Web 发起的审批不会到机器人。因此，单独加一个 `Promise.race()` 只能修好其中一个方向。

Host 已经负责 `approval/asked` 与 `approval/decided` 的日志记录。插件应只向原调用返回一个最终 outcome，不自行补写另一份审批记录，不增加数据库或磁盘 pending 文件。这里的日志职责已在 `0.2.0-rc.2` 审批服务发布包中核对；目标版本与本插件组合后的实际行为仍须通过联调验证。

## 统一审批决定

改造保持在 `ModernHarnessApi` 内，保留 `#pendingApprovals` 为插件的请求登记表。竞争分支只对本次范围启用，排除项沿用原审批路径，具体见后文范围隔离。抽出审批展示辅助方法即可，不创建通用交互调度框架，也不顺带重构 question。

处理顺序如下：

1. 从请求取得 Session 和事件，沿用现有查找方式匹配尚未处理的 `approval/asked`，并核对 `callId`。无法准确关联时走原生 `next()`，不猜测审批 ID。
2. 登记一份 pending，保存原轮次信号，创建本次审批自己的 `AbortController`。
3. 启动原生 `next()`；有活动 IM 发起人时使用现有 mux 投递，否则异步查询同步私聊并尝试投递。目标查询和平台发卡不能挡住 Web 展示或 Web 决定。
4. 两边收到的有效 outcome 都进入同一个同步 `settle()`。沿用 Map 删除或等效的一次性占用检查，在任何异步收尾之前确定结果；只有第一次成功，迟到的机器人提交返回现有 `not-pending`。
5. 将唯一 outcome 返回 Host，交由原审批服务记录结果并继续或拒绝操作；通过现有结果通知结束机器人展示，并结束仍在等待的原生审批。

不直接对所有 Promise 的返回值做裸 `Promise.race()`。各结果按以下语义处理：

| 收到的结果 | 处理 |
| --- | --- |
| `allowed-once` | 本次批准，可以成为最终决定 |
| `rejected` | 本次拒绝，可以成为最终决定 |
| 某一处理端 `unavailable` 或连接异常 | 该端不能处理；另一端可用时继续等待 |
| 某一展示端取消或撤销 | 只撤销该端；不能仅凭它返回 `cancelled` 判断整个轮次已取消 |
| 原始轮次信号取消，或 Host 适配器 dispose | 整次审批结束为 `cancelled`，清理两端 |
| 原生端不可用，机器人也确认无法展示或继续处理 | 结束为 `unavailable`，不留永远 pending 的 Promise |

端的可用性只需要请求闭包中的少量标记；保持一个最终结果和一个 pending，不新增状态机类。正常等待用户不增加自动拒绝时限；平台投递使用现有网络超时。发送成功只能说明消息已送达，不表示用户已作出决定。

沿用 question 的独立信号思路：原始轮次取消可以传递给本次审批，但结束另一端卡片只能取消审批自己的信号，不能取消整个 turn 或等待审批的 `run_code`。审批请求对象与 question 的构造方式不完全相同；实施时保存原信号、核对目标 Host 的 waterfall 参数传递方式，并在退出时按需恢复替换的字段，不假定 `next()` 能接收替换参数。

Web 端继续使用原生审批界面。机器人先处理后，原生卡片应结束或移除；机器人侧使用现有 `approval/resolved` 和 `handleResolved()`，飞书更新原卡、文字渠道发送处理结果。本次不要求改造 DSH Web，使它显示某一条新增的“已由机器人处理”文案。

## Web 发起时投递到机器人

### 目标选择

有活动 IM 发起人时，继续只用原来的机器人、聊天和操作者；不再向同步绑定目标重复发送审批。

没有活动 IM 发起人时，调用现有 `listSessionSyncTargets(sessionId)`。通过 adapter 使用现有 `conversationKey`、私聊匹配检查和会话绑定记录验证目标，按渠道、机器人和真实私聊身份去重。重复保存的同一私聊目标算一个入口；同一 Session 对应不同私聊则视为存在歧义。

只有唯一有效私聊、机器人正在运行、渠道能确定接收用户并处理回复时，才创建可操作的机器人审批。对仅有 chat/channel ID、无法可靠确定审批用户的渠道，不能把聊天 ID 当用户 ID，先走提醒降级。

查找基于 Session 绑定，不读取上一条用户消息来猜审批人，也不依赖来源 `rpcId`。这同时覆盖 Web、调度器和其他合法 Host 发起的轮次。此能力只对用户已经开启双向同步的私聊生效。

### 复用投递链与审批队列

沿用现有调用层次，增加一个内部审批投递方法，方法名可采用 `presentSessionSyncApproval`：

```text
ModernHarnessApi
  → DeliveryService
  → 当前渠道 delivery adapter
  → 已运行的 Controller / Runtime
  → 当前 Bridge 的 HarnessApprovalQueue
```

`harnessConnection(ctx, config)` 已接收包含 `deliveryService` 的渠道配置，将本次支持渠道的本地连接直接接到最新版 `modernHarnessApi()`，并传入已有 deliveryService，不再优先探测或回退到旧 Host `apiProxy` 服务。同一 Host 的 API 有缓存，要处理先由无 deliveryService 的调用者创建、后由 IM 渠道补充依赖的顺序；沿用 Host 作用域和 dispose，不新增全局单例或公开 RPC。HarnessClient 内部参数仍可沿用 `apiProxy` 这一名称接收现代适配器对象，无需为去除旧服务兼容而重命名全部内部传输接口。

adapter 将现有 `sendSessionSyncText()` 中的“仍开启同步、仍绑定本 Session、仍为有效私聊”检查提成小函数，供文字和审批两个入口复用。审批入口只允许使用已运行的 Runtime；它与现有主动投递一样经过 Controller，不为发审批新建机器人连接或常驻监听器。

向 Bridge 传入已有 interaction 结构、准确的工具详情和本次审批的结束通知。Bridge 只补齐当前路由的 `key`、`actor`、发送函数，然后调用现有 `handleRequested()`。`respond` 继续使用 `HarnessClient.respondInteraction()` 或具有完全相同回执语义的适配，最终必须进入同一个 Host pending；不得另起一次 Host 审批。

结束通知可作为本次调用的 Promise/回调传入，调用现有 `handleResolved()`。先登记队列和结束回调，再等待平台发卡，复用队列已有的“正在发送时被处理”收尾逻辑。新同步入口不需要先发送一条虚假的用户消息，也不需要创建 `ask()` 或伪造 ownership。

普通 IM 入口仍使用原 mux；同步入口直接送入明确的 Bridge。同步审批不能再无差别广播给普通 IM watcher，避免未开始的 IM 轮次将其当成历史遗留审批认领并拒绝。新增请求、重连重放和结束通知都应明确使用对应入口。

### 工具详情与用户身份

没有 IM ownership 时，不能再依赖 ownership 中的 `toolCalls` 缓存。小范围提取现有事件解析逻辑，从当前轮次的 `tool/call` 或 `tool/code-dispatch-start` 中按 `callId` 取得名称和完整参数，覆盖普通工具与 PTC 子调用，再用现有 `harnessApprovalText()` 检查是否能够展示。

详情缺失或无法完整展示时，不创建可批准的同步审批，而是提示到 Web 处理。不要把这种情况直接交给队列现有“无法展示则拒绝”的分支，否则只是机器人没有展示能力，也会抢先否决 Web 上仍可处理的审批。竞争路径中现有恢复拒绝、关闭路由和自动拒绝分支需要逐一核对：用户明确拒绝和整次请求取消仍然生效；单个展示端不可用不应冒充用户拒绝。

提交之前再次验证原目标仍开启同步、仍绑定原 Session，操作者仍符合原有访问策略；绑定改变后不将审批转移给新用户。复用队列的 actor 检查和渠道现有消息授权入口，不创建第二套权限表。

### 渠道接入

飞书复用 `approvalCard()`、`onResolved()` 和原卡 patch。同步私聊的目标是 `open_id`，使用现有 `#sendCard(..., { receiveIdType: 'open_id' })` 能力，文字降级使用现有主动私聊发送方法；不能将 openId 当作 chatId。新分支须核对卡片回调路由，确保点击仍能找到原会话 key 并验证同一 actor。

Telegram 复用 `TextHarnessBridge` 的文字审批和精确 yes/no 回复，不新增审批按钮。私聊目标转换复用 Runtime 的现有投递逻辑，确认真实 private chat 和用户身份后再进入队列。

其他使用公共 TextHarnessBridge 的渠道可复用同一审批入口，但各 Runtime 的目标和用户转换仍需明确接线及测试。微信、钉钉、QQ 等独立 Bridge 复用其已有审批队列，增加同样的薄转发。不能因它们共用 HarnessApprovalQueue 就宣称无需渠道接线。

飞书、Telegram 可以先完成以验证实现路径，但下面 11 个已有私聊同步路由的渠道均为完整交付范围，不能将其余渠道长期留在“只提醒”后宣称全渠道完成。提醒用于异常降级；阶段性版本未接入的渠道须明确标为未完成。

### 逐渠道覆盖清单

2026-10-03 对照 `plugin-src/host/index.mjs` 的注册清单、`delivery-suggestions.mjs` 的私聊匹配代码及实际 Bridge 继承关系核对。下表只列本次实施的 11 个渠道，为实施要求，不是已实现或已通过测试的声明。“原入口”列表示渠道发起后，Web 也能决定；“同步私聊”列表示 Web 或其他 Host 轮次发起后，该渠道也能决定。两列均遵守前文唯一有效入口的限制。

| 渠道 | 现有审批处理 | 原入口与 Web 竞争 | Web 发起投递同步私聊 | 必须单独核验 |
| --- | --- | --- | --- | --- |
| 飞书 `feishu` | 独立 Bridge + 公共审批队列 | 必须覆盖 | 必须覆盖 | `p2p` / openId 身份、open_id 发卡、按钮回调和原卡更新 |
| 微信 `weixin` | 独立 Bridge + 公共审批队列 | 必须覆盖 | 必须覆盖 | `p2p` / toUserId、现有主动发送条件、文字回复 |
| 钉钉 `dingtalk` | 独立 Bridge + 公共审批队列 | 必须覆盖 | 必须覆盖 | `p2p` / userId、主动私聊投递、发起人身份一致 |
| 企业微信机器人 `wecom` | 独立 Bridge + 公共审批队列 | 必须覆盖 | 必须覆盖 | `direct` 私聊、投递路由与入站用户身份对应，不把群 chatId 当用户 |
| 企业微信自建应用 `wecom-app` | 独立 Bridge + 公共审批队列 | 必须覆盖 | 必须覆盖 | `p2p` 私聊、应用用户身份、回调回复 |
| QQ `qq` | 独立 Bridge + 公共审批队列 | 必须覆盖 | 必须覆盖 | `c2c` / userOpenId、主动发送可用性、文字回复 |
| Telegram `telegram` | TextHarnessBridge | 必须覆盖 | 必须覆盖 | `direct` chat、用户 ID 与路由匹配、yes/no 精确回复 |
| Slack `slack` | TextHarnessBridge | 必须覆盖 | 必须覆盖 | `direct` DM channel 对应的真实用户；channelId 不能直接充当 actor |
| Discord `discord` | TextHarnessBridge | 必须覆盖 | 必须覆盖 | `direct` DM channel 对应的真实用户；不将 guild channel 当私聊 |
| WhatsApp `whatsapp` | TextHarnessBridge | 必须覆盖 | 必须覆盖 | `direct` JID、电话号码 JID 与 LID 的身份一致性 |
| Matrix `matrix` | TextHarnessBridge | 必须覆盖 | 必须覆盖 | `dm` 用户 ID 到真实房间的投递映射、入站 sender 验证 |

Slack 和 Discord 的可投递 DM channel 也不自动提供可审批用户。接入时优先使用已有可证明的路由身份信息，必要时通过现有平台客户端取得 DM 对端身份并验证；不得通过“收到第一条 yes 的人就是审批人”解决。身份正常可解析时必须完成审批接入；查询失败等异常才使用提醒降级。

### 范围隔离

iMessage、Email、AI Office 与本次渠道共享部分 Host 或 HarnessClient 代码，因此实施时将一个内部审批竞争能力标记随现有 interaction ownership 传递，默认不启用，仅由上述 11 个渠道的生产装配显式启用。它只决定走原审批分支还是新竞争分支，不新增用户配置、能力注册中心或持久化字段，也不依赖解析 rpcId 前缀来识别渠道。标记属于具体客户端和 owner，不能因现代 API 在同一 Host 中被缓存而变成全局开关。

已有活动 owner 但未启用该能力时，沿用原有独占审批处理；不能将其误判为“没有 owner”再向绑定私聊转投。只有确实没有活动 owner 的 Web 或其他 Host 轮次，才进入前述同步私聊查询，且投递目标限定在本次 11 个渠道。公共队列新增的竞争专用行为也按本次交互启用。这样无需调查或修改三个排除渠道的专有流程；只在公共层测试中验证范围外消费者继续走原路径。

### 连接方式与聊天范围

以上竞争改动只面向最新版 DSH 的本地现代 Host，使用 `modernHarnessApi()`。所需现代接口缺失时明确说明版本或运行环境不受支持，不静默降级到旧 `apiProxy` 服务。配置 `harnessBaseUrl` 的跨 Host 连接不属于本次双向同步审批范围，不为此新增跨 Host 适配或历史协议测试。

渠道发起的既有群聊审批仍保留原操作者检查，并验证 Web 可以竞争处理。Web 发起的新增投递只覆盖现有同步私聊，不因本次修改向群聊新增审批权限。

## 提醒与异常收尾

提醒作为正式方案的降级路径保留，不另建通知服务。使用现有 `sendSessionSyncText()`；用户关闭同步后，发送前的同一校验自然使提醒停止。

| 条件 | 行为 |
| --- | --- |
| 多个不同私聊，无法确定唯一机器人入口 | 向有效同步目标发送“该会话有操作等待审批，请到 Web 处理”，不发送批准/拒绝按钮 |
| 渠道尚未接入、详情不完整或身份无法确定 | 同样提示由 Web 处理，不提交机器人拒绝 |
| 机器人卡片失败、文字可发送 | 沿用现有卡片到文字降级，仍可用原审批回复 |
| 机器人展示彻底失败，Web 仍在等待 | 撤下该机器人的本地队列项，继续由 Web 处理 |
| Web 无处理端，机器人也不可用 | 返回 `unavailable`；能发送文字时改为说明“未找到可处理端，本次操作未获批准”，不继续说正在等待 |
| 任一端已处理，另一端发卡稍后才完成 | 使用现有 presentationTask 收尾，立即更新或补充已处理提示，不重新开放审批 |
| 更新机器人卡片失败 | 保留已确定的决定，沿用文字结果和日志，不重新提交审批 |
| Host 重启或适配器释放 | 沿用既有取消、历史交互恢复规则，不恢复一个无法证明仍有效的旧批准按钮 |

等待提示只在审批仍 pending 时发送；没有 pending 时不要补发过时的“等待”通知。对先通知后失去全部处理端的情况，补发终态说明。去重和通知状态放在本次 pending 的局部数据中；不为此增加持久化通知表、定时轮询或无限重试。

## 文件改动与实施顺序

| 顺序 | 主要文件 | 改动目标 |
| --- | --- | --- |
| 1 | `plugin-src/host/modern-harness-api.mjs`、对应 Host 测试 | 按 owner 的内部能力标记启用本次范围，完成 IM 发起时的 Web 竞争、唯一决定、不可用端处理和独立信号清理 |
| 2 | `plugin-src/host/harness-connection.mjs`、`delivery-service.mjs`、`delivery-adapter.mjs` | 本次支持渠道直接使用最新版现代入口，注入已有 deliveryService，补内部同步审批入口，复用目标验证 |
| 3 | `src/channels/shared/harness-client.mjs`、`harness-approval.mjs` | 复用工具详情提取和响应回执，确认同步入口、展示退出、队列收尾语义 |
| 4 | 飞书和 Telegram 的 Controller、Runtime、Bridge；公共 `TextHarnessBridge` | 接通真实绑定私聊，复用身份、投递、审批队列和结果 UI |
| 5 | 其余 9 个已支持同步渠道的转发层、locale、文档及对应测试 | 完成全部 11 个渠道的同步审批接线和逐渠道验证；新增文案沿用 `t()` 和 locale |
| 6 | 公共 Host、HarnessClient 和连接测试 | 在最新版 DSH 下验证范围外 owner 不启用新竞争逻辑、所需现代接口缺失时明确失败；不增加旧服务和历史版本兼容测试 |

正常最终答复的同步协调器不需要改造成审批中心。提醒和审批投递使用同一个 deliveryService 即可；不依赖同步协调器只识别 DSH 用户消息的 origin 状态，避免再次遗漏无 `rpcId` 的 Host 轮次。

前两阶段可以拆成独立提交，但仅完成“IM 发起时 Web 也有审批”或只发提醒时，不能关闭 issue 并宣称双向问题全部解决。

## 验证与验收标准

优先扩展现有测试夹具：`test/host-modern-harness-api.test.mjs`、`test/channels/shared/harness-approval.test.mjs`、`test/delivery-adapter.test.mjs`、`test/delivery-service.test.mjs`，以及各实际接入渠道的 Bridge、Runtime、Controller 测试。

必须覆盖以下行为，测试检查实际响应、结果通知和操作执行次数，而不是仅检查新方法被调用：

1. IM 发起：Web 先批准、先拒绝；机器人先批准、先拒绝。每次只有一个结果，另一端收尾。
2. Web 发起：唯一同步私聊收到完整操作详情；机器人回复能处理原审批，不产生第二轮或第二次审批。
3. 两端几乎同时提交相反决定、重复点击、旧按钮迟到：只执行一次，不覆盖结果，也不处理下一条审批。
4. 原生端立即返回 `unavailable`，机器人稍后回答：仍然成功等待；两端都不可用则退出，不挂起。
5. 整个 turn 取消以及 PTC 中机器人先批准：前者清理两端，后者只结束 Web 卡片，`run_code` 继续执行。
6. 无 `rpcId` 的合法 Host 轮次仍能按绑定投递；没有绑定则维持原生行为。
7. 同步关闭、改绑、目标删除、机器人停止、错误操作者：旧目标不能再批准；多绑定和重复目标按约定处理。
8. 发卡失败、文字降级、发卡过程中另一端处理、卡片 patch 失败：决定不重复、不被展示错误覆盖。
9. 普通工具和 PTC 子调用均匹配准确参数；缺失详情时只有提醒，不出现可批准但缺少内容的审批。
10. FIFO、提问优先于审批的 yes/no 解析、正常消息与最终答复同步维持原行为；同一 Host 缓存和不同 Host 隔离正常。
11. 对清单中的 11 个同步渠道逐项验证两个发起方向，并核验各自的 actor 和路由转换；公共层测试通过不能代替渠道装配测试。当前 `test/delivery-adapter.test.mjs` 的私聊循环夹具仅列出 10 个渠道，需补入 Matrix 或明确引用等效独立覆盖，不能依赖测试名称推断完整性。
12. 在最新版 DSH 下，公共层覆盖能力标记启用、未启用以及不同 owner 共用同一 Host 的情形，确认不会误启用范围外消费者，也不会把其审批转投其他聊天；验证本次渠道的已有群聊审批，并确认现代接口缺失时不走旧服务回退。无需排除渠道账号、外部 Host 或历史 DSH 版本作为验收前置。

目标测试通过后运行现有 `npm run check` 与 `git diff --check`。无需为本方案新建测试框架。

在最新版 DSH 的 Web 配置上分别用飞书和 Telegram 做真实验收，当前基线为 `0.2.0-rc.2`：Web 发起后由机器人批准和拒绝；机器人发起后由 Web 批准和拒绝；关闭浏览器后由机器人继续处理。使用独立临时文件或可核验的无害操作，批准只执行一次、拒绝不执行；检查原审批卡片结束、任务继续，以及同一 `approvalId` 只有一个 `approval/decided`。不以界面文字代替日志和操作结果核验。

其余 9 个本次渠道按上述清单记录自动化与真实平台验证情况。没有相应账号或运行条件时明确记为未实测，不能把飞书、Telegram 的真实结果外推为所有平台已验证。全部 11 个渠道要求的代码接线、自动化覆盖以及公共层范围隔离完成后，才可称本次实施范围已完整覆盖；“本次 11 个渠道真机验收通过”需要逐平台证据。排除渠道不作为本次完成条件。

## 控制复杂度的约束

本次沿用现有绑定设置、审批 ID、Host 日志、队列、消息回复、卡片和网络超时。不增加依赖、数据库、审批中心、通用事件总线、新的常驻会话 watcher、永久授权、自动批准、离线审批恢复机制或历史 DSH 兼容层。

新增代码主要承担两个必要职责：让已有 Web 和机器人回答者共享一次决定，以及把已有绑定私聊接到已有审批队列。保持一个明确的机器人入口，使本次无需改造队列为一项审批对应多个不同审批人；如果未来确实需要多机器人广播审批，再单独明确产品规则和队列扩展。


## 实施与验收（2026-10-05）

已在 `codex/issue-283-dual-approval` 实施，基线为 `397fe4a`（4.35.1）。仅支持最新版 DSH 现代 Host，当前验证版本 `0.2.0-rc.2`；删除 Host 启动及连接组装中的旧 `apiProxy` 服务分支。`HarnessClient` 的内部连接参数仍沿用 `apiProxy` 名称，值来自现代网关适配器，不会查询旧宿主服务。

11 个渠道已接入共享决定机制，复用原有审批队列、会话绑定、发送路径和飞书卡片。Web/Host 发起时只向唯一可确认的同步私聊提供审批；有多个私聊或存在无法确认的绑定时只提醒到 Web 处理。Matrix 补齐真实 `direct:dm:` 会话键与投递目标的转换。Slack／Discord 从平台私聊信息获取审批人，拒绝把 channel id 当作用户 id；Slack Manifest 增加 `im:read`，旧应用缺少该权限时退回 Web 入口。iMessage、email、AI Office 保留原有入口。

自动测试覆盖 Web/IM 任一端先批准或拒绝、不可用端退出竞争、整轮取消与独立审批信号、PTC 操作参数解析、绑定失效及权限变化、真实 actor 校验、运行时停止和发送失败。11 个渠道的投递路由都有适配器回归；Slack、Discord、Matrix 另有实际 Runtime 到既有审批队列再到入站回复的测试。其余渠道沿用既有入站审批回归。自动测试不等同于全部平台实机验证。

真实本机验收使用最新版桌面 DSH `0.2.0-rc.2` 和飞书机器人“今天是牢梁”，只执行标记文件写入：

| 场景 | 结果 |
| --- | --- |
| Web 发起，飞书批准 | 两端都出现同一 bash 操作；飞书卡片变为已批准，Web 审批撤销；工具继续执行并读回 `ISSUE283_WEB_IM_APPROVED`，turn 正常完成 |
| 飞书发起，Web 拒绝 | 飞书卡片变为已拒绝；目标文件未创建；模型返回 `ISSUE283_REJECTED` 并正常结束 |
| 拒绝后在飞书迟到回复“批准” | 返回“该审批已处理，无需再次回复。”；会话仍停在原 turn/end，没有新轮次和第二次决定 |

Host 审计共两条 `approval/asked`，各对应且仅对应一条 `approval/decided`（`allowed-once`、`rejected`），两个 turn 都以 `completed` 结束。验收记录保存在 `output/issue-283-live/result.json`。没有变更默认访问模式、机器人凭据或私聊绑定；临时插件软链接已恢复。其余 10 个渠道没有进行真实账号测试；PTC 的专项验证目前为自动测试。

最终检查：`npm run check` 成功（3,754 项全部通过，包含构建、测试和包校验），`git diff --check` 无错误。实测后增加的“第二个绑定状态无法确认时不授予机器人审批权”收紧由自动回归覆盖；实测构建与最终构建的散列分别记录于验收目录。DSH 已从恢复后的原插件路径重新启动，会话空闲，默认访问模式仍为“工作区内修改”。
