# Bridge 协议 3

适用于 bridge/扩展 1.6.2。HTTP 默认仅监听 127.0.0.1:8765。请求路径与租约/队列关系见 [架构说明](architecture.md)，历史验收证据见 [发布验收记录](2026-09-30-release-validation.md)。运行中的扩展或服务更新后，仍应重新运行本地 /test 验收，不能用历史结果代替当前验证。

## 请求与错误

可选请求头：Authorization: Bearer <DSH_BRIDGE_TOKEN>；X-DSH-Request-Id；X-DSH-Deadline（Unix 毫秒）；X-DSH-Session。

页面动作及会话 API 必须带 X-DSH-Owner（稳定任务凭据，16–160 位字母数字或 _ . : -）；可带 URL 编码的 X-DSH-Agent-Name。status/tabs 无需 owner。请求结果查询校验原请求 owner。不是只检查 sessionId。

所有动作都有端到端期限，默认 60 秒，上限 120 秒，包含排队和等待扩展。5 分钟是页面控制保持时间，不是动作时限。写队列最多 100 项；过期/取消的尚未执行任务立即从队列移除并失败，不必等被弹窗暂停的 FIFO 队首恢复。已发送任务超时或断线可能已经生效，返回 state=unknown；不会自动重放。

错误返回非 2xx 和 {error,code,state?,requestId?}。以下为常见 code，不是完整枚举：

| code | 含义与处置 |
|---|---|
| AGENT_ID_REQUIRED | 缺少稳定任务身份；为同一任务的调用提供一致 agentId，不共享其他任务的身份 |
| TAB_OCCUPIED | 其他任务占用页面；在入队前拒绝，不排队接管，不换身份抢占 |
| CONTROL_STOPPED | 用户已停止该任务；须由用户允许恢复，agent 不得绕过 |
| CONTROL_STOPPING | 旧操作尚未结束或撤销尚未确认；等待实际 drain，不能仅按到期时间交接 |
| SESSION_EXPIRED、CONTROL_REVOKED | 旧控制会话失效；先查询 session status，仅在允许时 ensure，不重放旧动作 |
| NATIVE_DIALOG_OPEN | 已观测到原生弹窗；查询最新 dialogId，确认用户意图后显式处理 |
| PAGE_SCRIPT_BLOCKED | 页面脚本探测未响应，原生弹窗状态可能未知；人工核验，不伪造类型或无弹窗结论 |
| STALE_DIALOG、DIALOG_UNOBSERVED | 弹窗 ID 过期或调试观测不可用；重新查询状态，无法可靠观测时由用户处理 |
| WAIT_TIMEOUT、INPUT_FAILED | 等待条件未满足或输入未通过验证；核验页面后置条件，不视为业务成功 |
| AMBIGUOUS_ELEMENT、INVALID_INDEX | 定位不唯一或索引无效；读取元素后修正定位 |
| REQUEST_ID_CONFLICT | 同一请求 ID 对应不同请求；检查原参数和记录，不以换 ID 自动重放未知写请求 |
| CANCELLED、DEADLINE_EXCEEDED、COMMAND_TIMEOUT、EXTENSION_DISCONNECTED | 取消、超时或断线；按 state 判断，unknown 须查询原 requestId 并核验页面 |
| QUEUE_FULL | 写队列或请求记录已满；降低并发，先确认已有请求状态 |
| UPGRADE_REQUIRED、EXTENSION_UPGRADE_REQUIRED | 运行中的版本或能力不足；重启服务与适配器、重载扩展后核验 |

适配器将 Node DOMException 的数字旧式错误码规范为 DEADLINE_EXCEEDED/CANCELLED 等字符串，保留原始 cause。客户端先超时、未收到桥接确认的写请求仍是 unknown，即使它可能还在队列中；必须按 requestId 查询。只有桥接确认 state=cancelled 才能判断该排队动作未执行，不通过更换 requestId 自动重放。

相同 requestId 和相同请求返回原结果，不重复执行；参数不同返回 REQUEST_ID_CONFLICT。结果缓存约 5 分钟/1000 条；服务重启清空。成功对象响应带 requestId，数组仍为数组并通过响应头给出 id。

### 不同时间限制

| 限制 | 默认值与边界 |
|---|---|
| HTTP 动作期限 | 默认 60000ms，上限 120000ms；X-DSH-Deadline 为绝对 Unix 毫秒，包含排队、连接等待与执行 |
| 等待扩展连接 | 默认 12000ms，可由 DSH_BRIDGE_WAIT 调整；不突破 HTTP 动作期限 |
| 等待扩展命令结果 | 默认 30000ms，可由 DSH_BRIDGE_TIMEOUT 调整；wait 还至少预留其 timeout + 500ms，最终受剩余 HTTP 期限约束 |
| 页面 wait 条件 | 默认 10000ms，参数范围 1–30000ms；不是 HTTP 总期限 |
| 控制保持 | 租约与空闲均为 300000ms，续租间隔 20000ms；续租不延长空闲上限，不把单次调用延长为五分钟 |

## 状态与标签页

GET /api/status 返回 ok、version、protocolVersion、instanceId、connected、extension、capabilities、connectionGeneration、expectedExtensionVersion、lastHeartbeatAt、heartbeatAgeMs、reconnects、uptimeSec、pending、queuedWrites，以及 controlPolicy（leaseMs=300000、idleMs=300000、renewIntervalMs=20000）。connected 基于 socket 与心跳，不只是 readyState。

GET /api/tabs 返回数组，字段 id/windowId/index/title/url/active/pinned/status，默认没有 favicon。GET /api/tabs/active 返回最后聚焦窗口的活动标签页。

POST /api/tabs 接收 {url,active?,windowId?}，active 默认 false。DELETE /api/tabs/:id 关闭标签页。POST /api/tabs/:id/navigate 接收 {url}，只说明导航请求已接受，用 wait 验证就绪。

## DOM 动作

路径为 /api/tabs/:id/<action>。GET：content、extract、frames、screenshot；其他使用 POST。参数定义以 tools.manifest.json 为准。frameId 可指定 frame；批量步骤也可传 documentId/expectedUrl 防止定位到已更换页面。

- content：maxText 默认 8000、offset 默认 0，可传 selector。返回 text、totalChars、offset、truncated、nextOffset。HTTP 显式 maxHtml 才提取 HTML。
- extract：selector、max 默认 8000、limit 默认 20、offset 默认 0。返回 items、totalCount、returnedCount、truncated、nextOffset。items 保留 id/className/href/text/value/checked/visible/enabled（适用时）。单项文本可能截断，使用精确 read 续读。
- click：selector 或精确 text，默认唯一可见匹配，index 必须有效；只触发一次 click。
- type：selector 可省略以使用焦点，text、clear。验证输入，返回 typed/verified/length；contentEditable 仅返回插入结果，verified=false。
- check：selector、checked，幂等设置；radio 不支持直接取消，选同组其他项。
- select：selector，value/label/index 三选一，精确匹配原生选项。
- hover：selector，合成悬停事件。
- key：key、modifiers，合成按键事件，不保证 Tab/快捷键默认行为。
- scroll：dx/dy/selector；有 selector 和位移则滚容器，仅 selector 则滚到元素。
- wait：selector、timeout（默认 10000ms，范围 1–30000ms）、state（attached/visible/enabled/hidden/detached）、contains。超时失败，不滚动。
- evaluate：expression、max，await Promise，按写操作串行；CSP 限制仍有效。
- frames：列出可注入 frame 的 frameId/documentId/url/title。
- screenshot：激活目标并捕获可见区域，返回 dataUrl；MCP 渲染 image，DSH/CLI 保存文件。

定位支持 CSS，以及 >>> 穿透 open shadow、text=、label=、placeholder=、role=button[name="名称"]。这是明确的 DOM 定位子集，不是完整可访问性树实现。

## 流程与租约

### 原生弹窗

用户在 Chrome 加载/重新加载扩展时确认 `debugger` 必需权限，再在扩展弹出页手动启用观测后，仅受控标签页订阅 `Page.javascriptDialogOpening/Closed`。该权限不可作为 optional 权限请求；权限获准不等于观测启用。`GET /api/tabs/:id/dialog` 不注入页面，返回 `observation / reason / known / blocked / active`；active 含最新 id、type、message、blank、defaultPrompt、openedAt。文本有长度预算。known=false 表示未可靠观测，不等于没有弹窗。

`POST /api/tabs/:id/dialoghandle` 接收 `{dialogId,accept,promptText?}`，accept 必须为布尔值，dialogId 非空且不超过 128 字符，promptText 仅用于 prompt 且最多 2000 字符。旧 ID 返回 STALE_DIALOG；已停止/其他任务无权处理。仅此恢复动作可以绕过被原生弹窗挂起的写队列，其他写操作继续 FIFO，仍经当前 owner/lease 确认。没有通用 CDP 命令入口。

已知弹窗阻止 DOM 动作并返回 NATIVE_DIALOG_OPEN；关闭弹窗不会伪造原操作完成或清空 runningControls。未在观测前捕获的弹窗可能仅表现为只读探测未响应，返回 PAGE_SCRIPT_BLOCKED 与 known=false/blocked=true，须人工核验。没有权限、调试器占用或断开都返回明确原因。session status 即使在停止/冲突时也包含阻塞摘要；非有效所有者看不到消息/默认回复正文。canRead/canWrite 表示控制权，不保证页面未被原生弹窗阻塞，还须检查 pageBlocked。

POST /api/tabs/:id/batch：{steps:[{action,...}],maxOutput?,timeout?}。HTTP 总时限由 X-DSH-Deadline 控制；适配器把 timeout 转为该头。最多 20 步，连续执行；失败返回 HTTP 422，含 failedStep、completedSteps、state、error、code。成功返回 steps；超输出预算的步骤结果使用 omitted 标记。动作不回滚。

POST /api/sessions：action=acquire 时 tabId 必填；renew 接受 sessionId 或 sessionIds 数组；release 接受 sessionId。owner 必须匹配。租约固定 300 秒，续租不重置最后页面活动时间，300 秒空闲且无执行中动作则停止回收。正常动作可自动原子申请，无需 agent 每次手工 acquire。其他 owner 与已被用户停止的 owner 在等待 revoke 确认前立即拒绝；同一 owner 也必须等实际旧操作 drain，不能自动越过停止隔离。

POST /api/sessions：action=status 返回经当前扩展确认的单次快照，包括 connected、版本、tabGeneration、controlGeneration、currentOwner、剩余租约、canRead、canWrite、reacquireAllowed 和 recovery。status 不续租。action=ensure 只在无其他有效所有者、无未结束脚本且未被用户停止时确认续租或重新获取；不抢占、不重放动作。

冲突在请求入队前立即返回 TAB_OCCUPIED。手动停止后的同 owner 返回 CONTROL_STOPPED；旧凭据返回 SESSION_EXPIRED/CONTROL_REVOKED。取消、失联、过期须经扩展撤销确认；存在未结束脚本时保留 stopping，不直接删除租约。

GET /api/tabs 的 control 字段提供 agentName/state/到期信息；不公开 owner 凭据。扩展通过独立的 control/controlAck 消息安装/撤销控制权，通过 userStop/userAllow 消息处理用户操作。没有面向 agent 的强制抢占接口。

GET /api/requests/:requestId：查询 queued/dispatched/succeeded/failed/unknown/cancelled。大结果以 resultPreview/truncated 返回。已经发送但结果未知的写操作，先核验页面再决定恢复。

## 扩展连接

扩展使用 15 秒心跳，45 秒未收到有效响应主动重连；另用 Chrome alarm 恢复连接。显式重连关闭旧 socket。每个响应绑定接收请求的 socket；请求 id 与短期结果缓存降低重连重复执行风险。多个扩展同时连接时新连接替换旧连接；不支持多个 Chrome 共享同一连接身份。

## 本地验收

GET /test 是桥接自带测试页。只在该页进行 type #box → click #btn → extract #result；应得到 clicked: 输入内容。缺失 selector 的 wait 必须返回错误。真实验收前确认 extension.protocolVersion=3。另验证不同 agentId 同页抢占立即失败，手动停止取消旧队列，旧任务不能自动重占。
