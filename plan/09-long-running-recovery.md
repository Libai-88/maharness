# 长任务、并行与恢复

关联登记项：LR-01、LR-02、LR-03、LR-04、LR-05、LR-06。

## 现状证据

已有 goal/plan、checkpoint、handoff、结果存储、subagent 和 parallel；checkpoint 已携带逻辑 run id，工具执行前后有持久化副作用账本，跨 Store 重开可回放已完成结果并阻止 pending 结果自动重放。文件/HTTP/子进程真实副作用的端到端演练仍待补齐。

## 目标

checkpoint 保存任务契约、原始绝对截止时间、已完成工具的验收结果和累计成本；恢复时读取已保存契约与工具结果，继续执行原验收条件，并从任务预算扣除此前累计成本。旧断点没有成本字段时按零恢复。完成事件的费用只包含当前调用。

### 已验证范围（2026-10-30）

预热保活属于可取消的后台请求：每个会话拥有独立 `AbortController`，新 run 会取消并替换旧预热；配置切换 `cache.warmup=off` 会通过 `stopAllWarmups()` 立即取消全部预热请求并清理定时器。`server/tests/warmup-cancellation.spec.ts` 直接运行在途 Provider 流并调用配置 PATCH，断言 signal 已取消、流结束且响应成功。测试还确认手动启动 warmup 会清除尚未触发的调度 timer。专项回归 1/1、`npm run typecheck` 通过。

- [x] Store 关闭重开后保留任务验收、绝对截止时间和工具成功证据。
- [x] 多次关闭重开累计成本，工具获得扣除此前开销后的剩余任务预算。
- [x] 已耗尽任务预算在恢复后阻止 Provider 调用；完成事件不重复计入此前费用。
- [x] 已完成工具账本回放；结果未知的 pending 操作阻止自动重放。
- [x] eval golden 关闭并重开 SQLite Store，从 checkpoint 恢复已完成工具的验收证据，断言 handler 不重复执行。
- [x] PowerShell 工具收到取消信号后终止命令进程树；真实 Windows 回归确认后代进程在 5 秒内退出。
- [x] stdio MCP 工具取消后发送 `$/cancelRequest`，清理 pending 请求和超时句柄；本地 JSON-RPC 子进程回归确认取消通知送达，连接随后仍可完成新请求。
- [x] OpenAI 兼容模型 SSE 流取消后回收 reader 并关闭底层 HTTP 连接；本地 SSE 服务回归确认服务端观察到连接关闭。
- [x] MCP HTTP 工具取消后关闭底层请求连接；本地 HTTP MCP 服务回归确认请求 `close` 事件。
- [x] ripgrep 搜索取消后等待子进程退出并传播取消错误，不回退到同步 JS 搜索；真实 ripgrep 进程回归通过。
- [x] PowerShell 取消在终止进程树后等待子进程 `close` 再结算；`env_probe` 辅助执行也透传同一取消信号。
- [x] 已取消的 chat run 不再排队缓存预热/保活请求，避免取消后再启动模型调用。
- [x] 配置切换 `cache.warmup=off` 后中止在途 warmup Provider 流并清理预热计时器；`server/tests/warmup-cancellation.spec.ts` 1/1。
- [x] Provider 与幂等工具重试退避可被取消，清理退避计时器且不发起下一次调用。
- [x] 父任务停止（客户端断开）后 `run_parallel` 四个子任务与 `run_subagent` 单子代理的在途模型流全部中止并标记取消，5 秒内回收，取消后父循环不再发起新一轮调用；`server/tests/parallel-subagent-cancellation.spec.ts` 2/2。
- [x] 就绪端点 `/api/ready` 暴露运行时句柄计数（activeRuns、SSE 连接、页面连接、挂起审批、在途预热、活动子任务槽位），作为取消后句柄归零的对外可观测审计面。
- 验证入口：`web-agent/server/tests/effect-recovery.spec.ts`，7/7；`web-agent/core/powershell/tests/cancellation.spec.ts`，1/1；`web-agent/core/mcp/tests/security.spec.ts`，24/24；`web-agent/core/tools-fs/cancellation.spec.ts` 与 `web-agent/kernel/tests/fssearch.spec.ts`，22/22；`web-agent/core/chat/tests/anthropic.spec.ts`，20/20；`web-agent/evals/cases/task-recovery-checkpoint.json`，恢复后工具执行 1 次、任务 verified；`npm run typecheck` 与 `git diff --check` 通过。
- 待验收：真实进程强杀恢复的更广泛故障演练（网络断开、Provider 故障、并行任务）、失败/取消任务的会话账单结算、仅预算或期限目标的路由接入、在途调用的预算与期限控制，以及 LR-01 至 LR-06 的其余验收条件。
- [x] 真实文件写入、HTTP POST 和 Node 子进程副作用在 Store 关闭重开后均只执行一次；`server/tests/effect-recovery.spec.ts` 新增三类真实副作用回归，恢复后各自仍只保留一份文件内容/一条 HTTP 请求/一次子进程写入。
- [x] checkpoint 同时受 200 条消息和 512 KiB JSON 字节上限约束，裁剪后保留 `truncated/originalLength`；旧版直接消息数组格式可读取，超过默认 30 天保留期的断点会清理并阻止恢复，`server/tests/db.spec.ts` 13/13 通过。
- 兼容与回滚：成本是 checkpoint JSON 的可选字段，无数据库表迁移；旧执行器可忽略该字段，但不保证跨恢复预算约束。

长任务可暂停、取消、恢复、转交和重试；并行任务可部分成功；重复恢复不会重复外部副作用。

## 执行

1. 定义持久化状态机和 checkpoint schema，记录输入版本、工具幂等键、预算和未完成步骤。
2. 所有可重试工具声明幂等性；不可幂等工具恢复前必须重新审批。
3. 统一取消信号向 provider、工具、子进程和子代理传播并回收资源。
4. 并行任务增加限流、部分结果、失败聚合、取消剩余任务和预算原子扣减。
5. 增加进程崩溃、网络断开、插件重载、Provider 故障后的恢复演练。

## 验收

强杀进程后可从最近 checkpoint 继续；重复提交不重复写文件/发请求；并行 4 任务不会错误消耗 3 次配额；所有句柄和 timer 可回收。

## 依赖、迁移、风险与回滚

依赖 02 的验证/幂等契约、03 的关联 ID 和 10 的数据库迁移。checkpoint 带版本、校验和与插件/工具版本；旧任务只能在兼容执行器恢复，无法验证时转为人工恢复而不自动重放。不可逆副作用的风险通过“恢复前重验 + 重新审批”控制。目标：故障恢复成功率 >= 99%；checkpoint 丢失率 0；取消后 5 秒内回收所有子进程。回滚只停止创建新 checkpoint，已有版本仍可读取。

## 范围、测试与指标

范围包括任务状态机、checkpoint、结果存储、subagent、parallel、取消传播、幂等记录和清理任务。

测试覆盖强杀恢复、网络断开、Provider/插件故障、重复提交、部分成功、预算耗尽、取消和旧 checkpoint 读取；`kernel/tests/budget.spec.ts` 的 100 重叠申请压力回归验证并发峰值不超过 8 且释放后归零。

checkpoint 版本化补充（2026-10-31）：断点 payload 使用 schema v1，旧版直接消息数组兼容读取，未知版本 fail-closed 并清理；`server/tests/db.spec.ts` 专项 16/16，后端/前端类型检查通过。进程强杀后的真实恢复演练仍待完成。

进程强杀恢复补充（2026-10-31）：新增 `server/tests/process-recovery.spec.ts` 与隔离 fixture。测试启动真实 `tsx server/index.ts` 子进程，在临时 `AGENT_DATA_DIR` 中写入带任务契约、run id、工具验收结果和已完成副作用账本的 checkpoint，随后强制终止第一进程；第二进程使用同一数据目录启动真实服务，先通过 Store 确认已完成账本仍返回 `done`，再调用真实 `/api/sessions/:id/chat`（`resume:true`）并接收 SSE `done`，确认 checkpoint 在任务完成后清理且没有重复认领副作用。专项 `1/1`、`npm run typecheck`、`git diff --check` 通过。该证据覆盖服务边界的强杀、重启、继续执行和完成清理；网络断开、Provider 故障与并行任务的更广泛故障演练仍待补齐。

并行 Provider 负载补充（2026-10-31）：`server/tests/provider-diagnostics.spec.ts` 通过真实聊天 HTTP 入口执行四项并行子任务，峰值并发为 4，所有子任务完成后活动请求归零；父任务累计输入/输出 token 为 `50/25`，成本按子任务实际成本与汇总调用复算，六个 `llm_call` Trace 全部完成且四个子任务步骤挂接到并行工具父步骤。专项 `18/18`，全量 `npm test` `881/881`，类型检查和差异检查通过。该证据属于确定性 Provider 负载回归，线上 Provider 分布与故障恢复演练仍待补齐。

指标：恢复成功率 >= 99%，checkpoint 丢失率 0%，取消后 5 秒内回收子进程和句柄，重复外部副作用为 0。LR-01 至 LR-06 完成实现、故障演练、文档和回滚后关闭。
