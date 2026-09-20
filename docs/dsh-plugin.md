# DSH 插件维护

推荐通过 DSH 的 @deepseek-ai/dsh-mcp-client 连接本项目 examples/mcp-server.mjs；当前本机 web profile 使用这一方式。共享 25 个工具，不需要在 profile dependencies 中再安装旧版原生插件。宿主缺少任务元数据时，调用者仍须按 README 传稳定 agentId。

在 profile 的 cordis.patch.yml 合并以下条目，保留其余配置，并把路径改成本机项目路径：

```yaml
- insert:
    - id: mcp-browser-bridge
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: browser_bridge
        command: node
        args:
          - 'D:\tools\dsh-browser-bridge\examples\mcp-server.mjs'
        env:
          DSH_BRIDGE_AUTOSTART: 'true'
```

原生接入仍由 lib/index.js 导出，适用于已集成 Cordis 的宿主；配置保留 bridgeDir、port、autoStart、requestTimeoutMs、searchEngine、searchMaxResults。若选择此方式，应使用完整项目包（含 bridge、extension、lib、manifest），不能只复制 index.js；同一 profile 不要同时注册原生和 MCP 两份工具。默认 bridgeDir 留空即可解析项目内服务。本次整理未安装任何新依赖。

运行中的 DSH 可能仍缓存旧模块。MCP 客户端也需重连进程，Chrome 扩展必须重载，bridge 必须重启。使用 browser_status 确认 bridge.protocolVersion=3、extension.protocolVersion=3，再执行动作。

状态请求支持 DSH_BRIDGE_TOKEN。自启从配置端口建立 URL，并把相同端口传给子进程。客户端只管理自己启动的服务，退出可能影响复用它的其他客户端；需要长期共享时建议由独立本机管理者启动 bridge。

输出：文本采用结构化短 JSON；截图保存 PNG 并返回 imagePath，不把 Base64 文本发送到模型。通过 DSH_BRIDGE_ARTIFACT_DIR 配置截图存放目录。控制权按 exec.agent 对象身份映射到独立 owner；同一任务可自动续用会话，不能跨任务继承。没有宿主身份时必须显式传稳定 agentId。

验证命令与行为检查见 README.md。生产业务流程应在本地 /test 通过后再使用。
