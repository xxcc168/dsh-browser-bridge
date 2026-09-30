# 原生空白弹窗识别与权限修复（2026-09-30，1.6.1）

## 结论与范围

依据此前本地诊断记录，实现 bridge/扩展/适配器 1.6.1。原始问题是浏览器原生 JavaScript alert 的正文为空，不是普通 DOM 弹层。此次只修改桥接项目，不修改 SQL 平台、SCM/TMS、任何远程数据库或现有业务数据。

本文保留 1.6.1 阶段的历史核验与限制；当前 1.6.2 的发布前真实验收见 [发布验收记录](2026-09-30-release-validation.md)，不要将历史版本状态视作当前运行状态。

默认关闭原生观测，用户在 Chrome 加载/重新加载扩展时检查并确认 debugger 必需权限，再在扩展弹出页手动启用后才生效。权限获准不自动启用。不覆盖站点 alert，不自动确认弹窗，不重放 SQL，不强行移交未知执行中的控制。

## 1.6.0 授权报错的更正

用户截图中的 `Only permissions specified in the manifest may be requested` 已使用本机已安装 Edge、临时配置、原始 manifest 和真实 popup 点击稳定复现。原因是 1.6.0 将 debugger 声明为可选权限，而 [Chrome 官方权限 API](https://developer.chrome.com/docs/extensions/reference/api/permissions) 明确禁止 debugger 作为 optional 权限。此前测试临时改成必需权限，掩盖了这一真实授权路径缺陷。

1.6.1 将 debugger 放入必需权限并删除可选声明，不再调用 permissions.request。扩展 popup 的按钮改为“启用原生弹窗识别”，缺少运行清单声明或实际权限时禁用并提示重新加载。代码不接受 Chrome 权限提示，也不绕过用户确认；只有用户的真实点击才开启观测。

## 实施内容

- `extension/dialogs.js`：通过 Chrome debugger 的 Page 事件观测 alert/confirm/prompt/beforeunload，空字符串仍生成实际弹窗记录，含唯一 dialogId、type、blank、受限长度消息和观测状态。
- `browser_dialog`：不注入页面读取弹窗状态；已停止或其他任务占用时可用 `browser_session_status` 看阻塞摘要。非有效所有者不获消息/默认回复正文。
- `browser_handle_dialog`：只有明确 accept 和最新 dialogId 才处理；promptText 只用于 prompt。弹窗恢复是写队列的窄例外，否则会被自己需要解开的暂停动作堵住。owner/有效 lease、用户停止和旧 ID 防护仍有效。
- `extension/control.js`：页面提示条改为 best-effort，不再阻塞 grant/revoke/drain 的确认；扩展 badge/title、弹出页可报告阻塞。仍保留真正未结束的 runningControls，关闭弹窗不代替脚本结束。
- `NATIVE_DIALOG_OPEN`：对已观测弹窗拒绝 DOM 读取/操作，避免把旧结果当作新查询成功。点击成功或弹窗关闭仍不代表业务查询成功。
- `PAGE_SCRIPT_BLOCKED`：订阅前已有弹窗没有可靠事件补发保证；1000ms 的只读脚本探测未响应时，只标记 known=false/blocked=true，请用户核验，不凭超时伪造 alert 或空白内容。迟到探测可清除怀疑，但不清除业务执行记录。

用户停止后，agent 不能利用恢复工具绕过停止；用户可以在浏览器原生弹窗或扩展弹出页手工处理。之后仍须等待实际旧脚本结束。调试器占用、权限缺失或断开会保留明确 unknown/unavailable 原因，不抢夺调试连接。

## 验证与限制

先构造并运行失败回归：两项“页面注入被原生弹窗暂停时停止确认”测试失败；三项“空白 alert 状态、拒读旧 DOM、观测关闭不能假报正常”测试失败。修复后通过对应回归，并增加旧 ID、停止后恢复权限、调试器断开/占用、连续新弹窗、订阅前阻塞和写队列恢复测试。

检查命令：

```powershell
npm run check
npm test
npm run test:native-browser
```

最终验证结果：

| 项目 | 结果 |
| --- | --- |
| `npm run check` | 20 个 JavaScript 文件语法通过，manifest/DSH/CLI 均为 27 个工具，元数据和扩展版本一致 |
| `npm test` | 64 项通过，0 失败；新增 7 项 popup 权限/手动启用/旧清单防护回归 |
| `npm run test:native-browser` | 原始 manifest 下真实 popup 点击启用、空白 alert、confirm 取消、prompt 回复、原生弹窗期间停止五组真实行为通过 |
| `git diff --check` | 通过；仅有 popup.html 将来按 Git 配置转换 CRLF 的提示 |

真实原生行为已在本机已安装的 Microsoft Edge 154.0.4258.37（headless Chromium）中验证：空白 alert 识别、confirm 取消、prompt 显式回复、阻塞 DOM 读取、旧 ID 拒绝、恢复被暂停的真实 executeScript/FIFO、原生弹窗期间及时停止以及停止后只能由用户处理。不是模拟 DOM modal；验证的是原生事件与脚本暂停，不代表已验证用户可见弹窗的外观。

隔离测试使用随机 bridge 端口和临时全新浏览器配置，仅在自身 popup 和本地 /test 页面操作。1.6.1 不再改写权限声明，不再直接设置启用开关；加载原始 manifest 后通过真实 popup 的受信任点击启用，再验证原生弹窗。测试复制的默认地址在 worker 启动前替换为随机端口，未连入共享 8765；结束后仅关闭自身进程，并验证路径后尝试清理临时目录。本轮两个临时目录清理未成功，脚本已报告残留；未清理用户浏览器配置。测试不验证用户现有 Chrome 的权限确认提示。

另尝试 Google Chrome 154.0.8037.58 的命令行隔离验收，未发现所加载扩展的 worker，超时退出并清理。不能把 Edge 的通过等同于用户当前 Chrome 扩展已重载生效；本次未证明此 Chrome 构建为何未加载命令行扩展。

本次未对 beforeunload、其他系统对话框或实际 SQL 平台错误请求做真实验收。未捕获原 SQL 请求响应，因此仍不能判断产生空白 errorThrown 的后端/网络原因。

## 如何在当前 Chrome 生效

1. 等其他浏览器任务安全结束后，重启使用本仓库的共享 bridge，使服务实际加载 1.6.1；不要强杀未结束的业务操作。
2. 在 Chrome 扩展管理页重载本仓库 `extension` 目录，由用户检查并确认 Chrome 如有出现的权限变更提示，确认版本 1.6.1。
3. 打开扩展弹出页，点击“启用原生弹窗识别”。只授予权限或重载不自动启用观测。
4. 重连/重启 MCP 宿主，使其重新加载 manifest 的 27 个工具。检查 status 的 bridge、extension、adapter 版本及 native-dialog-v1 能力；在本地 /test 验收，再观察实际 SQL 场景。

截至授权报错修复后的只读核验，共享 bridge、扩展和当前 MCP 适配器仍为 1.6.0、connected=true，pending/queuedWrites/controlledTabs 均为 0；磁盘源码已为 1.6.1。上轮已统一 Codex 配置并从 1.5.0 安全重启至 1.6.0。本轮向 1.6.1 更新服务的命令被环境策略拒绝，未执行；未代用户重载 Chrome 扩展或确认新增权限，也未关闭业务弹窗或执行 SQL。用户现有 Chrome 仍须手动重载和验证，不能把隔离 Edge 验证等同于当前 Chrome 已生效。

原诊断文档 `2026-09-23-bridge-review-and-dialog-diagnosis.md` 为已有未跟踪文件，本轮保持原内容不变。未提交、未推送、未安装第三方依赖。
