# Bridge 协议 3

适用于 bridge 1.3.0 / 扩展 1.2.0。HTTP 默认仅监听 127.0.0.1:8765。以下动作协议通过隔离 bridge + 模拟扩展验证；真实 Chrome 更新后还应运行本地 /test 验收。

## 请求与错误

可选请求头：Authorization: Bearer <DSH_BRIDGE_TOKEN>；X-DSH-Request-Id；X-DSH-Deadline（Unix 毫秒）；X-DSH-Session。

页面动作及会话 API 必须带 X-DSH-Owner（稳定任务凭据，16–160 位字母数字或 _ . : -）；可带 URL 编码的 X-DSH-Agent-Name。status/tabs 无需 owner。请求结果查询校验原请求 owner。不是只检查 sessionId。

所有动作都有端到端期限，默认 60 秒，上限 120 秒，包含排队和等待扩展。写队列最多 100 项；过期/取消的未发送任务不会发给扩展。已发送任务超时或断线可能已经生效，返回 state=unknown；不会自动重放。

错误返回非 2xx 和 {error,code,state?,requestId?}。常见 code：WAIT_TIMEOUT、INPUT_FAILED、AMBIGUOUS_ELEMENT、INVALID_INDEX、TAB_LEASED、SESSION_EXPIRED、CANCELLED、COMMAND_TIMEOUT、EXTENSION_DISCONNECTED、UPGRADE_REQUIRED。

相同 requestId 和相同请求返回原结果，不重复执行；参数不同返回 REQUEST_ID_CONFLICT。结果缓存约 5 分钟/1000 条；服务重启清空。成功对象响应带 requestId，数组仍为数组并通过响应头给出 id。

## 状态与标签页

GET /api/status 返回 ok、version、protocolVersion、instanceId、connected、extension、lastHeartbeatAt、heartbeatAgeMs、reconnects、uptimeSec、pending、queuedWrites。connected 基于 socket 与心跳，不只是 readyState。

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
- wait：selector、timeout（1–30000ms）、state（attached/visible/enabled/hidden/detached）、contains。超时失败，不滚动。
- evaluate：expression、max，await Promise，按写操作串行；CSP 限制仍有效。
- frames：列出可注入 frame 的 frameId/documentId/url/title。
- screenshot：激活目标并捕获可见区域，返回 dataUrl；MCP 渲染 image，DSH/CLI 保存文件。

定位支持 CSS，以及 >>> 穿透 open shadow、text=、label=、placeholder=、role=button[name="名称"]。这是明确的 DOM 定位子集，不是完整可访问性树实现。

## 流程与租约

POST /api/tabs/:id/batch：{steps:[{action,...}],maxOutput?,timeout?}。HTTP 总时限由 X-DSH-Deadline 控制；适配器把 timeout 转为该头。最多 20 步，连续执行；失败返回 HTTP 422，含 failedStep、completedSteps、state、error、code。成功返回 steps；超输出预算的步骤结果使用 omitted 标记。动作不回滚。

POST /api/sessions：action=acquire 时 tabId 必填；renew 接受 sessionId 或 sessionIds 数组；release 接受 sessionId。owner 必须匹配。租约固定 60 秒，续租不重置最后页面活动时间，120 秒空闲且无执行中动作则停止回收。正常动作可自动原子申请，无需 agent 每次手工 acquire。

冲突在请求入队前立即返回 TAB_OCCUPIED。手动停止后的同 owner 返回 CONTROL_STOPPED；旧凭据返回 SESSION_EXPIRED/CONTROL_REVOKED。取消、失联、过期须经扩展撤销确认；存在未结束脚本时保留 stopping，不直接删除租约。

GET /api/tabs 的 control 字段提供 agentName/state/到期信息；不公开 owner 凭据。扩展通过独立的 control/controlAck 消息安装/撤销控制权，通过 userStop/userAllow 消息处理用户操作。没有面向 agent 的强制抢占接口。

GET /api/requests/:requestId：查询 queued/dispatched/succeeded/failed/unknown/cancelled。大结果以 resultPreview/truncated 返回。已经发送但结果未知的写操作，先核验页面再决定恢复。

## 扩展连接

扩展使用 15 秒心跳，45 秒未收到有效响应主动重连；另用 Chrome alarm 恢复连接。显式重连关闭旧 socket。每个响应绑定接收请求的 socket；请求 id 与短期结果缓存降低重连重复执行风险。多个扩展同时连接时新连接替换旧连接；不支持多个 Chrome 共享同一连接身份。

## 本地验收

GET /test 是桥接自带测试页。只在该页进行 type #box → click #btn → extract #result；应得到 clicked: 输入内容。缺失 selector 的 wait 必须返回错误。真实验收前确认 extension.protocolVersion=3。另验证不同 agentId 同页抢占立即失败，手动停止取消旧队列，旧任务不能自动重占。
