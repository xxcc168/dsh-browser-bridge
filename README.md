# dsh-browser-bridge 1.5.0

统一维护 Chrome 扩展、本机 HTTP/WebSocket 服务和 MCP、DSH、CLI 入口。三个入口共用 lib/runtime.js，并从 tools.manifest.json 注册 25 个工具。

## 目录与启动

```text
dsh-browser-bridge/
  bridge/                 本地服务和独占控制管理（CommonJS）
  extension/              Chrome 加载的扩展目录
  lib/                    共享客户端与 DSH 原生入口（ESM）
  examples/               MCP、CLI 入口和 MCP 配置示例
  scripts/                语法检查、图标生成
  tests/                  行为、控制权、扩展和传输测试
  docs/                   接入、协议和运维说明
  tools.manifest.json     工具单一事实源
  package.json            全项目依赖与命令入口
```

本机项目位于 `D:\tools\dsh-browser-bridge`。在 Chrome 的 `chrome://extensions` 启用开发者模式，选择“加载已解压的扩展程序”，加载其 `extension` 子目录。迁移路径时先移除旧扩展，避免两个扩展交替连接同一服务。

在项目根目录执行 `npm start` 可独立运行共享服务；MCP 默认也能按需自启。`npm run cli -- status` 查看状态，`npm run check` 和 `npm test` 执行检查。环境与故障处理见 [运维说明](docs/runbook.md)。

本机已复用既有依赖，无需安装。新的 Git 克隆不包含 node_modules；迁移到新机器前需准备 Node 22+，并在允许安装依赖后执行 `npm ci`。扩展不需要构建；Git 克隆后可直接加载 extension。

## 版本与升级

- 适配器、bridge 和扩展版本均为 1.5.0；协议版本 3，能力标识为 `atomic-session-v1`。运行时仍会分别报告实际加载版本。
- 需要 Node 22+、Chrome 120+；继续使用现有依赖，不需要新增软件包。
- 旧工具名称保留；默认读取预算、后台打开与严格点击定位发生变化。
- 修改磁盘源码不等于运行进程已升级。重启 bridge、重载扩展并重连 MCP 客户端；DSH 接入方式见 [DSH 接入](docs/dsh-plugin.md)。
- 当前旧扩展/bridge 下，新适配器的 status/tabs 可诊断，其余动作返回 UPGRADE_REQUIRED，避免以旧实现假装完成新行为。

## MCP 配置

保留已有服务配置；示例路径应替换为本机现有位置：

```toml
[mcp_servers.dsh_browser_bridge]
command = 'C:\Program Files\nodejs\node.exe'
args = ["D:\\tools\\dsh-browser-bridge\\examples\\mcp-server.mjs"]
startup_timeout_sec = 15.0

[mcp_servers.dsh_browser_bridge.env]
DSH_BRIDGE_AUTOSTART = "true"
```

默认自动使用同项目内的 bridge，无需配置 DSH_BROWSER_BRIDGE_DIR；该变量仅用于显式覆盖服务目录。JSON 配置见 [examples/mcp.json](examples/mcp.json)，复制其中服务项并调整绝对路径，保留宿主其他配置。MCP 宿主应直接执行 node + examples/mcp-server.mjs，避免 npm 的日志混入 stdio 协议。

DSH_BRIDGE_URL 支持自定义本机端口；自启会使用此 URL 的端口。DSH_BRIDGE_TOKEN 同时用于健康检查和动作请求。401 或非桥接服务不会触发重复启动。客户端只管理自己启动的 bridge 进程，外部服务生命周期不受影响。

## 工具

| 工具 | 作用 | 调度 |
|---|---|---|
| `browser_status` | 查看服务、扩展和心跳状态 | 读取 |
| `browser_tabs` | 列出标签页；默认不返回图标 | 读取 |
| `browser_open` | 打开标签页；默认后台打开 | 串行写操作 |
| `browser_navigate` | 请求页面跳转；用 wait 确认就绪 | 串行写操作 |
| `browser_activate` | 激活标签页并聚焦窗口 | 串行写操作 |
| `browser_close` | 关闭指定标签页 | 串行写操作 |
| `browser_read` | 读取正文；默认 8000 字符，支持续读 | 读取 |
| `browser_extract` | 提取元素状态与定位信息；总预算和分页 | 读取 |
| `browser_click` | 单次点击；默认要求唯一可见匹配 | 串行写操作 |
| `browser_type` | 填写输入框；返回验证结果而不回显全文 | 串行写操作 |
| `browser_key` | 合成按键事件；不保证浏览器默认快捷键 | 串行写操作 |
| `browser_wait` | 等待元素状态；超时是错误，不滚动页面 | 读取 |
| `browser_eval` | 执行页面 JS 表达式（等待 Promise）；受 CSP 限制，按写操作串行 | 串行写操作 |
| `browser_screenshot` | 截取可见窗口；会激活标签页；MCP 返回图片 | 串行写操作 |
| `browser_search` | 浏览器搜索；失败保留页面和 tabId | 串行写操作 |
| `browser_scroll` | 滚动页面或指定容器 | 串行写操作 |
| `browser_check` | 幂等设置复选框或单选框状态 | 串行写操作 |
| `browser_select` | 精确选择原生下拉选项 | 串行写操作 |
| `browser_hover` | 向元素发送合成悬停事件 | 串行写操作 |
| `browser_frames` | 列出可注入 frame 与 documentId | 读取 |
| `browser_batch` | 连续执行最多 20 步；失败即停止并返回已完成步骤 | 串行写操作 |
| `browser_request_status` | 查询命令状态与结果；不重放请求 | 读取 |
| `browser_session` | 获取、续期或释放标签页租约 | 串行写操作 |
| `browser_session_status` | 原子查看连接、版本、标签页 generation、所有者、租约和读写能力 | 读取 |
| `browser_ensure_session` | 经扩展确认后续租或重新获取当前任务的标签页控制 | 串行写操作 |

## 输出和恢复

- 正文默认 8000 字符，不默认传输 HTML；offset/nextOffset 支持续读。
- extract 的 max 为字段序列化总预算，默认 8000；默认最多 20 项，返回 totalCount、returnedCount、truncated、nextOffset。单项 textTruncated 可改用 browser_read 的精确 selector/offset 续读。
- MCP 截图返回原生 image 内容块；DSH/CLI 将截图保存为 PNG 并返回路径，不输出 Base64 文本。DSH_BRIDGE_ARTIFACT_DIR 可设置目录，默认系统临时目录下的 dsh-browser-bridge。
- type 返回状态与字符数，不回显长文本。命令成功只说明该动作的验证范围，不等于后端业务已完成；使用 wait/read 验证页面后置条件。
- batch 最多 20 步，在 bridge 写队列中连续执行，失败停止，无业务回滚。默认输出预算 16000 字符，过量步骤结果标记 omitted。
- 页面首次使用自动申请独占控制；适配器按任务身份缓存 session，绝不按共享进程或 tabId 继承其他任务的占用。
- requestId 用于查询/去重；unknown 不能自动重放。记录保留约 5 分钟、最多 1000 项，服务重启清空；查不到记录不代表未执行。
- `browser_session_status` 是返回时的已确认快照，`canWrite=true` 只表示该时刻控制权有效；实际动作仍会在队列和扩展派发前再次确认。`browser_ensure_session` 只恢复租约，不抢占其他任务、不绕过用户停止，也不重放 unknown 动作。
- 默认 open 使用 active=false。截图和 activate 会影响焦点；hover/key 为合成事件，不承诺浏览器默认动作。
- frameId/documentId、CSS 的 >>> open-shadow 穿透、text=/label=/placeholder=/role= 可用于明确定位。closed shadow、系统对话框、CDP 后端不在此版本范围。

## 验证

```powershell
npm run check
npm test
npm run cli -- status
npm run cli -- tabs
```

测试启动随机本机端口的隔离 bridge 和模拟扩展，不修改用户标签页。真实 Chrome 验收需在扩展重载后，使用 bridge 的 /test 页面完成输入、点击、提取、等待失败和截图检查。详见 docs/bridge-api.md 与 docs/dsh-plugin.md。

## 独占控制与手动终止

页面右上角显示“任务名 正在控制此页面”，附“停止控制”按钮；扩展图标徽标和弹窗也展示状态。无法注入的保护页面使用弹窗作为操作入口。刷新/跳转后恢复提示。控制提示不进入正文/元素读取结果。

同一标签页只允许一个任务；其他任务立即收到 TAB_OCCUPIED，既不排队也不自动接管。status/tabs 可查看占用情况；read/extract/wait/frames 与写操作一样要求任务归属。服务端和扩展端都检查控制会话。

- 租约 120 秒，常驻适配器每 20 秒续租；无执行中命令且 180 秒无页面活动后回收。单纯 WebSocket 心跳不延长空闲占用。
- agent 崩溃或 CLI 进程退出后，没有续租则约 120 秒回收；CLI 连续命令通过相同任务标识恢复同一归属。
- “停止控制”先在扩展本地撤销，再通知 bridge 取消未执行命令；离线也记录停止状态。旧任务不能自动重新占用，用户可在提示条/弹窗点“允许旧任务”恢复其申请资格。
- 已注入且未结束的脚本保留“停止中”，直至结束或确认旧 document 已被刷新替换；无法确认时不自动交给其他任务。停止不回滚已发生的点击、提交或网络副作用。
- 停止状态在 Chrome storage.session 中保存，跨扩展 worker 重启恢复。浏览器整体退出不会保留控制会话。

## 调用者身份

DSH 原生入口采用宿主 exec.agent 对象区分任务。MCP 使用宿主元数据 dsh/agentId；宿主未提供时，调用参数必须含稳定且唯一的 agentId（建议任务 UUID），可附 agentName。也可用环境变量 DSH_AGENT_ID，但只能用于确实由单一任务专用的 MCP 进程。不要把不同任务配置为同一个 id。

同一任务的每次调用保持相同 agentId，例如：{"tabId":123,"selector":"#query","agentId":"task-unique-uuid","agentName":"报表核验"}。

适配器生成归属凭据；进程级命名空间防止两个 MCP 进程的同名任务被合并。MCP 进程重启后身份凭据重建，旧占用通过 TTL/用户停止回收。CLI 多次启动需设置同一个 DSH_AGENT_ID 或传 --agentId；多个 CLI 任务必须使用不同 id。

这些机制用于合作式 agent 的冲突隔离，不是针对恶意本机进程的身份认证。直接 HTTP 调用也必须携带 X-DSH-Owner；重放旧 sessionId 不能绕过其他 owner。
