# 产品定位与使用体验

关联登记项：UX-01、UX-02、UX-03、UX-04、UX-05。

## 现状证据

入口分散在 `server/routes`、SSE、`ui/src/components` 和多种 Agent 工具；UI 已有会话、审批、计划、Trace 组件，但关键任务路径缺少端到端保证，部分组件曾出现死代码/假数据问题。

## 目标

用户能看懂 Agent 当前目标、正在做什么、为什么停下、需要什么审批，以及如何继续、取消或恢复。核心路径是“提出目标→计划→执行→审批/失败→结果→复盘”。

## 执行

1. 绘制真实信息架构和 3 条主路径：短问答、文件任务、长任务。
2. 统一任务状态、事件名称、错误文案和空/加载/失败状态。
3. 将目标、计划、当前步骤、审批、结果和恢复入口接入主会话视图。
4. 清理死组件、假数据和只读诊断脚本与正式 E2E 的职责混淆。
5. 增加键盘操作、取消、重试、复制结果和导出 Trace 的可达入口。

## 范围

`web-agent/ui/src`、`server/routes`、SSE 事件契约、`core/goal-plan`、`core/chat`。

## 依赖、风险与兼容

依赖 02 的任务状态契约和 03 的 trace/事件关联。主要风险是 UI 状态与服务端最终态竞争、旧会话事件字段缺失；新增字段一律可选并为旧记录提供适配，数据库变更走版本化 migration。按视图逐项启用 feature flag，出现状态错乱时可回到旧组件而不影响 API。

迁移：新增事件字段保持可选，旧会话通过适配器读取；数据库变更使用版本化 migration。

## 验证与指标

- `npm run ui:typecheck && npm run ui:build && npm run e2e`。
- 当前 Playwright 覆盖气泡菜单、引用回复、任务验收证据展示、审批批准/拒绝、子代理成功、并行任务失败、当前 run 的实时 Trace 步骤展示、断点恢复、插件错误诊断及真实 `/api/events` 浏览器断线恢复；新增场景主要使用 SSE/REST mock 验证 UI/API 契约，真实服务端集成仍待补齐。
- 三条主路径各有 Playwright 测试；任务状态无悬空状态；取消后 2 秒内 UI 收到终态。
- 三条主流程契约已由 `ui/e2e/main-flows.spec.ts` 锁定：短问答（delta → done → 气泡终态与发送按钮复位）、文件任务（tool_start/tool_result → 工具卡定格 → 最终答复一致）、长任务（error 帧 → 失败终态 + 失败前内容保留 + 原始错误入 title）、长任务取消（2 秒内停止终态与恢复入口）。验证：主流程专项 4/4、UI E2E 全量 28/28、双端 typecheck 与 `git diff --check` 通过。
- 全流程状态链契约已由 `ui/e2e/main-flows.spec.ts` 的 UX-02 场景锁定：目标条展示 plan mock 内容、`approval_required` SSE 帧唤起审批卡且批准请求携带一次性凭据、`done` 帧落为结果终态、`error` 帧落为阻塞终态且保留原始错误信息、失败横幅提供恢复入口且 `resume` 请求携带会话凭据。验证：主流程专项 5/5、UI E2E 全量 29/29、双端 typecheck 与 `git diff --check` 通过。
- 状态覆盖契约已由 `ui/e2e/main-flows.spec.ts` 的 UX-03 场景锁定：空数据（无历史会话自动建会话并展示品牌首屏引导配置模型，无 `.view-loading` 悬空）、断线（浏览器 offline 事件后聊天页头部状态字切换为「跟后端的连线断了一下」）、Provider 错误（`provider.error` 全局事件触发 Provider 列表刷新与 warning toast）、工具失败（`tool_result ok=false` 定格为「没成」错误卡且流式复位）、部分成功（`task_partial` 帧展示「部分完成」验收卡，默认展开并保留未满足条件与 Trace 引用）、无无限 loading（长任务失败与取消场景断言 `.stream-cursor` 清零且发送按钮复位）。验证：主流程专项 10/10、UI E2E 全量 34/34、双端 typecheck 与 `git diff --check` 通过。
- 交互通道契约已由 `ui/e2e/main-flows.spec.ts` 的 UX-04 场景锁定（键盘路径）：流式期间 Esc 停止并在 2 秒内出现停止终态与恢复入口、Enter 激活审批「可以，去做吧」并携带一次性凭据、Tab+Enter 激活断点横幅「接着说」发出 `resume:true` 请求、Tab+Enter 激活失败气泡「再试一次」重发原文并渲染成功答复；鼠标路径由既有场景覆盖（长任务取消 2 秒终态、工具审批批准/拒绝、断点恢复 resume、用户气泡重新发送、气泡菜单复制、Trace 导出 JSONL）。验证：主流程专项 14/14、UI E2E 全量 38/38、双端 typecheck 与 `git diff --check` 通过。
- 可访问性检查：键盘可完成审批、取消和恢复；错误状态可被读屏识别；核心布局在 1280x720 与 390x844 无遮挡。
- 可访问性契约（UX-05）已由 `ui/e2e/a11y.spec.ts` 锁定：axe-core 扫描会话首屏与审批挂起态无 critical/serious 违规；审批按钮可聚焦（`toBeFocused`）且点击后走 `/api/approvals/**` 可访问 API；失败终态声明 `role="status"` 并在 `title` 保留原始错误；390x844 视口下侧栏收窄、顶栏模式/模型菜单折叠为图标触发器、轨迹面板与输入提示让位，首屏/输入区/发送按钮无遮挡且横向零溢出。验证：a11y 专项 5/5、UI E2E 全量 43/43、双端 typecheck 与 `git diff --check` 通过。

验收：三条主流程均能完成成功、失败、取消和恢复路径，且服务端终态与界面终态一致。

## 风险/回滚/完成定义

先扩展事件契约再改 UI，保留旧字段兼容一个版本。若新视图破坏旧会话，按 feature flag 回退旧布局。完成条件是主路径可从浏览器独立完成并有失败恢复测试。
