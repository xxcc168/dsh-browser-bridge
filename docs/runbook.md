# 本机运行与迁移

项目根目录包含完整源码，默认不依赖项目外的服务或插件副本。运行要求 Node 22+、Chrome 120+。扩展直接加载 extension/，无需构建。新环境需在允许安装依赖后从根 lockfile 执行 npm ci；复制源码不等于已配置好浏览器登录状态。

## 常用命令

在项目根目录运行：

| 命令 | 用途 |
|---|---|
| `npm start` | 前台独立运行共享服务，默认 127.0.0.1:8765 |
| `npm run cli -- status` | 检查服务、扩展协议、连接和占用 |
| `npm run check` | 所有源码语法检查、工具注册与目录完整性检查 |
| `npm test` | 隔离端口运行行为与 MCP 集成测试，不操作用户页面 |
| `npm run test:native-browser` | 用已安装 Chromium、临时配置与随机端口运行原生弹窗验收，不下载浏览器、不接入共享 8765 |
| `npm run test:live-browser` | 发布前显式验收现有 Chrome/MCP：仅新建本地测试页，检查 27 个工具、真实弹窗、五分钟保持和固定公开搜索；截图/报告写入忽略的 .verify/ |
| `npm run icons` | 用内置编码器生成 extension/icons 下的三个 PNG |

MCP 宿主直接执行 `node <项目绝对路径>/examples/mcp-server.mjs`。不要通过 npm 向 stdio 注入命令日志。长期共享时可独立启动 bridge；若由某个适配器自启，该适配器退出可能停止其子服务。

真实发布验收需先重载正确路径的扩展并手动启用原生观测，确保没有其他受控浏览器任务。`test:live-browser` 实际等待 300 秒，不加速时钟，不会自动开启观测或接受权限请求；只关闭自己创建的标签页，不停止共享服务。公开搜索仅发送固定测试词，不发送业务内容。失败时不要推送，检查 .verify/live-release-result.json；外网搜索不可用也会导致该完整验收失败。

## 配置

| 配置项 | 默认与用途 |
|---|---|
| DSH_BROWSER_BRIDGE_DIR / DSH bridgeDir | 留空：使用同项目 bridge/；仅在显式外接核心时覆盖 |
| DSH_BRIDGE_URL | HTTP 地址；通常 http://127.0.0.1:8765 |
| DSH_BRIDGE_PORT | 独立服务监听端口，默认 8765；自启根据 URL 同步端口 |
| DSH_BRIDGE_AUTOSTART | 适配器默认 true；独立管理服务时可设 false |
| DSH_BRIDGE_TOKEN | 可选认证令牌；客户端、服务和扩展需一致，不能写入仓库 |
| DSH_AGENT_ID | 仅单任务专用进程可设置；多任务共享 MCP 应逐调用提供 agentId |
| DSH_BRIDGE_ARTIFACT_DIR | DSH/CLI 截图目录，默认系统临时目录下 dsh-browser-bridge |

端口或令牌改变时同步扩展弹窗配置。只监听本机，不开放公网。

## 更新和路径迁移

1. 等待 pending、queuedWrites、controlledTabs 为 0，再重启已确认属于本项目的服务。
2. 项目路径改变后，更新宿主 MCP args。默认自动查找项目内 bridge，无需额外核心路径配置。
3. Chrome 打开 chrome://extensions：移除旧路径的 DSH Browser Bridge，再“加载已解压的扩展程序”选择新项目的 extension/。同端口仅保留一个扩展实例。
4. 重连宿主 MCP（DSH 必要时重启 host），再执行 status。bridge.protocolVersion 和 extension.protocolVersion 都应为 3，connected 应为 true。
5. 需要浏览器操作回归时，仅使用 http://127.0.0.1:8765/test 测试页，按 docs/bridge-api.md 验收。

移动源码后，尚未重载的旧扩展 worker 可能暂时继续保持连接；connected=true 不能证明 Chrome 已加载新路径。

### 1.6.2 版本同步与五分钟保持

包、锁文件、工具 manifest、Chrome manifest 的版本统一为 1.6.2。运行时必须分别检查 adapterVersion、version、extension.version，不能仅看版本文件。当前对话中的 stdio MCP 在启动时加载代码，bridge 重启或扩展重载不会更新这个 MCP 进程；请在 Codex「设置 → MCP 服务器」重启唯一的 dsh_browser_bridge，或由用户在完成任务后重启 Codex。

Codex 若再次出现 dsh_browser_bridge (Codex) 重复入口，先核对两条 args 是否都指向本项目，备份配置后仅保留直接 Node 的 dsh_browser_bridge。不要保存旧设置页面里的重复配置，也不要清理其他项目或其他 MCP 配置。

controlPolicy 集中定义 leaseMs=300000、idleMs=300000、renewIntervalMs=20000。延长保持不会把每次工具请求改成五分钟，也不允许续租无限延长空闲占用或移交未结束的脚本。

### 1.6.0 原生弹窗授权报错修复

若点击启用出现 `Only permissions specified in the manifest may be requested`，这是 1.6.0 把 Chrome 禁止可选申请的 `debugger` 放入 `optional_permissions` 所致，不是用户点击错误。1.6.1 将其改为必需权限，不会代用户接受新的权限提示。

在 `chrome://extensions/` 对路径为本仓库 `extension/` 的 DSH Browser Bridge 点击“重新加载”，由用户检查并确认 Chrome 如有出现的权限提示，确认扩展版本为当前 1.6.2，再打开弹出页点击“启用原生弹窗识别”。默认开关仍为关闭；若运行清单/权限未更新，弹出页会禁用启用按钮并提示重新加载。

`npm run test:native-browser` 使用不改写权限的原始 manifest，先通过真实 popup 点击验证启用，再验证原生空白 alert、confirm、prompt、beforeunload 与停止控制，避免测试临时添加 debugger 掩盖生产授权错误。

## 故障定位

- 无法连接：先检查 Node、已有依赖与端口占用。不要因认证失败或端口已有其他服务而反复拉起进程。
- connected=false：确认扩展已启用，弹窗中的服务地址/令牌一致；不要加载两个相同桥接扩展。
- TAB_OCCUPIED：另一个任务占用页面。完成后主动 release，或等待租约/空闲回收；用户可通过页面提示或扩展弹窗停止控制。
- CONTROL_STOPPED：用户终止了旧任务，agent 不应自动换身份抢回。用户可点击“允许旧任务”恢复资格。
- stopping：有尚未结束的脚本，系统等待结束或确认 document 替换后才交接。停止不会撤销已经发生的业务副作用。
- 磁盘升级但行为未变化：检查服务进程和 MCP 是否已重启、Chrome 是否已重新加载正确目录。

仓库忽略依赖、产物、环境文件和本机 npm 配置，保留扩展 PNG 图标。Git 初始化不会产生提交；提交和推送须由用户明确授权。
