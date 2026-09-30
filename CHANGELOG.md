# 版本记录

以下按仓库已提交的运行时版本记录，从 1.5.0 开始整理；更早内容参阅 Git 历史。文档勘误不提升包或扩展版本，当前运行时仍为 1.6.2。当前用法见 [README](README.md)，升级与排查见 [runbook](docs/runbook.md)。

## 未发布

### 文档

- 修正占用错误码 TAB_OCCUPIED、DSH 27 个工具与四个 MCP readOnlyHint 工具的说明。
- 补充 wait 默认 10000ms、分阶段时间限制、高级环境变量与错误处置表。
- 增加架构说明、README 阅读顺序及可执行的本地 CLI 端到端示例；配置示例使用待替换路径，不以个人目录作为默认要求。
- 将历史修订解释集中到本页；保留日期命名的实施与验收记录，不更改运行逻辑、依赖或协议。

## 1.6.2 — 2026-09-30

对应提交 c8812c7；协议仍为 3，bridge、扩展及新启动适配器的版本统一为 1.6.2。

### 功能与修复

- 增加 browser_dialog、browser_handle_dialog，工具总数为 27；支持原生空白 alert、confirm、prompt、beforeunload 的观测与显式处理，不提供通用 CDP。
- debugger 在扩展清单中声明为必需权限；观测仍需用户手动启用，不自动接受权限或确认弹窗。
- 租约与空闲保持统一为 300 秒，常驻适配器每 20 秒续租；心跳与续租不延长空闲上限。
- 写队列上限 100；未发送的取消项即时移除。占用冲突和被用户停止的任务在等待旧控制撤销前拒绝，避免申请链路被旧任务阻塞。
- 续租单轮 single-flight、跨 owner 并发上限 4、每组限时 5 秒；旧代次回复不覆盖新会话缓存。
- 页面提示条注入合并，不阻塞控制确认；同租约活动刷新保护期限，但不复活 stopping 状态。
- browser_activate 返回 Chrome 确认后的活动状态，修复成功激活却返回旧 inactive 快照的问题。
- 将 Node DOMException 数字旧式 code 包装为 DEADLINE_EXCEEDED / CANCELLED 等字符串，保留 cause 和 requestId；无桥接确认的写结果仍为 unknown，不自动重放。

### 升级注意

必须分别重启 bridge 与适配器进程、重载正确路径的 Chrome 扩展，并核验实际版本。扩展重载不等于适配器进程更新，权限获准不等于弹窗观测启用。

### 原生弹窗开发修订

本轮本地开发曾使用 1.6.0 / 1.6.1 标识，均合入上述 1.6.2 提交，不在本记录中视为两次独立已发布版本：

- 1.6.0 的 optional debugger / permissions.request 路径触发 `Only permissions specified in the manifest may be requested`。
- 1.6.1 改为清单必需权限，删除无效可选申请；权限缺失时提示重载，观测仍默认关闭。

### 历史实施与验收记录

- [原生弹窗实施与权限修复](docs/2026-09-30-native-dialog-fix.md)。
- [保持时间与阻塞审计](docs/2026-09-30-agent-retention-and-audit.md)。
- [发布前真实验收](docs/2026-09-30-release-validation.md)：记录当轮 Chrome / Edge、27 个工具、真实五分钟保持与回收结果；历史通过不代替当前运行验证，也不证明业务平台后端故障根因。

## 1.5.0 — 2026-09-20

对应提交 70a9db4；工具总数为 25，协议 3。

- 增加原子 session status / ensure：经扩展确认连接、document/control generation、归属与读写能力，查询不续租。
- 允许在当前任务身份下确认续租或重新获取，但不接管其他任务、不绕过用户停止、不重放 unknown 动作。
- bridge 与扩展派发前再次确认控制权，不以先前快照或仅存 sessionId 作为执行许可。
