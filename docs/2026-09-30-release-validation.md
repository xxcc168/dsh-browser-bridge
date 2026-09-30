# 1.6.2 发布前真实验收（2026-09-30，Asia/Shanghai）

## 结论与范围

本轮按用户要求，先完整真实验收，再向既有 GitHub origin/main 普通提交推送，不强制推送、不新建分支。源码包、工具 manifest、bridge、Chrome 扩展和新启动 MCP 的版本均为 1.6.2；没有新增依赖或修改远程数据库。历史未跟踪诊断文件保持原样、不纳入发布。

## 实测结果

| 验收 | 结果 |
| --- | --- |
| `npm run check` | 23 个 JavaScript 文件语法通过；MCP/DSH/CLI 的 27 个注册及元数据、schema、控制策略一致 |
| `npm test` | 79 项通过，0 失败、0 跳过 |
| `npm run test:live-browser` | 当前已加载扩展的 Chrome 154.0.8037.58；12 组流程通过，全部 27 个 MCP 工具均实际调用 |
| 五分钟保持 | 真实墙钟等待，不修改时钟；四分钟时同 session 仍可写、idleExpiresAt 不被续租重置；300337ms 时回收完成 |
| 完整 live 耗时 | 301196ms；本地时间 17:41:19 至 17:46:20，包含等待及清理 |
| `npm run test:native-browser` | 已安装 Edge 154.0.4258.37、全新临时 profile、随机 bridge 端口；6 组真实行为通过 |
| 最终共享状态 | connected=true、versionsMatch=true，pending/queuedWrites/controlledTabs 均为 0；只关闭自身测试标签页 |
| 发布内容检查 | `git diff --check` 通过，凭据模式扫描无命中；.verify 报告、截图、依赖目录和本机配置不纳入 Git |

live 的 12 组流程覆盖：后台打开与激活返回状态；中文/特殊字符输入、按键、点击和读取；幂等 click/check、select/hover；open shadow、真实 iframe、分页预算、滚动与 PNG 截图；wait 错误及 batch 失败即停止；Chrome 原生空白 alert、confirm 取消、prompt 明确回复及 FIFO 恢复；占用冲突、续租、释放和重建；导航后的 document 替换；固定公开词搜索；实际四分钟保持及五分钟回收。所有页面动作只在自身测试页，公开搜索仅发送固定词 `dsh-browser-bridge GitHub`。

隔离 native 验收覆盖真实 popup 的受信任点击及原始权限清单，空白 alert、confirm、prompt，beforeunload 的真实用户激活、取消留页和确认离页，以及原生弹窗暂停时的立即停止、旧 owner 隔离和手工恢复后不重放。测试没有改写 debugger 权限，也没有接入共享 8765 或接管用户 Chrome 的调试连接。

## 本轮实测发现并修复

1. activate 已成功但返回更新前 active=false：先在当前 Chrome 复现；新增回归失败，修复为返回 tabs.update 确认的快照。用户手动重载后，真实 Chrome 返回 active=true。
2. Node 的超时/取消 DOMException 返回只读数字 code=23/20：原判断误认为合法业务错误码。新增 3 项失败回归后包装为 DEADLINE_EXCEEDED/CANCELLED，保留 cause 和 requestId。没有桥接确认的写请求仍为 unknown；本轮真实 modal-blocked FIFO 的排队请求另查 requestId 确认 state=cancelled，再解除 modal，并验证该排队点击从未执行。

优化代码尚未作为 1.6.2 发布到远程，因此本轮修复保留同一待发布版本。真实验收使用新启动 MCP 进程读取最新源码；其他已经启动的 MCP 进程需重启才能载入本轮客户端错误码修复。Chrome 的激活修复已通过用户重载和实际调用验证。

## 验证边界

完整验收通过不等于保证不存在潜在缺陷。未在生产 SQL 平台重放故障请求或变更数据，不能据此认定原业务空白错误的后端根因；未做长期大截图/多标签页内存压力测试。CSP、closed shadow、文件选择、其他系统对话框、调试器占用及未知运行脚本安全隔离边界保持不变。

本地原始报告和测试截图位于忽略的 `.verify/live-release-result.json`、`.verify/live-release-screenshot.png`，不上传到 GitHub。复现命令和前置条件见 [runbook](runbook.md)。
