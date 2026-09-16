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
| `npm run icons` | 用内置编码器生成 extension/icons 下的三个 PNG |

MCP 宿主直接执行 `node <项目绝对路径>/examples/mcp-server.mjs`。不要通过 npm 向 stdio 注入命令日志。长期共享时可独立启动 bridge；若由某个适配器自启，该适配器退出可能停止其子服务。

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

## 故障定位

- 无法连接：先检查 Node、已有依赖与端口占用。不要因认证失败或端口已有其他服务而反复拉起进程。
- connected=false：确认扩展已启用，弹窗中的服务地址/令牌一致；不要加载两个相同桥接扩展。
- TAB_OCCUPIED：另一个任务占用页面。完成后主动 release，或等待租约/空闲回收；用户可通过页面提示或扩展弹窗停止控制。
- CONTROL_STOPPED：用户终止了旧任务，agent 不应自动换身份抢回。用户可点击“允许旧任务”恢复资格。
- stopping：有尚未结束的脚本，系统等待结束或确认 document 替换后才交接。停止不会撤销已经发生的业务副作用。
- 磁盘升级但行为未变化：检查服务进程和 MCP 是否已重启、Chrome 是否已重新加载正确目录。

仓库忽略依赖、产物、环境文件和本机 npm 配置，保留扩展 PNG 图标。Git 初始化不会产生提交；提交和推送须由用户明确授权。
