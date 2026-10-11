# Issue 316 全渠道归档会话提示与阻塞反馈方案

日期：2026-10-04。状态：已实施，自动化及飞书实机验收通过。基于 dsh-im `4.35.0`、提交 `0406fd5`；修复将随下一个版本发布。

关联反馈：[Issue 316](https://github.com/xmanrui/dsh-im/issues/316)、[Issue 269](https://github.com/xmanrui/dsh-im/issues/269)。

已在共享 Harness 客户端识别归档状态，并通过现有错误机制反馈给所有渠道。保持原会话绑定，由用户选择取消归档或执行 `/new`。生产源码改动集中在共享客户端、错误映射和英文文案三个文件，另更新 `lib/index.js` 构建产物。

**用户可见行为**

| 场景 | 处理结果 |
| --- | --- |
| 绑定的会话已归档，再发普通消息、图片、文件或提交批量输入 | 提示会话已归档，停止本次提交，原绑定保留 |
| 检查通过后才发生归档，Host 拒绝加载或提交 | 复查归档状态，确认后提示归档；保留底层错误供诊断 |
| 提交后因归档产生 `blocked`，没有本次 `user/message` | 从持久化事件发现阻塞后复查归档，确认后结束等待并提示，不等完整回复超时 |
| 已确认属于本次请求的轮次以 `blocked` 结束 | 复用已有 `turn-blocked → TURN_BLOCKED` 错误路径；确认归档时细化为归档提示 |
| 用户取消归档 | 下一条消息重新查询状态，继续使用原绑定 |
| 用户主动发送 `/new` | 沿用现有新建和绑定逻辑 |

归档提示为：

> 当前会话已归档，无法继续处理。请在 DSH 中取消归档，或发送 /new 创建新会话。

如果 Host 已确认接收消息，再追加：

> 本条消息可能仍在会话队列中，请先到 DSH 查看状态，避免重复提交。

通用阻塞提示调整为：

> 本轮处理被阻止，未能完成。请在 DSH 中查看会话状态和相关提示。

各渠道继续附带现有错误码和 `MF-…` 参考号，面板使用同一份 `lastMessageError`。不自动创建、切换、恢复会话，也不自动重发消息。

**现有原因和复用位置**

- `askInWorkspaceSession()` 在绑定存在时调用 `sessionExists()`，只有不存在才创建会话。修复前的存在性检查读取 `session.history`，没有先识别归档。
- `workspace.list` 已提供 `archivedSessionIds`，现有会话列表和绑定功能都在使用。现代 Host 的适配层通过 `workspace.follow` 的 baseline 提供同样的字段，业务层仍调用现有 `rpc('workspace.list')`。
- `HarnessReplyTracker` 以 `user/message.source.rpcId` 确认回复归属。归档门禁在写入该消息前拒绝执行时，追踪器不会认领 `turn/end(blocked)`。
- 已有 `HarnessTurnError`、`harnessTurnError()`、`TURN_BLOCKED`、`setLastMessageFailure()` 和渠道失败收尾流程，可以直接复用。

最小复现已经确认：输入 `turn/start → turn/end(blocked)` 时，当前追踪器返回 `finished=false、turn=null、reason=null`；补入匹配的 `user/message` 后才正常识别结束。这里验证的是插件追踪逻辑，报告中的 Windows 压缩文件问题尚未实机验证。

**共享客户端的修改**

文件：`src/channels/shared/harness-client.mjs`。

1. 增加一个内部归档查询方法，调用现有 `workspace.list`，校验 `archivedSessionIds` 后按 `sessionId` 判断。沿用现有 RPC 超时和 `signal`；不读取本地归档文件，不根据 `corrupt` 文本猜测，不新增缓存或后台订阅。接口失败或字段异常要保留错误，不能当作“未归档”。
2. `sessionExists()` 先查归档。命中时返回 `true`，跳过可能无法读取的 `session.history`；未命中时保留原有历史读取和不存在判断。若历史读取被 Host 拒绝，再复查一次归档，以覆盖两次调用之间发生归档的情况；确认归档仍返回 `true`。只有原有的明确不存在条件才返回 `false`。
3. `ask()` 在读取初始历史、暂存附件、打开交互监听之前检查归档。确认归档就抛出带 `code: 'session-archived'` 的普通错误，按仓库现有错误工厂风格实现，无需新增错误类或会话状态对象。
4. 初始历史读取、后续历史读取或 `session.prompt` 遭到 Host 内部拒绝时，复查一次归档；确认后转换为 `session-archived` 并保留原错误为 `cause`。未确认或复查失败时保留原异常。取消、网络超时、鉴权、模型和附件等已明确分类的错误继续走现有处理，不被归档诊断覆盖。
5. 在现有历史轮询中补上下面的阻塞复查逻辑。继续复用现有 `catch/finally` 关闭交互监听和释放控制权。

这样 `workspace-session.mjs` 和工作区作用域代理都无需新增方法。归档仍表示“会话存在，但当前不可继续处理”，不会触发现有的自动创建分支，也不会把归档历史查询一概禁止。

正常的已绑定消息会增加两次元数据读取：存在性检查一次、`ask()` 一次。先接受这个有限成本，避免为省一次调用引入跨方法缓存和失效逻辑；等待回复期间不增加固定频率的归档查询。

**阻塞反馈和请求归属**

保留 `HarnessReplyTracker` 现有的归属规则。不能把“提交之后看到的第一个 `turn/start` 或 `blocked`”直接当作本次请求，否则 Web 和多个机器人共用会话时会串轮次。

在 `ask()` 的现有历史轮询中处理两种情况：

- 已匹配本次 `user/message`：沿用正常完成判断。遇到本次 `blocked` 时复查归档，确认后返回归档错误，否则保留 `HarnessTurnError('turn-blocked')`。已完成的成功轮次优先按成功交付。
- 尚未匹配本次 `user/message`：在本次请求的 `baselineSeq` 之后发现新的持久化 `turn/end(blocked)`，仅把它作为归档复查的触发条件。确认当前会话归档后，抛出会话级归档错误；不设置 `tracker.turn`，也不认领该轮次的回答、附件或审批。

用 `ask()` 内一个局部的已检查阻塞序号避免同一事件每 300 毫秒重复触发查询，不建立新的追踪器或状态机。只使用持久化历史，沿用当前对 mux 断线和重放的处理。

首次阻塞复查失败或未确认归档时，继续原等待逻辑；在现有超时出口再复查一次归档。仍无法确认时保留原超时诊断。这种情况不能承诺立即给出归档提示。

归档错误继承实际的 `promptAccepted` 状态。没有本次轮次归属时不把 `turnFinished` 置为真，不调用取消整个会话或清空队列，也不提前删除 Host 可能仍要读取的暂存附件。复用现有收尾规则，避免将“停止等待”误当成“Host 已撤销消息”。

本方案覆盖 Issue 316 的无消息归档阻塞，以及已有归属的通用阻塞。对于“无请求标识、未确认归档”的其他阻塞事件，保持原有等待和超时机制；现有协议仅凭该事件无法可靠判断它属于哪个请求。要让这类事件也立即准确失败，需要 Host 提供请求关联证据，本次不扩展协议。

**错误提示和多语言**

文件：`src/channels/shared/message-failure.mjs`、`src/channels/shared/i18n-en/shared-a.mjs`。

- 新增 `session-archived → SESSION_ARCHIVED` 映射及上述中英文文案。
- 对归档错误复用现有 `promptAccepted` 信息，在明确已接收时追加队列提示，不承诺消息已取消。
- 调整现有 `TURN_BLOCKED` 文案，避免把所有阻塞解释成“正在等待某个操作”。
- 沿用错误参考号、日志诊断、`lastMessageError` 和面板展示，不增加新的 UI 状态或错误上报通道。

底层 `corrupt` 的加载问题仍由 Host 负责修复。插件通过权威归档元数据避免误导提示；未确认归档的真实存储错误要保留原诊断。

**全渠道覆盖**

当前 13 个消息渠道均进入共享 Harness 客户端，并已有统一错误展示路径。

| 入口 | 渠道 | 复用方式 |
| --- | --- | --- |
| 各自 Bridge | 微信、飞书、钉钉、QQ、企业微信机器人、企业微信自建应用 | `askInWorkspaceSession()`、共享 Harness 客户端、现有错误回复和卡片收尾 |
| `TextHarnessBridge` | Telegram、WhatsApp、Slack、Discord、Matrix、iMessage、邮箱 | 共享文本 Bridge、共享 Harness 客户端、现有错误回复和流式收尾 |

覆盖普通消息、图片、文件及最终进入相同提交路径的批量输入；私聊、群聊和话题沿用各渠道已有能力。生产代码不逐渠道复制归档判断。渠道验收需要检查错误是否实际可见、处理中状态是否结束、绑定是否保留。

**实施和验证**

先完成三个共享生产文件及聚焦测试，再复用各渠道现有 fixture 做错误投递验收。只有验收暴露渠道自身收尾缺口时才做局部修补。

| 验证重点 | 必须验证的结果 |
| --- | --- |
| 归档会话的存在性 | 返回存在，跳过历史读取，不调用创建或改绑 |
| 提交前已归档 | 抛出归档错误，不提交 prompt、不暂存文件、不打开交互监听 |
| 检查之后发生归档 | 加载或提交被拒后复查命中，错误变为归档且原始 cause 保留 |
| 无 `user/message` 的归档阻塞 | 在短测试期限内退出，不等待回复超时，不错误认领轮次 |
| 有归属的普通阻塞 | 返回 `TURN_BLOCKED`，不显示成功、不作为后台超时任务登记 |
| 其他请求和旧历史 | baseline 前的 blocked、其他请求的 blocked 不结束本次未归档请求 |
| 接口异常与真实损坏 | 查询失败不等同于归档或未归档；未确认归档的原始错误保留 |
| 恢复与用户命令 | 取消归档后原绑定正常使用；用户 `/new` 行为保持原样 |
| 收尾与语言 | 已接收消息保留接收语义；监听释放；中英文文案、错误码、参考号和面板一致 |

聚焦算法测试放入 `test/session-archive.test.mjs`，直接验证共享 `ask()` 的归档、竞态、请求归属、错误保留和清理行为。复用 `test/history-bridge.test.mjs` 中的渠道 fixture，为 13 个渠道分别验证归档及普通阻塞错误可见、状态一致、绑定不变；共享流式收尾放入 `test/channels/shared/text-harness-bridge.test.mjs`。原有追踪器无需修改。

同时覆盖现有进程内 API 和 HTTP 调用方式，以及现代 Host 的 `workspace.follow` baseline 到 `workspace.list` 的转换。旧 Harness fixture 补齐已有协议中的 `archivedSessionIds: []`，不放宽生产代码的元数据校验。

最终 `npm run check` 通过：3,697 项测试全部成功，构建和发布包校验通过；`git diff --check` 通过。完整记录为 `output/issue-316-live-20261004/final-check-retry.log`。复核前一轮曾遇到现有 `feishu-operation.test.mjs` 中 100 毫秒 SDK 等待测试因请求尚未到达本机端点而失败；该文件单独重跑 3 项全通过，随后未经代码调整的全量复跑也全部通过，未为此修改生产代码或测试时限。

**2026-10-04 本机飞书验收**

本机 Desktop 的 `@xmanrui/dsh-im` 使用当前仓库的链接安装。完成构建后重启 Desktop，使用飞书机器人“今天是牢梁”私聊测试。实测构建的 `lib/index.js` SHA-256 为 `d2c7f0a2d573acf7ceb6e1e5c353b0247d17a0ef5655db0d9a486491aa79363d`。

| 步骤 | 实际结果 |
| --- | --- |
| `/new` 后发送基线消息 | 收到 `ISSUE316_BASELINE_OK`，绑定 `session-3f975158-5353-4635-9231-5c197da4f498` |
| 在 Desktop 归档上述测试会话 | UI 显示归档成功；`workspace` 元数据包含该会话，飞书绑定仍指向它 |
| 发送 `ISSUE316_ARCHIVED_CHECK_1` | 收到归档说明、`SESSION_ARCHIVED` 和参考号 `MF-81C07B28`；处理中卡片已收尾 |
| 再发 `ISSUE316_ARCHIVED_CHECK_2` | 再次收到归档说明、`SESSION_ARCHIVED` 和参考号 `MF-26834962` |
| 比较两条失败消息前后的状态 | 所有会话绑定相同，归档会话日志大小和 SHA-256 均未变化，没有把消息提交进原会话 |
| 用户命令 `/new` 后发送恢复验证消息 | 新绑定为 `session-774f77a0-a35a-40cc-accf-af55fa4050db`，收到 `ISSUE316_NEW_OK`；旧测试会话仍保持归档 |

归档前后会话日志均为 17,219 字节，SHA-256 为 `08992c13911c49790c976a935dfdf0ed0fa0b9106fcd6750f4b014ba96c7909a`。原始状态记录位于 `output/issue-316-live-20261004/archived-before.json`、`archived-after.json` 和 `new-session-after.json`。实机覆盖的是提交前已归档场景；提交竞态和无 `user/message` 的 blocked 场景由自动化测试覆盖，不冒充实机复现。未尝试修复或复现 Windows Host 的 zstd 存储问题。
