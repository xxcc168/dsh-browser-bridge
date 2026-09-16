# Agent 工作契约

维护范围是本仓库，bridge、扩展和适配器均在仓库内。不要引用其他业务项目。用户限制优先：不得擅自提交/推送、修改远程数据库或安装依赖；前端跳过 ts:check。

## 架构与事实源

- tools.manifest.json：23 个工具的名称、JSON Schema、调度与动作映射。
- lib/runtime.js：框架无关传输、进程生命周期、输出和搜索。
- lib/index.js：DSH 注册；examples/mcp-server.mjs：MCP 注册；examples/cli.mjs：CLI。
- bridge/bridge.js、bridge/control-manager.cjs：HTTP、WebSocket、FIFO、请求缓存、deadline、租约和 batch；bridge/package.json 仅定义 CommonJS 边界，依赖统一在根 package.json。
- extension/background.js：Chrome 连接及实际 DOM 动作。

## 不变量

- 三个入口从同一 manifest 生成。数字/数组约束由 runtime.validate 在所有客户端执行前验证。
- eval 是写操作，必须串行，不自动重试；screenshot 也影响焦点。
- wait 不滚动，超时必须失败；输入/点击不得伪装成功。单次 click 不可触发两个 click。
- structured DOM 动作用扩展注入，任意表达式 eval 仍受页面 CSP 约束。
- 明确 tabId/frameId 与稳定任务身份。占用按 owner+tabId 维护，不得按共享进程或 tabId 自动继承其他任务的 session。
- 页面首次使用强制独占；不同 owner 在入队前立即拒绝，不排队接管。租约 60 秒、空闲期限 120 秒，心跳不重置页面活动时间。
- 用户停止必须先在扩展本地撤销，取消队列且阻止旧 owner 自动重占。未结束脚本须等待结束/document 替换，不能仅到期就交接。
- 页面提示放在 closed shadow 并从抓取中排除。控制按钮只接受真实用户事件；提供扩展弹窗替代入口。
- deadline 包含排队；取消的未发送命令不可下发。已发送结果不明标记 unknown，不自动重放写操作。
- 输出明确截断/续读，图片不作为 Base64 文本返回。DSH/CLI 保存文件，MCP image。
- 只监听 localhost。不得用真实业务页面提交表单、删除或变更数据来做回归。

## 验证

```powershell
npm run check
npm test
```

自检检查实际注册和 schema，行为测试启动隔离随机端口的桥接与模拟扩展。真实 Chrome 验收需要重载扩展及重启服务，在 /test 页面验证 type/click/extract/wait，截图只针对测试页。若无法完成，明确报告未验证部分，不把磁盘修改等同运行中生效。

## 发布与恢复

修改前检查 Git 状态，保留既有改动。包内容必须含 bridge、extension（含图标）、lib、examples 和 tools.manifest.json；不得纳入 node_modules、截图、令牌或业务数据。依赖声明和根 lockfile 同步；不再维护外部核心目录或旧插件副本。进程重连仅操作已核实属于该桥接的进程。未经用户授权不安装、不提交、不推送。

默认从同仓库 bridge 解析服务路径，不得写死个人目录。配置/重载见 docs/runbook.md，DSH 接入见 docs/dsh-plugin.md，API 见 docs/bridge-api.md。

缓存结果仅短期内存保存，不承诺业务恰好一次或重启后持久恢复。batch 失败停止但不回滚。高级 CDP、上传下载、closed shadow 和系统对话框不属于当前实现。
