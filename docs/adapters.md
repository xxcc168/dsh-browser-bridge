# 适配器维护

工具单一事实源为 tools.manifest.json。lib/runtime.js 只使用 Node 内置 API，提供 BridgeClient、参数验证、输出投影、搜索和图片文件落地；不依赖 DSH 宿主。

MCP 使用 SDK + zod 从 manifest 生成 schema；DSH 使用已安装的 dsh-tools/schemastery 编译 schema；CLI 的 call 命令接受同样的 JSON。DSH 原生 schema 不支持的数字/数组边界由共用 validate 在执行前校验。

添加工具时同时更新 manifest、bridge 路由及扩展动作，并加入语义测试。适配器无需重复手写工具注册。只有 status/tabs/request_status 声明 MCP readOnlyHint；页面读取也会建立控制会话。manifest.concurrencySafe 表示读操作可以重叠，真正的写串行保障位于 bridge。eval 永远按写操作处理。

BridgeClient 自启采用 single-flight；认证或服务身份失败不会误判成端口空闲；子进程退出指数退避，每 5 秒检查服务。三份适配器使用相同令牌、deadline、取消、只读重试策略。DSH/CLI 截图落地文件，MCP 返回图片内容块。

CLI 完整调用：
```powershell
node examples/cli.mjs call browser_extract --file args.json
node examples/cli.mjs call browser_batch --file workflow.json
```
脚本编排时按 JSON 解析结果，不使用文本“已成功”推断状态。用户输入可通过 --file 传入，避免 shell 引号问题。

验证：
```powershell
npm run check
npm test
```

测试覆盖实际 MCP 握手、DSH 注册、共享传输与模拟 WebSocket。真实浏览器操作、长时睡眠恢复需要另做验收，不能用单纯语法检查替代。

服务默认从仓库 bridge/ 解析，DSH bridgeDir 或 DSH_BROWSER_BRIDGE_DIR 可显式覆盖。测试和扩展源码均保存在同一项目，根 package.json/package-lock.json 是唯一依赖入口；bridge/package.json 仅隔离 CommonJS 模块格式。重定位项目后只需调整宿主 MCP 入口路径与 Chrome 加载目录。

协议 3：DSH 传递宿主 exec.agent 的映射身份。MCP 不把连接 id/requestId 当任务 id，优先使用宿主 dsh/agentId 元数据，否则要求显式 agentId。CLI 使用相同任务 UUID 跨进程保持身份。BridgeClient 自动 claim/renew，缓存键为 owner+tabId；不能跨 owner 复用 session。普通读取也会建立页面占用，concurrencySafe 仅表示读操作可重叠，不代表没有控制会话副作用。
