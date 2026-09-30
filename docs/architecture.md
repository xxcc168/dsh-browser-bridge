# 架构与请求控制流

本页说明当前协议 3 的职责划分。安装与首个调用见 [README](../README.md)，参数和错误码见 [协议说明](bridge-api.md)。不增加运行时组件或依赖。

## 三个入口，一条执行链路

```text
MCP 宿主 ── examples/mcp-server.mjs ──┐
DSH 宿主 ── lib/index.js ────────────┼── lib/runtime.js
CLI      ── examples/cli.mjs ────────┘   校验参数、任务身份、会话缓存与续租
                                           │ HTTP（本机）
                                           ▼
                                    bridge/bridge.js
                                    owner/租约、deadline、请求记录
                                      ├─ 普通写操作 → 有界 FIFO
                                      ├─ 可并发读取 → 不进入写队列
                                      └─ dialoghandle → 窄恢复通道
                                           │ WebSocket（确认控制权后派发）
                                           ▼
                                    Chrome 扩展 background.js
                                      ├─ control.js：控制确认与用户停止
                                      ├─ DOM 动作：注入目标 frame/document
                                      └─ dialogs.js：手动启用后的窄 CDP 弹窗能力
                                           │
                                           ▼
                                      当前目标标签页
```

tools.manifest.json 是 27 个工具名称、参数、动作和调度的单一事实源。三个入口不各自维护另一套工具定义；共同运行逻辑放在 runtime，页面实际执行放在扩展。

MCP 与 DSH 原生入口可按配置自启 bridge；CLI 需要已运行的服务。多个适配器可共享一个 bridge，但每个任务仍须有独立身份。同一服务只维护一个有效扩展连接，不支持多个 Chrome 实例共享该连接身份。

## 租约与队列如何配合

| 阶段 | 执行位置 | 检查与目的 |
|---|---|---|
| 1. 调用 | 适配器 / runtime | 按 manifest 校验参数，解析稳定 agentId，生成 owner 凭据，按 owner+tabId 缓存会话 |
| 2. 入场 | bridge / control-manager | 检查 owner、session 和占用；其他 owner 在等待旧租约撤销或进入动作队列前被拒绝，不排队接管 |
| 3. 调度 | bridge / write-queue | 普通写操作进入有界 FIFO，读取可重叠；deadline 包含等待，取消的未执行项立即移除 |
| 4. 派发 | bridge + 扩展 | 再次确认当前 lease；扩展校验控制权和 document，旧状态快照不是执行许可 |
| 5. 执行与返回 | 扩展 → bridge → runtime | 返回动作结果、错误或 unknown；bridge 保存短期请求记录，适配器按预算投影输出 |

租约回答“谁可以操作这个标签页”，FIFO 回答“允许的写操作按什么顺序执行”。读取绕过写队列不等于绕过归属检查；eval 可能修改页面，因此总是按写操作处理。batch 在同一个写队列项内连续执行，失败停止但不回滚。

bridge 与扩展使用独立 control/controlAck 消息确认控制权。页面提示条只是状态展示，不是授权证据；每个 document 只保留一个未完成提示条注入和最新状态，注入结束不作为控制确认的前提，避免原生弹窗暂停页面脚本时阻塞授权链路。

## 原生弹窗为何有独立恢复通道

原生 alert/confirm/prompt/beforeunload 可以暂停页面脚本，导致 FIFO 队首未结束。把“处理弹窗”也排到队尾，会让恢复等待被它自己解除的阻塞。

因此只有显式 browser_handle_dialog / dialoghandle 可以绕过普通写队列。它仍必须验证当前 owner、有效 lease 和最新 dialogId，不能绕过其他任务占用或用户停止，也不是通用 CDP 接口。

弹窗观测由用户在扩展弹出页启用，关闭弹窗也不表示原动作或后端业务成功。观测前已有弹窗、调试连接不可用等情况下，known=false 不能解释为“没有弹窗”。

## 五分钟保持，不是五分钟动作超时

- tools.manifest.json.controlPolicy 统一规定租约和空闲保持均为 300 秒，常驻适配器每 20 秒续租。
- runtime 续租采用单轮 single-flight：上一轮未完成，不再开启一轮；跨 owner 最多 4 组并发，每组请求限时 5 秒，避免大量任务同时续租造成连接积压。
- 心跳检查连接，续租维护凭据；两者都不重置页面空闲活动时间。无执行中动作且 300 秒无页面活动后回收。
- 用户停止先在扩展本地生效，再通知 bridge 取消未执行请求。未结束脚本必须等待实际结束或 document 替换，不因期限已到就交给另一个任务。

不同时间限制的默认值与边界见 [协议说明](bridge-api.md#不同时间限制)。

## unknown 的恢复边界

已发送的写操作即使没有返回结果，也可能已点击或提交。调用者先按原 requestId 查询 browser_request_status，并结合页面后置条件核验；不得换 ID 或重新运行 batch 来自动重放。

只有 bridge 确认 state=cancelled，才能判断尚未执行的排队动作已取消。短期缓存查不到记录不代表未执行；重启服务也不会消除已发生的业务副作用。这些机制是合作式任务隔离，不是针对恶意本机进程的安全认证或持久“恰好一次”执行保证。
