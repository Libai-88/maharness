# 评测与质量体系

关联登记项：QA-01、QA-02、QA-03、QA-04、QA-05、QA-06、QA-07。

## 现状证据

`npm run eval` 有 27 个确定性场景；case manifest 支持沙箱前置文件、Provider 响应录音、审批工具桩、checkpoint 恢复、安全攻击类别及结果断言。`evals/case.schema.json` 定义 v1 契约，旧格式在 loader 中归一到 v1。UI E2E 仍未覆盖全部审批、恢复、长任务和 Trace 流程。

## 目标

建立分层评测：单元契约、集成流程、golden 回放、安全对抗、长任务恢复、UI E2E 和成本/延迟回归。

## 执行

1. 统一 case manifest：前置数据、工具桩、模型响应、验收断言、允许波动范围。
2. 增加任务完成率、正确工具率、无效调用率、恢复率、P95 延迟、成本和安全拒绝率。
3. 建立基线快照与版本 diff，阈值失败阻断合并。
4. 加入 PowerShell、SSRF、提示注入、恶意插件和越权 API 对抗集。
5. 将 Playwright 的审批、恢复、子代理、Trace、插件热载入纳入 CI。

## 范围与命令

`web-agent/evals`、`scripts/agent-eval.ts`、`ui/*.spec.ts`、CI 配置；执行 `npm test`、`npm run eval`、`npm run e2e`。

## 依赖、版本与风险

先依赖 02 定义成功语义，再覆盖 05/09 的安全与恢复行为。每个 case 写明 schema version、模型/工具桩和容差；旧 case 提供迁移器并可在两个版本中并跑。真实模型指标受采样波动影响，CI 核心门禁优先使用确定性桩，线上抽样评测仅告警。

## 完成定义

每个历史 P0/P1 修复和新增关键契约至少一个回归用例；CI 能输出可比较的 JSON 报告；任何核心指标回退超过阈值均失败并可定位到 case。目标：安全集 100% 通过；稳定 golden 通过率 >= 95%；核心 UI 流程覆盖 100%。评测自身失败时允许整组回退到上一个 manifest 版本，不绕过单条失败。

## 已验证范围（2026-10-30）

- v1 JSON Schema 与语义校验在 case 执行前运行；JSON 错误/结构错误附带 case 文件名。
- 旧 case 不写版本字段时兼容归一到 v1；录制模式生成显式 `schemaVersion: 1`。
- 27 个现有 case 全部通过 manifest 校验；回归覆盖缺失断言、空消息/响应、畸形工具参数、非法任务正则、越界缓存轮次和安全攻击断言。
- 任务验收 golden：verified 3、partial 3、failed 4；审批批准/拒绝各 3 条；Provider 故障录音 6 条，覆盖 500/429 重试及认证、参数、业务、取消停止；checkpoint 恢复 1 条，关闭并重开 SQLite Store 后恢复验收证据且工具不重复执行。测试固定最少覆盖门槛。
- 验证：本机最新 `npm test` 834/834，`npm run eval` 27/27、`npm run eval:ci` 27/27、`npm run test:security` 361/361、`npm run selftest` 91/91，后端/前端类型检查与生产构建均通过；安全攻击阻断为 4/4（100%）；GitHub Actions 主 CI 执行 `npm run eval:ci`。
- 门禁更新（2026-10-31）：新增任务契约正则验收回归后，本机 `npm test` 836/836；既有 `npm run eval` 27/27、`npm run eval:ci` 27/27、`npm run test:security` 361/361、`npm run selftest` 91/91 证据保持有效。
- QA-03 质量率门禁（2026-10-31）：评测比较器对正确工具率/完成率下降及无效工具率/工具失败率/重试率上升执行可配置百分点阈值；报告专项 6/6、`npm run eval:ci` 27/27、`npm run typecheck` 通过。稳定 CI runner 延迟校准与完整 CI 证据仍待完成。
- 确定性指标报告、27-case baseline 比较和 CI 阈值门禁已具备；仍待稳定 runner 延迟校准、真实插件/模型对抗评测、关键 UI E2E 及干净 checkout 的完整 CI 证据。

## 安全回归入口

`npm run test:security` 集中执行 PowerShell 审批绕过、敏感路径、core 与 server SSRF、MCP 子进程安全和 HTTP API 鉴权回归；本机本轮验证 351/351。该入口纳入 GitHub Actions 主 CI；测试使用 IP 字面量或本地 HTTP mock，不访问外网。QA-04 达到登记验收条件。完整回归仍由 `npm test` 执行。

## 指标报告与 baseline

`npm run eval -- --report evals/reports/current.json` 输出逐 case 与聚合 JSON；`npm run eval -- --baseline evals/baseline.json` 对照 baseline 执行门禁；`npm run eval -- --write-baseline evals/baseline.json` 仅在全量 case 通过后更新快照。`npm run eval:ci` 是可供 CI 调用的 baseline 检查入口。baseline 比较和更新均要求运行完整 case 集。

报告口径：完成率为 verified 任务数/任务终态总数；工具成功率为成功结果/工具结果；无效工具率为调用未注册工具的结果/工具结果；工具失败率包含执行失败和策略拒绝；重试率为 retry 事件/Provider 调用；成本按固定回放价 `$0.30/$1.20` 每百万输入/输出 token 计算，不代表线上账单；延迟统计每 case 启动至清理完成耗时的 P50/P95/max。

门禁要求 case 通过率 100%，baseline 中原先通过的 case 不得失败或消失；安全攻击阻断率不得低于 `eval-thresholds.json` 中的 100%；同平台、架构和 Node 主版本下 P95 延迟最多增长 100%；平均单次 Provider 成本最多增长 10%。不同运行环境跳过延迟对比；成本计价配置不一致时报告失败。当前 baseline 覆盖 27 个场景，路径为 `web-agent/evals/baseline.json`；本机 `npm run eval:ci` 27/27 通过。仍需在稳定 CI runner 复核延迟阈值并补齐 UI 门禁后再关闭 QA-03/QA-07。

安全攻击报告按类别统计阻断率。用户提示、普通工具输出和插件工具输出攻击使用固定 ReplayProvider 发出受保护工具调用，并验证审批拒绝及 handler 零调用；插件 capability escalation case 使用临时插件声明 `tool:safe_read`，尝试注册 `tool:delete_data`，验证 loader 拒绝、发出 `plugin.permission.denied` 且越权能力未进入 registry。插件输出工具由临时插件目录经真实 loader 加载。该数据验证审批和 capability 登记边界，不衡量模型注入识别能力，也不验证插件进程隔离或对 `ctx.kernel` 的完整权限约束。

## 测试与回滚

- 先执行 manifest/schema 校验，再执行确定性单测、集成回放、UI E2E 和安全攻击集。
- CI 使用固定桩和锁定依赖；确定性 golden 步骤同时生成并上传 `evals/reports/current.json`，抽样模型评测单独报告，不覆盖确定性门禁。
- 新 manifest 双版本并跑通过后才切换默认；发现误报可回退 manifest 版本，但不得跳过安全失败。
