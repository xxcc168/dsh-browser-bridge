# Agent 保持时间与桥接阻塞审计（2026-09-30，Asia/Shanghai）

## 本轮结果

源码统一为 1.6.2，继续使用协议 3 与 27 个工具，不添加任何第三方依赖。本轮检查 bridge HTTP/WebSocket、写队列、控制租约、MCP/DSH/CLI 适配器、Chrome worker/DOM guard、原生弹窗观测与 popup，保留此前所有未提交工作及已有诊断文件。

延长到 5 分钟的是页面控制保持时间：leaseMs 与 idleMs 均为 300000，续租间隔仍为 20000。无执行中动作时，最后一次有效页面活动后 300 秒回收；心跳不刷新空闲期限。未结束或结果未知的脚本仍隔离，不能因到期交给其他任务。动作总时限仍为默认 60 秒、上限 120 秒，避免等待五分钟才返回调用失败。

## 已复现并修复的问题

| 问题 | 原因与复现 | 修复与边界 |
| --- | --- | --- |
| 队列取消仍被原生弹窗挡住 | Promise tail 中的取消项必须等队首恢复，150ms 检查仍等待 FIFO | 新增 1558 字节的 WriteQueue；取消只移除未运行项，及时释放容量，不并发执行普通写操作 |
| 其他任务/已停止任务等待旧 revoke | ensure 在检查新 owner 前 await stopping；60ms 回归未获得应有拒绝 | 在等待 revoke 前拒绝 TAB_OCCUPIED/CONTROL_STOPPED，不越权接管 |
| 续租轮次重叠、慢任务拖延其他任务 | 20 秒定时器没有 single-flight；跨 owner 顺序等待 | 单轮 single-flight，跨 owner 并发上限 4，每组续租请求仍限时 5 秒 |
| 旧续租回复误删新控制缓存 | claim 对象可原地更新 sessionId，旧回复按可变 ID 判断 | 捕获不可变 sessionId 与对象代次，仅更新或删除仍匹配的 claim |
| 被暂停的提示条注入积压 | grant/renew/stop 各发一份 executeScript，回归累计 4 个悬挂注入 | 每个当前 document 至多一个注入加最新待更新状态；不等待页面 DOM 才确认控制 |
| 旧页面 guard 把有效续租判断为过期 | 相同 leaseId 的 guard 不刷新 expiresAt，旧值可为 0 | 只刷新仍为 active 的同代次 guard，绝不复活 stopping/paused guard |
| 激活成功却返回 inactive | 真实 Chrome 的 tabs 显示 active，而 activate 返回更新前快照 | 返回 tabs.update 确认的快照；先失败的回归和重载后真实 Chrome 均通过 |
| 超时/取消返回数字错误码 | Node DOMException 的只读 legacy code 为 23/20，原判断当作已有合法 code | 包装为稳定字符串并保留 cause；写请求仍保持 unknown，另查 requestId 确认排队取消 |

五分钟边界采用可推进时钟验证：4 分钟仍保持，299999ms 仍保持，300000ms 停止；单纯续租不能延长上限。适配器的旧三分钟清理阈值也改为统一策略，扩展打开新页使用 bridge 下发的 expiry。

## 验证证据

- 新增回归先运行：11 项中 10 项失败，捕获上述阻塞/保持时间问题；修复后对应回归全部通过。
- 发布前新增 4 项回归先失败：activate 1 项、DOMException 3 项；修复后全部通过。
- npm run check：23 个 JavaScript 文件语法通过，manifest/DSH/CLI 均为 27 个工具，版本和控制策略一致。
- npm test：79 项通过，0 失败，包含幂等、取消、用户停止、失联、旧代次和原生弹窗恢复边界。
- npm run test:native-browser：已安装 Edge 的全新临时配置、随机端口，通过真实 popup 启用、空白 alert、confirm 取消、prompt 回复、beforeunload 取消/确认及原生弹窗期间停止六组行为。使用原始权限 manifest，不接入共享 8765，不操作业务页面。
- npm run test:live-browser：当前 Chrome 的 27 个 MCP 工具实际调用、12 组流程全部通过；四分钟保持、300337ms 回收，结束 pending/queuedWrites/controlledTabs 均为 0。完整证据与边界见 [发布验收记录](2026-09-30-release-validation.md)。

“4 个悬挂注入降为 1 个”和“续租并发最多 4”是定向回归的调用计数证据，不是生产页面吞吐提升百分比。未进行长时间大规模标签页或连续大截图的压力测试，不据此保证没有潜在缺陷。

## 有意保留的安全等待

- 全局普通写操作仍为 FIFO。原生弹窗会暂停实际 executeScript；仅最新 dialogId、有效 owner/lease 的显式处理可走窄恢复通道，不能放开任意写并发。
- 用户停止、执行超时/断线后的 unknown 不会自动重试、重放 SQL 或清除 runningControls。Chrome 没有证明脚本结束时，保持 stopping 是安全隔离，不是假装成功或超时强行交接。
- 观测前已有弹窗仍可能只报告 known=false/blocked=true，不能伪造空白正文或无弹窗；CSP、受保护页面、其他调试器和系统对话框限制仍存在。
- 请求/扩展结果缓存继续保留原有数量与 TTL 上限；大图片累计内存并未用字节上限压力验收。本轮不通过提前删除幂等记录来伪造轻量结果。

## 运行版本与更新

更新前当前 bridge、Chrome 扩展、MCP adapter 均为 1.6.1，连接正常且无受控任务。源码更新不能视为运行生效；须等无 pending/queuedWrites/controlledTabs 后重启已核实的 bridge、重载正确路径的 Chrome 扩展，并重连唯一 MCP 入口。

当前 Codex 配置又出现两个指向同一项目的入口，已备份后去除重复 dsh_browser_bridge (Codex)，其他配置保持不变。不要保存未刷新设置页面中的旧重复配置。

已在 pending、queuedWrites、controlledTabs 均为 0 时，仅重启核实属于本项目的旧 bridge 进程。实时 status 确认 bridge 为 1.6.2，controlPolicy 为 300000/300000/20000。单独启动并关闭本轮自己的 MCP 客户端，确认新适配器为 1.6.2、工具数 27；共享 bridge 未因该客户端退出而关闭。

优化阶段 Chrome 已加载 1.6.2，但当时旧 MCP 进程仍为 1.6.1；用户随后重载/重启，发布前只读 status 已确认三端均为 1.6.2、versionsMatch=true。配置已在有效 CODEX_HOME 下备份，CLI 核验只保留一个启用的 dsh_browser_bridge 入口。磁盘版本仍不代替实际运行核验。

自动界面重载因 Computer Use 无法可靠确认浏览器 URL 而停止，没有绕过限制。用户手动重载扩展后，真实验收确认 activate 返回 active=true。发布前测试使用新启动的 MCP 进程加载本次超时错误码修复；已运行的其他 MCP 进程仍需重启才能加载新代码。不会自动开启原生弹窗识别开关或替用户接受权限请求。

优化实施阶段未提交或推送。随后用户明确授权：完整真实验收通过后再提交并推送 GitHub；发布验收结果另行记录。始终未修改远程数据库或安装软件/依赖，原有未跟踪的历史诊断文件不纳入发布。
